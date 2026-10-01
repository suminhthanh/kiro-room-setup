/**
 * Runtime-agnostic policy for the Kiro Room roles.
 *
 * Nothing in this file knows about Kiro's payload shapes or about Paseo. It
 * takes a normalised request and returns exactly one decision. `kiro-policy.mts`
 * adapts Kiro's hook payloads onto it.
 *
 * Two independent gates apply, and both must pass before a mutating tool runs:
 *
 *   1. Brief gate      - decides WHETHER this turn may write at all.
 *   2. Boundary deny   - decides WHERE a permitted write may land.
 *
 * A valid brief never widens the boundary, and being inside the boundary never
 * substitutes for a brief.
 *
 * Measured constraint driving the design: on kiro-cli 2.26.0 the agent-config
 * `permissions.rules` field validates successfully and is then ignored at
 * runtime (see docs/inventory-20260930.md). The `preToolUse` hook is the only
 * mechanism observed to actually block a tool, so every rule here has to be
 * reachable from that hook.
 */

export const POLICY_VERSION = 'kiro-room/policy-v1';

export const ROLES = ['supervisor', 'lead', 'peer'] as const;
export type Role = (typeof ROLES)[number];

export type Effect = 'allow' | 'deny';

export interface Decision {
  effect: Effect;
  /** Stable machine-readable reason, safe to assert on in tests. */
  code: string;
  /** Human-readable explanation surfaced to the agent. */
  reason: string;
}

const allow = (code: string, reason: string): Decision => ({ effect: 'allow', code, reason });
const deny = (code: string, reason: string): Decision => ({ effect: 'deny', code, reason });

/* ------------------------------------------------------------------ *
 * Tool surface
 * ------------------------------------------------------------------ */

/**
 * Tool names as they arrive in a kiro-cli 2.26.0 `preToolUse` payload.
 *
 * These are the *tag* names (`shell`, `write`), not the internal names the
 * public docs list for hook matchers (`execute_bash`, `fs_write`). Verified by
 * capturing a live payload; see docs/inventory-20260930.md.
 */
export const READ_ONLY_TOOLS = [
  'read',
  'grep',
  'glob',
  'introspect',
  'report',
  'thinking',
  'todo',
  'knowledge',
] as const;

export const MUTATING_TOOLS = ['write', 'shell'] as const;

/** Sub-agent delegation. Denied for every role: Paseo is the only control plane. */
export const DELEGATION_TOOLS = ['delegate', 'subagent', 'agent', 'task'] as const;

export interface RoleProfile {
  /** Tools written into the generated agent config's `tools` array. */
  tools: string[];
  /** Tools usable with no brief present. */
  unconditional: string[];
  /** Tools that additionally require a valid brief granting the authority. */
  briefGated: string[];
  /** Whether this seat receives Paseo orchestration tools over MCP. */
  paseoTools: boolean;
  defaultModelClass: ModelClass;
}

export const ROLE_PROFILES: Record<Role, RoleProfile> = {
  supervisor: {
    tools: [...READ_ONLY_TOOLS, 'shell', '@mcp'],
    unconditional: [...READ_ONLY_TOOLS, 'shell'],
    briefGated: [],
    paseoTools: true,
    defaultModelClass: 'MONITOR_ECONOMY',
  },
  lead: {
    tools: [...READ_ONLY_TOOLS, 'shell', 'write', '@mcp'],
    unconditional: [...READ_ONLY_TOOLS, 'shell'],
    briefGated: ['write'],
    paseoTools: true,
    defaultModelClass: 'REASONING_HIGH',
  },
  peer: {
    tools: [...READ_ONLY_TOOLS, 'shell', 'write'],
    unconditional: [...READ_ONLY_TOOLS],
    briefGated: ['write', 'shell'],
    paseoTools: false,
    defaultModelClass: 'CODING_MEDIUM',
  },
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ *
 * Model routing classes
 * ------------------------------------------------------------------ */

export const MODEL_CLASSES = [
  'MONITOR_ECONOMY',
  'FAST_READ',
  'CODING_MEDIUM',
  'REASONING_HIGH',
  'REVIEW_HIGH',
] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];

export function isModelClass(value: unknown): value is ModelClass {
  return typeof value === 'string' && (MODEL_CLASSES as readonly string[]).includes(value);
}

/**
 * Model family, derived from the id prefix. Used to enforce that a reviewer
 * runs on a different family than the implementer it is reviewing.
 */
export function modelFamily(modelId: string): 'claude' | 'gpt' | 'other' {
  if (/^claude[-.]/.test(modelId)) return 'claude';
  if (/^gpt[-.]/.test(modelId)) return 'gpt';
  return 'other';
}

interface ClassifyRule {
  cls: ModelClass;
  patterns: RegExp[];
}

/**
 * Ordered most-specific-first. Review beats reasoning because "review this
 * refactor" is a review task, not a refactor task.
 */
const CLASSIFY_RULES: ClassifyRule[] = [
  {
    cls: 'REVIEW_HIGH',
    patterns: [
      /\breview\b/i, /\baudit\b/i, /\bcritique\b/i, /\bacceptance\b/i,
      /\bsign[- ]?off\b/i, /\bduy[ệe]t\b/i, /\br[àa] so[áa]t\b/i, /\bki[ểe]m tra ch[ấa]t l[ưu][ợo]ng\b/i,
    ],
  },
  {
    cls: 'REASONING_HIGH',
    patterns: [
      /\brefactor\b/i, /\barchitect(ure)?\b/i, /\bredesign\b/i, /\bmigrat(e|ion)\b/i,
      /\broot[- ]cause\b/i, /\bdebug\b/i, /\bmulti[- ]file\b/i, /\bsecurity\b/i,
      /\bt[áa]i c[ấa]u tr[úu]c\b/i, /\bthi[ếe]t k[ếe]\b/i, /\bph[âa]n t[íi]ch nguy[êe]n nh[âa]n\b/i,
    ],
  },
  {
    cls: 'MONITOR_ECONOMY',
    patterns: [
      /\bmonitor(ing)?\b/i, /\bsweep\b/i, /\bwatchdog\b/i, /\breconcile\b/i,
      /\bheartbeat\b/i, /\bstatus check\b/i, /\bgi[áa]m s[áa]t\b/i, /\bqu[ée]t\b/i,
    ],
  },
  {
    cls: 'FAST_READ',
    patterns: [
      /\bgrep\b/i, /\bsearch\b/i, /\block\s?up\b/i, /\blook up\b/i, /\bfind (the|all|where)\b/i,
      /\bsummar(y|ise|ize)\b/i, /\bwhere is\b/i, /\bt[ìi]m\b/i, /\btra c[ứu]u\b/i, /\bt[óo]m t[ắa]t\b/i,
    ],
  },
  {
    cls: 'CODING_MEDIUM',
    patterns: [
      /\bimplement\b/i, /\badd\b/i, /\bfix\b/i, /\bwrite\b/i, /\btest\b/i,
      /\bfeature\b/i, /\btri[ểe]n khai\b/i, /\bs[ửu]a\b/i, /\bth[êe]m\b/i,
    ],
  },
];

/**
 * Maps a task description onto a routing class. Falls back to `CODING_MEDIUM`
 * rather than to a cheap class, so an unrecognised task is not silently
 * under-resourced.
 */
export function classifyTask(description: string): ModelClass {
  const text = String(description ?? '');
  for (const rule of CLASSIFY_RULES) {
    if (rule.patterns.some((p) => p.test(text))) return rule.cls;
  }
  return 'CODING_MEDIUM';
}

/* ------------------------------------------------------------------ *
 * Brief parser
 * ------------------------------------------------------------------ */

export const BRIEF_BEGIN = 'KIRO_ROOM_TASK_V1_BEGIN';
export const BRIEF_END = 'KIRO_ROOM_TASK_V1_END';

export type Authority = 'read' | 'write' | 'git';

export interface Brief {
  role: Role;
  taskId: string;
  workspace: string;
  branch: string | null;
  ownedScope: string[];
  excludedScope: string[];
  authority: Authority[];
  modelClass: ModelClass | null;
}

export type BriefParse =
  | { kind: 'none' }
  | { kind: 'invalid'; errors: string[] }
  | { kind: 'valid'; brief: Brief };

const REQUIRED_BRIEF_FIELDS = ['ROLE', 'TASK_ID', 'WORKSPACE', 'AUTHORITY'] as const;

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.toUpperCase() !== 'NONE');
}

/**
 * Extracts authority from the marker block of a single turn.
 *
 * Deliberately strict and fail-closed: a turn with no block is read-only, and a
 * block that is present but malformed denies everything rather than degrading
 * to read-only. A malformed block means someone tried to grant authority and
 * got it wrong, which is a different situation from not asking for any.
 */
export function parseBrief(text: string): BriefParse {
  const input = String(text ?? '');
  const beginCount = input.split(BRIEF_BEGIN).length - 1;
  const endCount = input.split(BRIEF_END).length - 1;

  if (beginCount === 0 && endCount === 0) return { kind: 'none' };

  const errors: string[] = [];
  if (beginCount !== 1 || endCount !== 1) {
    errors.push(
      `expected exactly one ${BRIEF_BEGIN}/${BRIEF_END} pair, found ${beginCount}/${endCount}`,
    );
    return { kind: 'invalid', errors };
  }

  const beginAt = input.indexOf(BRIEF_BEGIN);
  const endAt = input.indexOf(BRIEF_END);
  if (endAt < beginAt) {
    return { kind: 'invalid', errors: [`${BRIEF_END} appears before ${BRIEF_BEGIN}`] };
  }

  const body = input.slice(beginAt + BRIEF_BEGIN.length, endAt);
  const fields = new Map<string, string>();
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep === -1) {
      errors.push(`unparseable brief line: ${JSON.stringify(line)}`);
      continue;
    }
    const key = line.slice(0, sep).trim().toUpperCase();
    const value = line.slice(sep + 1).trim();
    if (fields.has(key)) errors.push(`duplicate brief field: ${key}`);
    fields.set(key, value);
  }

  for (const required of REQUIRED_BRIEF_FIELDS) {
    if (!fields.has(required) || fields.get(required) === '') {
      errors.push(`missing required brief field: ${required}`);
    }
  }

  const roleRaw = (fields.get('ROLE') ?? '').toLowerCase();
  if (fields.has('ROLE') && !isRole(roleRaw)) {
    errors.push(`unknown ROLE in brief: ${JSON.stringify(fields.get('ROLE'))}`);
  }

  const authorityRaw = splitList(fields.get('AUTHORITY') ?? '').map((a) => a.toLowerCase());
  const authority: Authority[] = [];
  for (const a of authorityRaw) {
    if (a === 'read' || a === 'write' || a === 'git') authority.push(a);
    else errors.push(`unknown AUTHORITY token in brief: ${JSON.stringify(a)}`);
  }

  const workspace = fields.get('WORKSPACE') ?? '';
  if (workspace && !workspace.startsWith('/')) {
    errors.push(`WORKSPACE must be an absolute path, got ${JSON.stringify(workspace)}`);
  }

  const modelClassRaw = fields.get('MODEL_CLASS');
  let modelClass: ModelClass | null = null;
  if (modelClassRaw) {
    const upper = modelClassRaw.toUpperCase();
    if (isModelClass(upper)) modelClass = upper;
    else errors.push(`unknown MODEL_CLASS in brief: ${JSON.stringify(modelClassRaw)}`);
  }

  const branch = fields.get('BRANCH') || null;
  if (branch && !/^agent\/[A-Za-z0-9._\/-]+$/.test(branch)) {
    errors.push(`BRANCH must match agent/<name>, got ${JSON.stringify(branch)}`);
  }

  if (errors.length > 0) return { kind: 'invalid', errors };

  return {
    kind: 'valid',
    brief: {
      role: roleRaw as Role,
      taskId: fields.get('TASK_ID') as string,
      workspace,
      branch,
      ownedScope: splitList(fields.get('OWNED_SCOPE') ?? ''),
      excludedScope: splitList(fields.get('EXCLUDED_SCOPE') ?? ''),
      authority,
      modelClass,
    },
  };
}

/** Renders a brief back to its wire form. Round-trips through `parseBrief`. */
export function renderBrief(brief: Brief): string {
  const lines = [
    BRIEF_BEGIN,
    `ROLE: ${brief.role}`,
    `TASK_ID: ${brief.taskId}`,
    `WORKSPACE: ${brief.workspace}`,
  ];
  if (brief.branch) lines.push(`BRANCH: ${brief.branch}`);
  lines.push(`OWNED_SCOPE: ${brief.ownedScope.length ? brief.ownedScope.join(', ') : 'NONE'}`);
  if (brief.excludedScope.length) lines.push(`EXCLUDED_SCOPE: ${brief.excludedScope.join(', ')}`);
  lines.push(`AUTHORITY: ${brief.authority.length ? brief.authority.join(', ') : 'read'}`);
  if (brief.modelClass) lines.push(`MODEL_CLASS: ${brief.modelClass}`);
  lines.push(BRIEF_END);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Boundary deny
 * ------------------------------------------------------------------ */

/**
 * Paths never writable by any role regardless of brief, relative to HOME.
 *
 * These hold the policy itself, the generated runtimes, the Paseo control
 * plane, and credentials. An agent that can rewrite these can rewrite its own
 * bounds, so the deny is unconditional.
 */
export const PROTECTED_HOME_PREFIXES = [
  '.kiro',
  '.kiro-runtime',
  '.kiro-room',
  '.kiro-room-backups',
  '.config/kiro-room',
  '.paseo',
  '.claude',
  '.codex',
  '.aws',
  '.ssh',
  '.gnupg',
  'Library/Keychains',
] as const;

function normalisePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}

export function resolvePath(input: string, cwd: string, home: string): string {
  let p = String(input ?? '').trim();
  if (p.startsWith('~')) p = home + p.slice(1);
  if (!p.startsWith('/')) p = `${cwd}/${p}`;
  return normalisePath(p);
}

function isWithin(child: string, parent: string): boolean {
  const c = normalisePath(child);
  const p = normalisePath(parent);
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

export interface BoundaryContext {
  home: string;
  cwd: string;
  /** Write root. The brief's WORKSPACE when present, otherwise `cwd`. */
  workspace: string;
}

/** Unconditional protected-path check. Runs before any workspace reasoning. */
export function protectedPathHit(absPath: string, home: string): string | null {
  for (const rel of PROTECTED_HOME_PREFIXES) {
    const prefix = normalisePath(`${home}/${rel}`);
    if (isWithin(absPath, prefix)) return prefix;
  }
  return null;
}

export function checkWriteBoundary(rawPath: string, ctx: BoundaryContext): Decision {
  if (!rawPath || !String(rawPath).trim()) {
    return deny('boundary.missing_path', 'Write rejected: no target path supplied.');
  }
  const abs = resolvePath(rawPath, ctx.cwd, ctx.home);

  const hit = protectedPathHit(abs, ctx.home);
  if (hit) {
    return deny(
      'boundary.protected_path',
      `Write to ${abs} is denied: ${hit} holds the policy, generated runtimes, ` +
        'control-plane state or credentials and is never writable by a role seat.',
    );
  }

  if (!isWithin(abs, ctx.workspace)) {
    return deny(
      'boundary.outside_workspace',
      `Write to ${abs} is denied: it falls outside the workspace root ${ctx.workspace}.`,
    );
  }

  return allow('boundary.ok', `Write to ${abs} is inside ${ctx.workspace}.`);
}

/* ------------------------------------------------------------------ *
 * Shell guard
 * ------------------------------------------------------------------ */

interface ShellRule {
  code: string;
  pattern: RegExp;
  reason: string;
}

/**
 * Applies to every role, including with a valid brief. Each entry exists
 * because the action is either irreversible, escalates privilege, or destroys
 * the review trail the harness is judged on.
 */
export const SHELL_DENY_RULES: ShellRule[] = [
  {
    code: 'shell.sudo',
    pattern: /(^|[;&|]\s*)(sudo|doas|su)\b/,
    reason: 'Privilege escalation is never available to a role seat.',
  },
  {
    code: 'shell.recursive_delete',
    pattern: /\brm\b[^;&|]*?(-[A-Za-z]*[rR][A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*[rR]|--recursive[^;&|]*--force|--force[^;&|]*--recursive)/,
    reason: 'Recursive forced deletion is irreversible.',
  },
  {
    code: 'shell.force_push',
    pattern: /\bgit\b[^;&|]*\bpush\b[^;&|]*(--force\b|--force-with-lease\b|--force-if-includes\b|\s-[A-Za-z]*f[A-Za-z]*(\s|$)|\s\+[A-Za-z0-9._\/-]*:)/,
    reason: 'Force-push rewrites published history and is denied in every spelling.',
  },
  {
    code: 'shell.amend',
    pattern: /\bgit\b[^;&|]*\bcommit\b[^;&|]*--amend\b/,
    reason: 'Amending rewrites a commit a reviewer may already have accepted.',
  },
  {
    code: 'shell.reset_hard',
    pattern: /\bgit\b[^;&|]*\breset\b[^;&|]*--hard\b/,
    reason: 'git reset --hard discards uncommitted work irrecoverably.',
  },
  {
    code: 'shell.clean_force',
    pattern: /\bgit\b[^;&|]*\bclean\b[^;&|]*-[A-Za-z]*f/,
    reason: 'git clean -f deletes untracked files irrecoverably.',
  },
  {
    code: 'shell.branch_delete',
    pattern: /\bgit\b[^;&|]*\bbranch\b[^;&|]*(-D\b|--delete\s+--force\b)/,
    reason: 'Force-deleting a branch can drop unmerged review candidates.',
  },
  {
    code: 'shell.history_rewrite',
    pattern: /\bgit\b[^;&|]*\b(filter-branch|filter-repo|rebase)\b/,
    reason: 'History rewriting invalidates SHA-bound review evidence.',
  },
  {
    code: 'shell.remote_mutation',
    pattern: /\bgit\b[^;&|]*\bpush\b[^;&|]*--delete\b|\bgit\b[^;&|]*\bremote\b[^;&|]*\b(set-url|remove|rm)\b/,
    reason: 'Remote topology and remote branch deletion are operator decisions.',
  },
  {
    code: 'shell.control_plane',
    pattern: /\bpaseo\b[^;&|]*\bdaemon\b[^;&|]*\b(stop|restart|reload)\b/,
    reason: 'Restarting or reloading the Paseo daemon disrupts every running agent.',
  },
  {
    code: 'shell.auth_mutation',
    pattern: /\b(kiro-cli|kiro)\b[^;&|]*\b(logout|login)\b|\baws\b[^;&|]*\bconfigure\b/,
    reason: 'Credential state is operator-owned.',
  },
  {
    code: 'shell.pipe_to_shell',
    pattern: /\b(curl|wget)\b[^;&|]*\|\s*(sudo\s+)?(ba)?sh\b/,
    reason: 'Piping a download into a shell executes unreviewed remote code.',
  },
  {
    code: 'shell.publish',
    pattern: /\bnpm\b[^;&|]*\bpublish\b|\bgh\b[^;&|]*\brelease\b[^;&|]*\bcreate\b|\bdocker\b[^;&|]*\bpush\b/,
    reason: 'Publishing is an external effect reserved for the operator.',
  },
  {
    code: 'shell.ownership',
    pattern: /\b(chown|chgrp)\b|\bchmod\b[^;&|]*-[A-Za-z]*R/,
    reason: 'Recursive permission or ownership changes are out of scope for a seat.',
  },
];

/** Only this exact shape of push is permitted, and only with git authority. */
export const ALLOWED_PUSH_PATTERN =
  /^git\s+push\s+-u\s+origin\s+HEAD:refs\/heads\/agent\/[A-Za-z0-9._\/-]+$/;

const MUTATING_GIT = /\bgit\b[^;&|]*\b(commit|push|merge|tag|cherry-pick|revert|stash\s+drop|worktree\s+(add|remove))\b/;

function looksLikeGitWrite(command: string): boolean {
  return MUTATING_GIT.test(command);
}

/** Splits on shell separators so each segment is judged on its own. */
export function shellSegments(command: string): string[] {
  return String(command ?? '')
    .split(/(?:&&|\|\||;|\n|\|)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface ShellContext extends BoundaryContext {
  role: Role;
  /** Authority granted by the current turn's brief. */
  authority: Authority[];
}

/**
 * Scans a command for absolute/`~`/relative path arguments and applies the
 * unconditional protected-path deny. Fail-closed: a protected path mentioned
 * anywhere in a command is denied even for a read, because the read tool is the
 * supported route for inspecting configuration and shell reads of credential
 * directories have no legitimate use from a seat.
 */
export function shellProtectedPathScan(command: string, ctx: BoundaryContext): Decision | null {
  const tokens = String(command ?? '').match(/(?:~|\.{1,2}\/|\/)[^\s'"`;&|<>()]*/g) ?? [];
  for (const token of tokens) {
    const abs = resolvePath(token, ctx.cwd, ctx.home);
    const hit = protectedPathHit(abs, ctx.home);
    if (hit) {
      return deny(
        'shell.protected_path',
        `Command references ${abs}, inside the protected prefix ${hit}. ` +
          'Role seats never touch policy, runtime, control-plane or credential directories.',
      );
    }
  }
  return null;
}

export function evaluateShell(command: string, ctx: ShellContext): Decision {
  const raw = String(command ?? '');
  if (!raw.trim()) return deny('shell.empty', 'Empty command rejected.');

  for (const rule of SHELL_DENY_RULES) {
    if (rule.pattern.test(raw)) return deny(rule.code, rule.reason);
  }

  const protectedHit = shellProtectedPathScan(raw, ctx);
  if (protectedHit) return protectedHit;

  for (const segment of shellSegments(raw)) {
    const normalised = segment.replace(/\s+/g, ' ').trim();

    if (/^git\s+push\b/.test(normalised)) {
      if (!ctx.authority.includes('git')) {
        return deny(
          'shell.push_without_git_authority',
          'Push requires git authority, which only a valid brief for this turn can grant.',
        );
      }
      if (!ALLOWED_PUSH_PATTERN.test(normalised)) {
        return deny(
          'shell.push_shape',
          'Only `git push -u origin HEAD:refs/heads/agent/<name>` is permitted. ' +
            `Rejected: ${JSON.stringify(normalised)}`,
        );
      }
      continue;
    }

    if (/^git\s+merge\b/.test(normalised) && ctx.role === 'peer') {
      return deny(
        'shell.peer_merge',
        'A Peer never merges. Integration is the Lead\'s decision after review.',
      );
    }

    if (looksLikeGitWrite(normalised) && !ctx.authority.includes('git')) {
      return deny(
        'shell.git_without_authority',
        `Mutating git command requires git authority: ${JSON.stringify(normalised)}`,
      );
    }
  }

  return allow('shell.ok', 'Command passed the shell guard.');
}

/* ------------------------------------------------------------------ *
 * Top-level decision
 * ------------------------------------------------------------------ */

export interface ToolRequest {
  role: Role;
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  home: string;
  /** Parse result for the current turn. `{kind:'none'}` means a plain message. */
  brief: BriefParse;
  /** Set by the launcher to let a Lead write product code deliberately. */
  leadWriteEnabled?: boolean;
}

function authorityFor(req: ToolRequest): Authority[] {
  if (req.brief.kind !== 'valid') return [];
  return req.brief.brief.authority;
}

function workspaceFor(req: ToolRequest): string {
  if (req.brief.kind === 'valid' && req.brief.brief.workspace) return req.brief.brief.workspace;
  return req.cwd;
}

/** Extracts the target path from a `write` tool payload. */
export function writeTargetPath(toolInput: Record<string, unknown>): string {
  for (const key of ['path', 'file_path', 'filePath', 'target', 'file']) {
    const v = toolInput?.[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

/**
 * The single entry point. One request in, one decision out.
 *
 * Order matters and is deliberate:
 *   delegation deny -> malformed brief deny -> tool surface -> brief gate ->
 *   boundary / shell guard.
 *
 * A malformed brief is rejected before anything else is considered so that a
 * broken grant can never be read as a partial grant.
 */
export function evaluate(req: ToolRequest): Decision {
  const role = req.role;
  const tool = String(req.toolName ?? '').toLowerCase();

  if (!isRole(role)) {
    return deny('role.unknown', `Unknown role ${JSON.stringify(role)}; refusing fail-open.`);
  }

  if ((DELEGATION_TOOLS as readonly string[]).includes(tool)) {
    return deny(
      'delegation.denied',
      'Native delegation is denied for every role. Paseo is the only control plane; ' +
        'a Kiro-native sub-agent is a second one Paseo cannot see, bound or account for. ' +
        'Delegate through mcp__paseo__create_agent instead.',
    );
  }

  if (req.brief.kind === 'invalid') {
    return deny(
      'brief.invalid',
      'The brief marker block for this turn is malformed, so no authority is granted: ' +
        req.brief.errors.join('; '),
    );
  }

  const profile = ROLE_PROFILES[role];
  const known = new Set<string>([...profile.unconditional, ...profile.briefGated]);
  if (!known.has(tool)) {
    return deny(
      'tool.not_in_role_surface',
      `Tool ${JSON.stringify(tool)} is not part of the ${role} seat's surface.`,
    );
  }

  if (profile.unconditional.includes(tool) && !(MUTATING_TOOLS as readonly string[]).includes(tool)) {
    return allow('tool.read_only', `${tool} is unconditionally available to ${role}.`);
  }

  const authority = authorityFor(req);
  const ctx: BoundaryContext = { home: req.home, cwd: req.cwd, workspace: workspaceFor(req) };

  if (tool === 'write') {
    if (role === 'lead' && !req.leadWriteEnabled) {
      return deny(
        'lead.write_disabled',
        'The Lead does not write product code. Set KIRO_ROOM_LEAD_WRITE=1 on the seat to override.',
      );
    }
    if (!authority.includes('write')) {
      const why =
        req.brief.kind === 'none'
          ? 'This turn carries no brief marker block, so it is read-only. ' +
            'Ask the Lead to re-issue a brief; a plain chat message grants nothing.'
          : 'The brief for this turn does not grant write authority.';
      return deny('brief.write_not_granted', why);
    }
    return checkWriteBoundary(writeTargetPath(req.toolInput), ctx);
  }

  if (tool === 'shell') {
    if (profile.briefGated.includes('shell') && authority.length === 0) {
      const why =
        req.brief.kind === 'none'
          ? 'This turn carries no brief marker block, so the shell is unavailable to a Peer. ' +
            'Ask the Lead to re-issue a brief.'
          : 'The brief for this turn grants no authority, so the shell is unavailable.';
      return deny('brief.shell_not_granted', why);
    }
    const command = typeof req.toolInput?.command === 'string' ? req.toolInput.command : '';
    return evaluateShell(command, { ...ctx, role, authority });
  }

  return deny('tool.unhandled', `No rule covers ${JSON.stringify(tool)}; refusing fail-open.`);
}

/* ------------------------------------------------------------------ *
 * Drift detection
 * ------------------------------------------------------------------ */

/**
 * Stable fingerprint of every rule that can change a decision.
 *
 * Computed from the rule set rather than from file bytes so that reformatting
 * or a comment edit does not read as a policy change, while any change to an
 * actual bound does. `preflight` compares the deployed digest against the
 * checkout; a pull that is not redeployed shows up here.
 */
export function policyFingerprintSource(): string {
  return JSON.stringify({
    version: POLICY_VERSION,
    roles: ROLES,
    profiles: ROLE_PROFILES,
    modelClasses: MODEL_CLASSES,
    protectedPrefixes: PROTECTED_HOME_PREFIXES,
    shellRules: SHELL_DENY_RULES.map((r) => [r.code, r.pattern.source]),
    allowedPush: ALLOWED_PUSH_PATTERN.source,
    delegation: DELEGATION_TOOLS,
    briefMarkers: [BRIEF_BEGIN, BRIEF_END],
    requiredBriefFields: REQUIRED_BRIEF_FIELDS,
  });
}
