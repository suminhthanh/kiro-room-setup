#!/usr/bin/env node
/**
 * Merges the three Kiro Room provider entries into a Paseo config.json.
 *
 * Narrow on purpose. The target file is live operator configuration holding
 * their existing providers, daemon settings and identity, so this script:
 *
 *   - adds only the three `kiro-*` keys under `agents.providers`;
 *   - refuses to run if any other key would change;
 *   - prints a diff before writing;
 *   - writes atomically via a temp file and rename.
 *
 * It does not reload the daemon. That is the operator's call, and it matters:
 * Paseo's provider snapshot manager rewrites the whole provider set back into
 * config.json on daemon start and on every desktop reconnect, so an edit the
 * running daemon never loaded is silently clobbered. Run `paseo daemon reload`
 * immediately after this, not later.
 *
 * usage: merge-paseo-providers.mjs --fragment <path> --target <path>
 *                                 [--home <path>] [--dry-run] [--force] [--quiet]
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const MANAGED_PROVIDER_IDS = ['kiro-supervisor', 'kiro-lead', 'kiro-peer'];
const PLACEHOLDER = /@@HOME@@/g;

function parseArgs(argv) {
  const out = { dryRun: false, force: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--quiet') out.quiet = true;
    else if (arg === '--fragment') out.fragment = argv[++i];
    else if (arg === '--target') out.target = argv[++i];
    else if (arg === '--home') out.home = argv[++i];
    else if (arg === '--backup-dir') out.backupDir = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.fragment) throw new Error('--fragment is required');
  if (!out.target) throw new Error('--target is required');
  out.home = out.home ?? process.env.HOME ?? '';
  return out;
}

/** Drops `_comment` keys so documentation in the fragment never reaches the config. */
function stripComments(value) {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (key === '_comment' || key === '$schema' || key === 'note') continue;
      out[key] = stripComments(v);
    }
    return out;
  }
  return value;
}

function render(value, home) {
  if (typeof value === 'string') return value.replace(PLACEHOLDER, home);
  if (Array.isArray(value)) return value.map((v) => render(v, home));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = render(v, home);
    return out;
  }
  return value;
}

export function loadProviders(fragmentPath, home) {
  const raw = JSON.parse(readFileSync(fragmentPath, 'utf8'));
  const providers = stripComments(raw)?.agents?.providers;
  if (!providers || typeof providers !== 'object') {
    throw new Error(`${fragmentPath} has no agents.providers object`);
  }
  const ids = Object.keys(providers);
  const unexpected = ids.filter((id) => !MANAGED_PROVIDER_IDS.includes(id));
  if (unexpected.length) {
    throw new Error(
      `fragment declares providers this script does not manage: ${unexpected.join(', ')}`,
    );
  }
  const missing = MANAGED_PROVIDER_IDS.filter((id) => !ids.includes(id));
  if (missing.length) throw new Error(`fragment is missing providers: ${missing.join(', ')}`);

  const rendered = render(providers, home);
  for (const [id, entry] of Object.entries(rendered)) {
    if (entry.extends !== 'acp') throw new Error(`${id}: extends must be "acp"`);
    if (!entry.label) throw new Error(`${id}: label is required`);
    if (!Array.isArray(entry.command) || entry.command.length < 2) {
      throw new Error(`${id}: command must be an array of [launcher, role]`);
    }
    if (entry.command.some((part) => PLACEHOLDER.test(part))) {
      throw new Error(`${id}: @@HOME@@ was not rendered`);
    }
    if (!Array.isArray(entry.models) || entry.models.length === 0) {
      throw new Error(`${id}: an explicit models allowlist is required`);
    }
    if (entry.additionalModels) {
      throw new Error(
        `${id}: additionalModels appends to the runtime catalog instead of replacing it; ` +
          'use models so the seat cannot offer an unvetted id',
      );
    }
  }
  return rendered;
}

/** Deep structural equality, used to decide whether an existing key is already correct. */
function deepEqual(a, b) {
  return JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

export function mergeProviders(config, providers, { force = false } = {}) {
  const next = structuredClone(config);
  next.agents = next.agents ?? {};
  next.agents.providers = next.agents.providers ?? {};

  const added = [];
  const unchanged = [];
  const conflicts = [];

  for (const id of MANAGED_PROVIDER_IDS) {
    // Clone: assigning the fragment object by reference would let a later edit to
    // the config mutate the fragment in memory, which makes conflict detection
    // compare an object against itself and silently pass.
    const incoming = structuredClone(providers[id]);
    const existing = next.agents.providers[id];
    if (!existing) {
      next.agents.providers[id] = incoming;
      added.push(id);
      continue;
    }
    if (deepEqual(existing, incoming)) {
      unchanged.push(id);
      continue;
    }
    if (!force) {
      conflicts.push(id);
      continue;
    }
    next.agents.providers[id] = incoming;
    added.push(id);
  }

  return { next, added, unchanged, conflicts };
}

/**
 * Confirms the merge changed nothing except the three managed provider keys.
 *
 * This is the guard that protects the operator's existing `codex-*` seats,
 * daemon block and identity. It compares the whole document with the managed
 * keys removed from both sides.
 */
export function assertOnlyManagedKeysChanged(before, after) {
  const scrub = (config) => {
    const copy = structuredClone(config);
    if (copy?.agents?.providers) {
      for (const id of MANAGED_PROVIDER_IDS) delete copy.agents.providers[id];
    }
    return copy;
  };
  const a = JSON.stringify(sortDeep(scrub(before)));
  const b = JSON.stringify(sortDeep(scrub(after)));
  if (a !== b) {
    throw new Error(
      'refusing to write: the merge would change configuration outside the three ' +
        'kiro-* provider keys',
    );
  }
}

export function diffSummary(before, after) {
  const lines = [];
  const beforeIds = Object.keys(before?.agents?.providers ?? {});
  const afterIds = Object.keys(after?.agents?.providers ?? {});
  for (const id of afterIds) {
    if (!beforeIds.includes(id)) lines.push(`+ agents.providers.${id}`);
  }
  for (const id of beforeIds) {
    if (!afterIds.includes(id)) lines.push(`- agents.providers.${id}`);
    else if (JSON.stringify(sortDeep(before.agents.providers[id])) !==
             JSON.stringify(sortDeep(after.agents.providers[id]))) {
      lines.push(`~ agents.providers.${id}`);
    }
  }
  return lines;
}

export function run(options) {
  const { fragment, target, home, dryRun, force, quiet, backupDir } = options;
  if (!existsSync(target)) throw new Error(`target config not found: ${target}`);

  const providers = loadProviders(fragment, home);
  const originalText = readFileSync(target, 'utf8');
  const before = JSON.parse(originalText);

  const { next, added, unchanged, conflicts } = mergeProviders(before, providers, { force });

  if (conflicts.length) {
    throw new Error(
      `these providers already exist with different content: ${conflicts.join(', ')}. ` +
        'Inspect them, then re-run with --force to overwrite.',
    );
  }

  assertOnlyManagedKeysChanged(before, next);

  const diff = diffSummary(before, next);
  const report = {
    target,
    added,
    unchanged,
    diff,
    wrote: false,
    backup: null,
  };

  if (added.length === 0) {
    if (!quiet) process.stdout.write(`${target}: already up to date (${unchanged.join(', ')})\n`);
    return report;
  }

  if (!quiet) {
    process.stdout.write(`${target}\n`);
    for (const line of diff) process.stdout.write(`  ${line}\n`);
  }

  if (dryRun) {
    if (!quiet) process.stdout.write('  (dry run, nothing written)\n');
    return report;
  }

  if (backupDir) {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const backup = join(backupDir, 'paseo-config.json');
    copyFileSync(target, backup);
    report.backup = backup;
  }

  const tmp = `${target}.kiro-room.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
  report.wrote = true;

  if (!quiet) {
    process.stdout.write(
      '\nNow run `paseo daemon reload` immediately. Paseo rewrites the provider set\n' +
        'back into config.json on daemon start and on every desktop reconnect, so an\n' +
        'edit the running daemon never loaded is silently clobbered.\n',
    );
  }
  return report;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  try {
    run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`merge-paseo-providers: ${error.message}\n`);
    process.exit(1);
  }
}
