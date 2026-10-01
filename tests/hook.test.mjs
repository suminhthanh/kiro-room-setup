import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import * as fsSync from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BLOCK_EXIT_CODE,
  HOOK_EVENTS,
  decideHook,
  handleHook,
  policyDigest,
  readTurnRecord,
  stateDirFor,
  writeTurnRecord,
} from '../extensions/kiro-policy.mts';
import { parseBrief, BRIEF_BEGIN, BRIEF_END } from '../extensions/policy-core.mts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(REPO, 'extensions', 'kiro-room-hook.mjs');

const HOME = '/Users/probe';
const WS = '/Users/probe/repos/demo';
const SESSION = '019cbc47-aeb9-44ef-85dd-cfa7a5aa37b1';

/**
 * Payload shapes below are copied verbatim from a live kiro-cli 2.26.0 capture,
 * including the `__tool_use_purpose` key the runtime adds and the fact that
 * `preToolUse` carries no prompt. See docs/inventory-20260930.md.
 */
const PROMPT_EVENT = (prompt) => ({
  hook_event_name: 'userPromptSubmit',
  cwd: WS,
  session_id: SESSION,
  prompt,
});

const SHELL_EVENT = (command) => ({
  hook_event_name: 'preToolUse',
  cwd: WS,
  session_id: SESSION,
  tool_name: 'shell',
  tool_input: { command, __tool_use_purpose: 'probe' },
});

const WRITE_EVENT = (path) => ({
  hook_event_name: 'preToolUse',
  cwd: WS,
  session_id: SESSION,
  tool_name: 'write',
  tool_input: { command: 'create', path, content: 'x', __tool_use_purpose: 'probe' },
});

const brief = (authority = 'read, write, git', workspace = WS) =>
  [
    BRIEF_BEGIN,
    'ROLE: peer',
    'TASK_ID: t-001',
    `WORKSPACE: ${workspace}`,
    'BRANCH: agent/t-001-demo',
    `AUTHORITY: ${authority}`,
    BRIEF_END,
  ].join('\n');

/** In-memory turn store so the pure handler can be driven without a filesystem. */
function memoryIo() {
  const store = new Map();
  return {
    store,
    read: (id) => store.get(id) ?? null,
    write: (record) => store.set(record.sessionId, record),
  };
}

describe('hook wiring', () => {
  test('all five kiro-cli hook events are handled', () => {
    assert.deepEqual([...HOOK_EVENTS], [
      'agentSpawn',
      'userPromptSubmit',
      'preToolUse',
      'postToolUse',
      'stop',
    ]);
  });

  test('a session with no KIRO_ROOM_ROLE is a no-op', () => {
    const io = memoryIo();
    const outcome = decideHook(SHELL_EVENT('rm -rf /'), { home: HOME }, io);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.noop, true);
    assert.equal(io.store.size, 0, 'a non-Room session must not create state');
  });

  test('an unrecognised role blocks rather than failing open', () => {
    const outcome = decideHook(SHELL_EVENT('npm test'), { role: 'admin', home: HOME }, memoryIo());
    assert.equal(outcome.exitCode, BLOCK_EXIT_CODE);
    assert.match(outcome.message, /not one of/);
  });

  test('agentSpawn, postToolUse and stop never block', () => {
    const io = memoryIo();
    for (const event of ['agentSpawn', 'postToolUse', 'stop']) {
      const outcome = decideHook(
        { hook_event_name: event, cwd: WS, session_id: SESSION },
        { role: 'peer', home: HOME },
        io,
      );
      assert.equal(outcome.exitCode, 0, event);
    }
  });

  test('an unknown future event does not block work', () => {
    const outcome = decideHook(
      { hook_event_name: 'somethingNew', cwd: WS, session_id: SESSION },
      { role: 'peer', home: HOME },
      memoryIo(),
    );
    assert.equal(outcome.exitCode, 0);
  });
});

describe('turn state — the bridge between prompt and tool', () => {
  test('userPromptSubmit records the brief for the session', () => {
    const io = memoryIo();
    const env = { role: 'peer', home: HOME };
    decideHook(PROMPT_EVENT(brief()), env, io);
    const record = io.store.get(SESSION);
    assert.equal(record.role, 'peer');
    assert.equal(record.brief.kind, 'valid');
    assert.deepEqual(record.brief.brief.authority, ['read', 'write', 'git']);
    assert.equal(record.policyDigest, policyDigest());
  });

  test('a tool call with no recorded turn is read-only', () => {
    const io = memoryIo();
    const outcome = decideHook(WRITE_EVENT(`${WS}/src/a.ts`), { role: 'peer', home: HOME }, io);
    assert.equal(outcome.exitCode, BLOCK_EXIT_CODE);
    assert.equal(outcome.decision.code, 'brief.write_not_granted');
  });

  test('a brief in the prompt unlocks the write in the same session', () => {
    const io = memoryIo();
    const env = { role: 'peer', home: HOME };
    decideHook(PROMPT_EVENT(brief()), env, io);
    const outcome = decideHook(WRITE_EVENT(`${WS}/src/a.ts`), env, io);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.decision.effect, 'allow');
  });

  test('a plain message after a brief strips write authority for that turn', () => {
    const io = memoryIo();
    const env = { role: 'peer', home: HOME };

    decideHook(PROMPT_EVENT(brief()), env, io);
    assert.equal(decideHook(WRITE_EVENT(`${WS}/src/a.ts`), env, io).exitCode, 0);

    // This is the operating consequence of brief-gating: talking to a working
    // Peer directly removes its authority, because the message carries no brief.
    decideHook(PROMPT_EVENT('actually also fix the header while you are there'), env, io);
    const after = decideHook(WRITE_EVENT(`${WS}/src/a.ts`), env, io);
    assert.equal(after.exitCode, BLOCK_EXIT_CODE);
    assert.equal(after.decision.code, 'brief.write_not_granted');
    assert.match(after.decision.reason, /Ask the Lead to re-issue a brief/);
  });

  test('a malformed brief is recorded and denies everything for the turn', () => {
    const io = memoryIo();
    const env = { role: 'peer', home: HOME };
    const outcome = decideHook(
      PROMPT_EVENT(`${BRIEF_BEGIN}\nROLE: peer\nAUTHORITY: write\n${BRIEF_END}`),
      env,
      io,
    );
    assert.equal(outcome.exitCode, 0, 'a bad brief must not block the prompt itself');
    assert.match(outcome.message, /malformed/);

    for (const event of [WRITE_EVENT(`${WS}/src/a.ts`), SHELL_EVENT('ls')]) {
      const denied = decideHook(event, env, io);
      assert.equal(denied.exitCode, BLOCK_EXIT_CODE);
      assert.equal(denied.decision.code, 'brief.invalid');
    }
  });

  test('two sessions do not share authority', () => {
    const io = memoryIo();
    const env = { role: 'peer', home: HOME };
    decideHook(PROMPT_EVENT(brief()), env, io);
    const other = { ...WRITE_EVENT(`${WS}/src/a.ts`), session_id: 'another-session' };
    const outcome = decideHook(other, env, io);
    assert.equal(outcome.exitCode, BLOCK_EXIT_CODE);
    assert.equal(outcome.decision.code, 'brief.write_not_granted');
  });
});

describe('turn state on disk', () => {
  let sandbox;
  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'kiro-room-state-test.'));
  });
  after(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  });

  test('records round-trip through the filesystem', () => {
    const env = { role: 'peer', home: sandbox, stateDir: join(sandbox, 'state') };
    writeTurnRecord(env, {
      sessionId: SESSION,
      role: 'peer',
      brief: parseBrief(brief()),
      updatedAt: new Date().toISOString(),
      policyDigest: policyDigest(),
    });
    const record = readTurnRecord(env, SESSION);
    assert.equal(record.brief.kind, 'valid');
    assert.ok(existsSync(join(sandbox, 'state', `${SESSION}.json`)));
  });

  test('a session id containing path separators cannot escape the state dir', () => {
    const env = { role: 'peer', home: sandbox, stateDir: join(sandbox, 'state') };
    writeTurnRecord(env, {
      sessionId: '../../escape',
      role: 'peer',
      brief: { kind: 'none' },
      updatedAt: new Date().toISOString(),
      policyDigest: policyDigest(),
    });
    assert.ok(!existsSync(join(sandbox, 'escape.json')), 'traversal must be neutralised');
    assert.ok(existsSync(join(sandbox, 'state', '.._.._escape.json')));
  });

  test('a corrupt record degrades to read-only rather than throwing', () => {
    const env = { role: 'peer', home: sandbox, stateDir: join(sandbox, 'state') };
    const { writeFileSync } = fsSync;
    writeFileSync(join(sandbox, 'state', 'corrupt.json'), 'not json');
    assert.equal(readTurnRecord(env, 'corrupt'), null);
    const outcome = handleHook({ ...WRITE_EVENT(`${sandbox}/a.ts`), session_id: 'corrupt' }, env);
    assert.equal(outcome.exitCode, BLOCK_EXIT_CODE);
    assert.equal(outcome.decision.code, 'brief.write_not_granted');
  });

  test('stateDirFor prefers an explicit dir, then KIRO_HOME, then HOME', () => {
    assert.equal(stateDirFor({ stateDir: '/x' }), '/x');
    assert.equal(stateDirFor({ kiroHome: '/rt/peer' }), '/rt/peer/kiro-room-state');
    assert.equal(stateDirFor({ home: '/h' }), '/h/.kiro-runtime/kiro-room-state');
  });
});

describe('hook process contract', () => {
  let sandbox;
  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'kiro-room-hook-proc.'));
  });
  after(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  });

  function runHook(payload, env = {}) {
    try {
      const stdout = execFileSync(process.execPath, [HOOK], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: { ...process.env, HOME: sandbox, ...env },
      });
      return { code: 0, stdout };
    } catch (error) {
      return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
  }

  const roomEnv = {
    KIRO_ROOM_ROLE: 'peer',
    KIRO_ROOM_STATE_DIR: '',
  };

  test('exits 0 immediately when KIRO_ROOM_ROLE is unset', () => {
    const result = runHook(SHELL_EVENT('git push --force'), { KIRO_ROOM_ROLE: '' });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), '');
  });

  test('blocks a force-push with exit 2 and names the rule', () => {
    const env = { ...roomEnv, KIRO_ROOM_STATE_DIR: join(sandbox, 'st1') };
    runHook(PROMPT_EVENT(brief()), env);
    const result = runHook(SHELL_EVENT('git push --force origin HEAD'), env);
    assert.equal(result.code, BLOCK_EXIT_CODE);
    assert.match(result.stdout, /kiro-room policy \[shell\.force_push\]/);
  });

  test('blocks a write into the operator Kiro home', () => {
    const env = { ...roomEnv, KIRO_ROOM_STATE_DIR: join(sandbox, 'st2') };
    runHook(PROMPT_EVENT(brief('read, write, git', sandbox)), env);
    const result = runHook(
      { ...WRITE_EVENT(`${sandbox}/.kiro/agents/evil.json`), cwd: sandbox },
      env,
    );
    assert.equal(result.code, BLOCK_EXIT_CODE);
    assert.match(result.stdout, /kiro-room policy \[boundary\.protected_path\]/);
  });

  test('permits an in-workspace write under a valid brief', () => {
    const env = { ...roomEnv, KIRO_ROOM_STATE_DIR: join(sandbox, 'st3') };
    runHook(PROMPT_EVENT(brief('read, write', sandbox)), env);
    const result = runHook({ ...WRITE_EVENT(`${sandbox}/src/a.ts`), cwd: sandbox }, env);
    assert.equal(result.code, 0);
  });

  test('blocks delegation for every role', () => {
    for (const role of ['supervisor', 'lead', 'peer']) {
      const env = { KIRO_ROOM_ROLE: role, KIRO_ROOM_STATE_DIR: join(sandbox, `st-del-${role}`) };
      const result = runHook(
        { hook_event_name: 'preToolUse', cwd: sandbox, session_id: 's', tool_name: 'delegate', tool_input: {} },
        env,
      );
      assert.equal(result.code, BLOCK_EXIT_CODE, role);
      assert.match(result.stdout, /delegation\.denied/);
    }
  });

  test('unparseable stdin blocks rather than passing the tool through', () => {
    const env = { ...roomEnv, KIRO_ROOM_STATE_DIR: join(sandbox, 'st4') };
    let code = 0;
    try {
      execFileSync(process.execPath, [HOOK], {
        input: 'this is not json',
        encoding: 'utf8',
        env: { ...process.env, HOME: sandbox, ...env },
      });
    } catch (error) {
      code = error.status;
    }
    assert.equal(code, BLOCK_EXIT_CODE);
  });

  test('the state file is created with owner-only permissions', () => {
    const stateDir = join(sandbox, 'st5');
    const env = { ...roomEnv, KIRO_ROOM_STATE_DIR: stateDir };
    runHook(PROMPT_EVENT(brief()), env);
    const { statSync } = fsSync;
    const mode = statSync(join(stateDir, `${SESSION}.json`)).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });
});

describe('policy digest', () => {
  test('is a stable short hex digest', () => {
    const digest = policyDigest();
    assert.match(digest, /^[0-9a-f]{16}$/);
    assert.equal(digest, policyDigest());
  });
});
