/**
 * Generates one isolated Kiro runtime per role.
 *
 * Contract with the operator's own installation: `~/.kiro` is read, never
 * written. Everything generated lands under the role's `KIRO_HOME`, and the
 * shared parts (skills, steering, powers, MCP servers) are reached by symlink so
 * the operator keeps a single source of truth for them.
 *
 * The generator is idempotent by construction: it derives the whole tree from
 * (base settings + overlay + prompt + policy) and writes deterministic JSON, so
 * two consecutive runs produce byte-identical output.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import {
  ROLES,
  ROLE_PROFILES,
  isRole,
  type ModelClass,
  type Role,
} from './policy-core.mts';

export interface RoleOverlay {
  role: Role;
  label: string;
  description: string;
  modelClass: ModelClass;
  /** Reasoning effort pinned on the launcher command line. */
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  welcomeMessage?: string;
  /** Only keys in SETTINGS_ALLOWLIST are honoured. */
  settings?: Record<string, unknown>;
}

/**
 * Settings an overlay may replace on top of the operator's base `cli.json`.
 *
 * Deliberately narrow. A role overlay is not a place to reconfigure the
 * operator's CLI; it exists to pin the model and the reasoning posture.
 */
export const SETTINGS_ALLOWLIST = [
  'chat.defaultModel',
  'chat.enableThinking',
  'chat.enableTodoList',
  'chat.enableCodeIntelligence',
  'chat.enableNotifications',
] as const;

/**
 * Settings forced on every generated runtime regardless of base or overlay.
 *
 * `chat.enableSubagent: false` is the second half of the delegation bound: the
 * policy hook denies the `delegate` tool, and this stops the capability being
 * offered in the first place. Paseo must remain the only control plane.
 */
export const FORCED_SETTINGS: Record<string, unknown> = {
  'chat.enableSubagent': false,
};

/** Shared, operator-owned paths linked into each runtime rather than copied. */
export const SHARED_LINKS = [
  { from: 'skills', to: 'skills' },
  { from: 'steering', to: 'steering' },
  { from: 'powers', to: 'powers' },
  { from: 'settings/mcp.json', to: 'settings/mcp.json' },
] as const;

export interface SyncOptions {
  role: Role;
  /** The operator's Kiro home, read-only. Normally `~/.kiro`. */
  baseHome: string;
  /** Destination `KIRO_HOME` for this role. Normally `~/.kiro-runtime/<role>`. */
  runtimeHome: string;
  /** Installed `~/.config/kiro-room`, holding overlays, prompts and extensions. */
  configDir: string;
  /** Resolved model id for this role's default class. */
  model: string;
  /**
   * Reasoning effort, normally taken from the routing class for this role.
   * Falls back to the overlay value when the table does not state one.
   */
  effort?: RoleOverlay['effort'];
  /** Absolute path to the hook entry point. */
  hookPath: string;
}

export interface SyncResult {
  role: Role;
  runtimeHome: string;
  agentPath: string;
  written: string[];
  linked: string[];
  skippedLinks: string[];
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Stable stringify: sorted keys, so regeneration is byte-identical. */
function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        out[key] = sort((v as Record<string, unknown>)[key]);
      }
      return out;
    }
    return v;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

function readJsonIfPresent(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Writes only when content differs, so mtimes stay stable across re-syncs. */
function writeIfChanged(path: string, content: string, mode = 0o600): boolean {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    try {
      if (readFileSync(path, 'utf8') === content) return false;
    } catch {
      /* fall through and rewrite */
    }
  }
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
  return true;
}

/**
 * Creates or repairs a symlink. Refuses to replace a real file or directory:
 * that would mean deleting operator data the generator does not own.
 */
function ensureSymlink(target: string, linkPath: string): 'created' | 'ok' | 'skipped' {
  mkdirSync(dirname(linkPath), { recursive: true });
  if (existsSync(linkPath) || isSymlink(linkPath)) {
    if (isSymlink(linkPath)) {
      if (readlinkSync(linkPath) === target) return 'ok';
      rmSync(linkPath);
    } else {
      return 'skipped';
    }
  }
  symlinkSync(target, linkPath);
  return 'created';
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function loadOverlay(configDir: string, role: Role): RoleOverlay {
  const path = join(configDir, 'overlays', `${role}.json`);
  if (!existsSync(path)) throw new Error(`missing role overlay: ${path}`);
  const overlay = JSON.parse(readFileSync(path, 'utf8')) as RoleOverlay;
  if (overlay.role !== role) {
    throw new Error(`overlay ${path} declares role ${JSON.stringify(overlay.role)}, expected ${role}`);
  }
  return overlay;
}

/* ------------------------------------------------------------------ *
 * Generated artefacts
 * ------------------------------------------------------------------ */

export function buildSettings(
  base: Record<string, unknown>,
  overlay: RoleOverlay,
  role: Role,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const key of SETTINGS_ALLOWLIST) {
    if (overlay.settings && key in overlay.settings) out[key] = overlay.settings[key];
  }
  out['chat.defaultAgent'] = `kiro-${role}`;
  for (const [key, value] of Object.entries(FORCED_SETTINGS)) out[key] = value;
  return out;
}

export function buildAgentConfig(opts: SyncOptions, overlay: RoleOverlay): Record<string, unknown> {
  const profile = ROLE_PROFILES[opts.role];
  const hookCommand = `node ${JSON.stringify(opts.hookPath)}`;
  const hook = (matcher?: string) => (matcher ? { matcher, command: hookCommand } : { command: hookCommand });

  return {
    name: `kiro-${opts.role}`,
    description: overlay.description,
    // Resolved relative to this config file's directory, i.e. <runtime>/agents.
    prompt: `file://../prompts/${opts.role}.md`,
    model: opts.model,
    mcpServers: {},
    includeMcpJson: true,
    tools: profile.tools,
    // Every tool the seat holds is auto-approved. The preToolUse hook is the
    // real bound, and it blocks regardless of approval state; leaving tools
    // unapproved would only stall an unattended Paseo session on a prompt that
    // nobody is there to answer.
    allowedTools: profile.tools,
    toolAliases: {},
    resources: [
      'file://README.md',
      'file://docs/WORKSPACE_PROTOCOL.md',
      'file://.kiro/steering/**/*.md',
    ],
    toolsSettings: {},
    // Emitted for forward compatibility with CLI 3.x only. Measured on
    // kiro-cli 2.26.0: this field validates and is then ignored at runtime, so
    // nothing in the policy depends on it. See docs/inventory-20260930.md.
    permissions: {
      rules: [
        { capability: 'subagent', match: ['*'], effect: 'deny' },
        {
          capability: 'fs_write',
          match: [
            '~/.kiro/**',
            '~/.kiro-runtime/**',
            '~/.kiro-room/**',
            '~/.config/kiro-room/**',
            '~/.paseo/**',
            '~/.claude/**',
            '~/.codex/**',
            '~/.aws/**',
            '~/.ssh/**',
          ],
          effect: 'deny',
        },
        { capability: 'shell', match: ['sudo *', 'rm -rf *', 'git push --force*'], effect: 'deny' },
      ],
    },
    // Array form is mandatory. Object form is rejected by 2.26.0 with
    // "data did not match any variant of untagged enum Repr".
    hooks: {
      agentSpawn: [hook()],
      userPromptSubmit: [hook()],
      preToolUse: [hook()],
      postToolUse: [hook()],
      stop: [hook()],
    },
    ...(overlay.welcomeMessage ? { welcomeMessage: overlay.welcomeMessage } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Sync
 * ------------------------------------------------------------------ */

export function syncRole(opts: SyncOptions): SyncResult {
  if (!isRole(opts.role)) throw new Error(`unknown role: ${JSON.stringify(opts.role)}`);

  const baseHome = resolve(opts.baseHome);
  const runtimeHome = resolve(opts.runtimeHome);
  const configDir = resolve(opts.configDir);

  if (runtimeHome === baseHome || runtimeHome.startsWith(`${baseHome}/`)) {
    throw new Error(
      `refusing to generate into ${runtimeHome}: it is inside the operator base home ${baseHome}`,
    );
  }

  const overlay = loadOverlay(configDir, opts.role);
  const written: string[] = [];
  const linked: string[] = [];
  const skippedLinks: string[] = [];

  mkdirSync(join(runtimeHome, 'agents'), { recursive: true });
  mkdirSync(join(runtimeHome, 'prompts'), { recursive: true });
  mkdirSync(join(runtimeHome, 'settings'), { recursive: true });
  mkdirSync(join(runtimeHome, 'sessions'), { recursive: true });
  mkdirSync(join(runtimeHome, 'kiro-room-state'), { recursive: true, mode: 0o700 });

  const baseSettings = readJsonIfPresent(join(baseHome, 'settings', 'cli.json'));
  const settings = buildSettings(baseSettings, overlay, opts.role);
  const settingsPath = join(runtimeHome, 'settings', 'cli.json');
  if (writeIfChanged(settingsPath, stableJson(settings))) written.push(settingsPath);

  const promptSrc = join(configDir, 'prompts', `${opts.role}.md`);
  if (!existsSync(promptSrc)) throw new Error(`missing role prompt: ${promptSrc}`);
  const promptDst = join(runtimeHome, 'prompts', `${opts.role}.md`);
  if (writeIfChanged(promptDst, readFileSync(promptSrc, 'utf8'), 0o644)) written.push(promptDst);

  const agentPath = join(runtimeHome, 'agents', `kiro-${opts.role}.json`);
  const agent = buildAgentConfig({ ...opts, runtimeHome, configDir, baseHome }, overlay);
  if (writeIfChanged(agentPath, stableJson(agent), 0o644)) written.push(agentPath);

  // A stamp so `verify` and `preflight` can tell what was deployed.
  const stampPath = join(runtimeHome, 'kiro-room.json');
  const stamp = {
    role: opts.role,
    label: overlay.label,
    model: opts.model,
    modelClass: overlay.modelClass,
    effort: opts.effort ?? overlay.effort,
    paseoTools: ROLE_PROFILES[opts.role].paseoTools,
    baseHome,
    configDir,
    hookPath: opts.hookPath,
  };
  if (writeIfChanged(stampPath, stableJson(stamp), 0o644)) written.push(stampPath);

  for (const link of SHARED_LINKS) {
    const target = join(baseHome, link.from);
    const linkPath = join(runtimeHome, link.to);
    if (!existsSync(target)) {
      skippedLinks.push(`${linkPath} (target ${target} absent)`);
      continue;
    }
    const outcome = ensureSymlink(target, linkPath);
    if (outcome === 'skipped') skippedLinks.push(`${linkPath} (real file present, not replaced)`);
    else linked.push(`${linkPath} -> ${target}`);
  }

  return { role: opts.role, runtimeHome, agentPath, written, linked, skippedLinks };
}

export function syncAllRoles(
  base: Omit<SyncOptions, 'role' | 'runtimeHome' | 'model'> & {
    runtimeRoot: string;
    models: Record<Role, string>;
    efforts?: Partial<Record<Role, RoleOverlay['effort']>>;
  },
): SyncResult[] {
  return ROLES.map((role) =>
    syncRole({
      role,
      baseHome: base.baseHome,
      configDir: base.configDir,
      hookPath: base.hookPath,
      runtimeHome: join(base.runtimeRoot, role),
      model: base.models[role],
      effort: base.efforts?.[role],
    }),
  );
}

/** Relative-path helper used by the reporters, kept here so tests can assert on it. */
export function displayPath(path: string, root: string): string {
  const rel = relative(root, path);
  return rel.startsWith('..') ? path : rel;
}
