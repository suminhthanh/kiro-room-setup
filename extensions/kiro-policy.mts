/**
 * Adapts kiro-cli hook payloads onto `policy-core` and owns the per-turn state
 * that makes the brief gate possible.
 *
 * Why state is needed at all: a measured `preToolUse` payload carries
 * `{hook_event_name, cwd, session_id, tool_name, tool_input}` and **no prompt**.
 * The brief lives in the user message, which is only visible to
 * `userPromptSubmit`. So `userPromptSubmit` parses the brief and records the
 * turn's authority, and `preToolUse` reads it back by `session_id`.
 *
 * The overwrite-per-turn behaviour is the brief gate: every
 * `userPromptSubmit` replaces the record, so a plain chat message with no
 * marker block writes `{kind:'none'}` and the turn becomes read-only. That is
 * intended, and it is why the operating rule is to talk to the Lead rather than
 * to a working Peer.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  evaluate,
  parseBrief,
  policyFingerprintSource,
  isRole,
  type BriefParse,
  type Decision,
  type Role,
} from './policy-core.mts';

export const HOOK_EVENTS = [
  'agentSpawn',
  'userPromptSubmit',
  'preToolUse',
  'postToolUse',
  'stop',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Exit code that makes kiro-cli treat a `preToolUse` hook as blocking. */
export const BLOCK_EXIT_CODE = 2;

export interface KiroHookPayload {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  prompt?: string;
  assistant_response?: string;
}

export interface PolicyEnv {
  role?: string;
  kiroHome?: string;
  home?: string;
  leadWrite?: boolean;
  stateDir?: string;
}

export function policyDigest(): string {
  return createHash('sha256').update(policyFingerprintSource()).digest('hex').slice(0, 16);
}

/* ------------------------------------------------------------------ *
 * Turn state
 * ------------------------------------------------------------------ */

export interface TurnRecord {
  sessionId: string;
  role: Role;
  /** Serialised `BriefParse` for the turn. */
  brief: BriefParse;
  updatedAt: string;
  policyDigest: string;
}

export function stateDirFor(env: PolicyEnv): string {
  if (env.stateDir) return env.stateDir;
  const base = env.kiroHome ?? join(env.home ?? '', '.kiro-runtime');
  return join(base, 'kiro-room-state');
}

function statePathFor(env: PolicyEnv, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown-session';
  return join(stateDirFor(env), `${safe}.json`);
}

export function writeTurnRecord(env: PolicyEnv, record: TurnRecord): void {
  const path = statePathFor(env, record.sessionId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Reads the turn record. A missing or unreadable record resolves to
 * `{kind:'none'}` rather than throwing, so a state problem degrades to
 * read-only instead of failing open.
 */
export function readTurnRecord(env: PolicyEnv, sessionId: string): TurnRecord | null {
  const path = statePathFor(env, sessionId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as TurnRecord;
    if (!parsed || !isRole(parsed.role) || !parsed.brief) return null;
    return parsed;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Hook handling
 * ------------------------------------------------------------------ */

export interface HookOutcome {
  /** Process exit code. `BLOCK_EXIT_CODE` blocks the tool. */
  exitCode: number;
  /** Written to stdout; kiro-cli surfaces it to the model on a block. */
  message: string;
  /** Present for preToolUse. */
  decision?: Decision;
  /** True when the hook deliberately did nothing (not a Kiro Room seat). */
  noop?: boolean;
}

const ok: HookOutcome = { exitCode: 0, message: '' };

/**
 * Pure handler. `handleHook` does the I/O; this does the deciding, so tests can
 * drive every branch without a process.
 */
export function decideHook(
  payload: KiroHookPayload,
  env: PolicyEnv,
  io: {
    read: (sessionId: string) => TurnRecord | null;
    write: (record: TurnRecord) => void;
  },
): HookOutcome {
  const role = env.role;

  // Not a Kiro Room seat: a plain `kiro-cli` session must be untouched even if
  // this hook is somehow wired globally.
  if (!role) return { ...ok, noop: true };
  if (!isRole(role)) {
    return {
      exitCode: BLOCK_EXIT_CODE,
      message:
        `kiro-room: KIRO_ROOM_ROLE=${JSON.stringify(role)} is not one of ` +
        'supervisor|lead|peer. Refusing to run without a known role.',
      noop: false,
    };
  }

  const event = payload.hook_event_name;
  const sessionId = payload.session_id ?? 'unknown-session';
  const cwd = payload.cwd ?? process.cwd();
  const home = env.home ?? '';

  switch (event) {
    case 'userPromptSubmit': {
      const brief = parseBrief(payload.prompt ?? '');
      io.write({
        sessionId,
        role,
        brief,
        updatedAt: new Date().toISOString(),
        policyDigest: policyDigest(),
      });
      if (brief.kind === 'invalid') {
        return {
          exitCode: 0,
          message:
            'kiro-room: the brief marker block in this message is malformed, so this turn ' +
            `grants no authority (${brief.errors.join('; ')}).`,
        };
      }
      return ok;
    }

    case 'preToolUse': {
      const record = io.read(sessionId);
      const brief: BriefParse = record?.brief ?? { kind: 'none' };
      const decision = evaluate({
        role,
        toolName: payload.tool_name ?? '',
        toolInput: payload.tool_input ?? {},
        cwd,
        home,
        brief,
        leadWriteEnabled: env.leadWrite === true,
      });
      if (decision.effect === 'deny') {
        return {
          exitCode: BLOCK_EXIT_CODE,
          message: `kiro-room policy [${decision.code}]: ${decision.reason}`,
          decision,
        };
      }
      return { exitCode: 0, message: '', decision };
    }

    case 'agentSpawn':
    case 'postToolUse':
    case 'stop':
      return ok;

    default:
      // Unknown event: do nothing rather than block work on a schema change.
      return ok;
  }
}

export function envFromProcess(source: NodeJS.ProcessEnv = process.env): PolicyEnv {
  return {
    role: source.KIRO_ROOM_ROLE,
    kiroHome: source.KIRO_HOME,
    home: source.HOME ?? '',
    leadWrite: source.KIRO_ROOM_LEAD_WRITE === '1',
    stateDir: source.KIRO_ROOM_STATE_DIR,
  };
}

export function handleHook(payload: KiroHookPayload, env: PolicyEnv): HookOutcome {
  return decideHook(payload, env, {
    read: (sessionId) => readTurnRecord(env, sessionId),
    write: (record) => writeTurnRecord(env, record),
  });
}
