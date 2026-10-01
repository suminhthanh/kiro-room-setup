#!/usr/bin/env node
/**
 * Fails before an agent is ever created, rather than after.
 *
 * Three independent checks, all fail-closed:
 *
 *   1. Every model id in the routing table exists in the live inventory. A
 *      typo'd id otherwise surfaces as a mid-task fallback to a default model,
 *      which is expensive and invisible.
 *   2. Structural rules on the table itself: five classes, a fallback for each,
 *      and a cross-family fallback for REVIEW_HIGH. Same-family review reads as
 *      independent without being independent, so it is rejected outright.
 *   3. Policy drift: the digest recorded in each deployed runtime against the
 *      digest of this checkout. A pull that was never redeployed leaves agents
 *      enforcing the old bounds while every file check passes clean.
 *
 * usage: preflight.mjs [--offline] [--routing <path>] [--catalog <path>]
 *                      [--runtime-root <path>] [--json]
 *
 * `--offline` reads the catalog fixture instead of calling kiro-cli, so the
 * check runs in CI and in a container without credentials.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MODEL_CLASSES, ROLES, modelFamily } from '../extensions/policy-core.mts';
import { policyDigest } from '../extensions/kiro-policy.mts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.HOME ?? '';

function parseArgs(argv) {
  const out = { offline: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--offline') out.offline = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--routing') out.routing = argv[++i];
    else if (arg === '--catalog') out.catalog = argv[++i];
    else if (arg === '--runtime-root') out.runtimeRoot = argv[++i];
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

export function resolveRoutingPath(explicit) {
  // An explicit path that does not exist is an error, never a reason to fall back.
  // Silently substituting the repo default would let a typo'd --routing validate
  // a table nobody is actually running.
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`routing table not found: ${explicit}`);
    return explicit;
  }
  const candidates = [
    join(HOME, '.kiro-room', 'model-routing.local.json'),
    join(HOME, '.config', 'kiro-room', 'model-routing.example.json'),
    join(REPO, 'config', 'model-routing.example.json'),
  ];
  for (const path of candidates) if (existsSync(path)) return path;
  throw new Error(`no routing table found; looked at:\n  ${candidates.join('\n  ')}`);
}

export function loadCatalog({ offline, catalog }) {
  if (catalog) {
    return {
      source: catalog,
      ids: JSON.parse(readFileSync(catalog, 'utf8')).models.map((m) => m.model_id),
    };
  }
  if (offline) {
    const fixture = join(REPO, 'tests', 'fixtures', 'model-catalog.json');
    return {
      source: `${fixture} (offline)`,
      ids: JSON.parse(readFileSync(fixture, 'utf8')).models.map((m) => m.model_id),
    };
  }
  const raw = execFileSync('kiro-cli', ['chat', '--list-models', '--format', 'json'], {
    encoding: 'utf8',
  });
  return { source: 'kiro-cli chat --list-models', ids: JSON.parse(raw).models.map((m) => m.model_id) };
}

/** Structural and semantic checks on the routing table. */
export function checkRouting(table, knownIds) {
  const problems = [];
  const classes = table?.classes ?? {};

  for (const cls of MODEL_CLASSES) {
    const entry = classes[cls];
    if (!entry) {
      problems.push(`${cls}: missing from the routing table`);
      continue;
    }
    if (!entry.primary) problems.push(`${cls}: no primary model`);
    if (!entry.fallback) {
      problems.push(
        `${cls}: no fallback model. Every class needs one so a quota or region ` +
          'error degrades instead of stalling.',
      );
    }
    if (!entry.reason || entry.reason.length < 20) {
      problems.push(`${cls}: needs a stated reason for the choice`);
    }
    for (const role of ['primary', 'fallback']) {
      const id = entry[role];
      if (id && !knownIds.includes(id)) {
        problems.push(`${cls}.${role}: ${JSON.stringify(id)} is not in the live catalog`);
      }
    }
    if (entry.primary && entry.fallback) {
      const pf = modelFamily(entry.primary);
      const ff = modelFamily(entry.fallback);
      if (pf === 'other' || ff === 'other') {
        problems.push(
          `${cls}: only Claude and GPT ids are permitted ` +
            `(primary ${entry.primary}, fallback ${entry.fallback})`,
        );
      } else if (cls === 'REVIEW_HIGH' && pf === ff) {
        problems.push(
          `REVIEW_HIGH: primary ${entry.primary} and fallback ${entry.fallback} are both ` +
            `${pf}. A reviewer must run on a different family than the implementer; ` +
            'same-family review reads as independent without being independent.',
        );
      }
    }
  }

  const unknownClasses = Object.keys(classes).filter((c) => !MODEL_CLASSES.includes(c));
  for (const c of unknownClasses) problems.push(`unknown routing class: ${c}`);

  const defaults = table?.roleDefaults ?? {};
  for (const role of ROLES) {
    const cls = defaults[role];
    if (!cls) problems.push(`roleDefaults.${role}: missing`);
    else if (!MODEL_CLASSES.includes(cls)) {
      problems.push(`roleDefaults.${role}: unknown class ${JSON.stringify(cls)}`);
    }
  }

  if (!table?.fallbackPolicy?.triggers?.length) {
    problems.push('fallbackPolicy.triggers: at least one trigger must be documented');
  }
  if (!table?.fallbackPolicy?.obligation) {
    problems.push(
      'fallbackPolicy.obligation: the requirement to record a switch must be stated',
    );
  }

  return problems;
}

/** Compares the digest stamped into each deployed runtime with this checkout. */
export function checkDeployedPolicy(runtimeRoot, expectedDigest) {
  const problems = [];
  const findings = [];
  if (!existsSync(runtimeRoot)) {
    return { problems, findings, checked: 0, note: `${runtimeRoot} not present (nothing deployed yet)` };
  }
  let checked = 0;
  for (const role of readdirSync(runtimeRoot)) {
    const stateDir = join(runtimeRoot, role, 'kiro-room-state');
    if (!existsSync(stateDir)) continue;
    for (const file of readdirSync(stateDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const record = JSON.parse(readFileSync(join(stateDir, file), 'utf8'));
        checked += 1;
        if (record.policyDigest && record.policyDigest !== expectedDigest) {
          findings.push(
            `${role}/${file}: recorded digest ${record.policyDigest} != checkout ${expectedDigest}`,
          );
        }
      } catch {
        /* a corrupt record is already handled as read-only at runtime */
      }
    }
  }
  if (findings.length) {
    problems.push(
      'deployed policy has drifted from this checkout. Sessions are enforcing older ' +
        'bounds than the code you are reading. Re-run `./install --apply` (or ' +
        '`scripts/sync-all`) to redeploy:\n  ' + findings.join('\n  '),
    );
  }
  return { problems, findings, checked };
}

export function preflight(options = {}) {
  const routingPath = resolveRoutingPath(options.routing);
  const table = JSON.parse(readFileSync(routingPath, 'utf8'));
  const catalog = loadCatalog(options);
  const runtimeRoot = options.runtimeRoot ?? join(HOME, '.kiro-runtime');
  const digest = policyDigest();

  const routingProblems = checkRouting(table, catalog.ids);
  const deployed = checkDeployedPolicy(runtimeRoot, digest);
  const problems = [...routingProblems, ...deployed.problems];

  return {
    ok: problems.length === 0,
    routingPath,
    catalogSource: catalog.source,
    catalogSize: catalog.ids.length,
    policyDigest: digest,
    runtimeRoot,
    deployedRecordsChecked: deployed.checked,
    deployedNote: deployed.note,
    problems,
    resolved: Object.fromEntries(
      MODEL_CLASSES.map((cls) => [
        cls,
        {
          primary: table.classes?.[cls]?.primary ?? null,
          fallback: table.classes?.[cls]?.fallback ?? null,
        },
      ]),
    ),
  };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`preflight: ${error.message}\n`);
    process.exit(2);
  }

  if (options.help) {
    process.stdout.write(
      'usage: preflight.mjs [--offline] [--routing <path>] [--catalog <path>]\n' +
        '                    [--runtime-root <path>] [--json]\n',
    );
    process.exit(0);
  }

  let report;
  try {
    report = preflight(options);
  } catch (error) {
    process.stderr.write(`preflight: ${error.message}\n`);
    process.exit(2);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`routing table  ${report.routingPath}\n`);
    process.stdout.write(`catalog        ${report.catalogSource} (${report.catalogSize} models)\n`);
    process.stdout.write(`policy digest  ${report.policyDigest}\n`);
    process.stdout.write(`runtime root   ${report.runtimeRoot}\n`);
    if (report.deployedNote) process.stdout.write(`               ${report.deployedNote}\n`);
    else {
      process.stdout.write(`               ${report.deployedRecordsChecked} turn records checked\n`);
    }
    process.stdout.write('\n');
    for (const [cls, route] of Object.entries(report.resolved)) {
      const pf = route.primary ? modelFamily(route.primary) : '?';
      const ff = route.fallback ? modelFamily(route.fallback) : '?';
      process.stdout.write(
        `  ${cls.padEnd(16)} ${String(route.primary).padEnd(18)} (${pf}) -> ` +
          `${String(route.fallback).padEnd(18)} (${ff})\n`,
      );
    }
    process.stdout.write('\n');
    if (report.ok) {
      process.stdout.write('preflight OK\n');
    } else {
      process.stderr.write('preflight FAILED\n');
      for (const problem of report.problems) process.stderr.write(`  - ${problem}\n`);
    }
  }

  process.exit(report.ok ? 0 : 1);
}
