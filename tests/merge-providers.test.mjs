import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MANAGED_PROVIDER_IDS,
  assertOnlyManagedKeysChanged,
  diffSummary,
  loadProviders,
  mergeProviders,
  run,
} from '../scripts/merge-paseo-providers.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FRAGMENT = join(REPO, 'home', '.paseo', 'config.json.kiro-providers.json');
const SAMPLE = join(REPO, 'tests', 'fixtures', 'paseo-config.sample.json');
const SCRIPT = join(REPO, 'scripts', 'merge-paseo-providers.mjs');
const HOME = '/Users/operator';

/**
 * Providers the operator already runs. The merge must not touch any of them;
 * the whole point of this suite is that adding three seats cannot break the
 * three Codex seats that are already in production on this host.
 */
const PRESERVED = [
  'codex-supervisor',
  'codex-lead',
  'codex-peer',
  'claude',
  'codex',
  'kiro',
  'grok',
  'hermes',
  'devin',
  'pi',
  'opencode',
  'copilot',
  'omp',
];

let sandbox;
before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'kiro-room-merge-test.'));
});
after(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

function freshTarget(name) {
  const path = join(sandbox, `${name}.json`);
  copyFileSync(SAMPLE, path);
  return path;
}

describe('fragment validation', () => {
  test('loads exactly the three managed providers', () => {
    const providers = loadProviders(FRAGMENT, HOME);
    assert.deepEqual(Object.keys(providers).sort(), [...MANAGED_PROVIDER_IDS].sort());
  });

  test('@@HOME@@ is rendered in every command', () => {
    const providers = loadProviders(FRAGMENT, HOME);
    for (const [id, entry] of Object.entries(providers)) {
      assert.equal(entry.command[0], `${HOME}/.local/bin/kiro-room`, id);
      assert.ok(!JSON.stringify(entry).includes('@@HOME@@'), `${id} still has a placeholder`);
    }
  });

  test('each command passes its own role as the second argument', () => {
    const providers = loadProviders(FRAGMENT, HOME);
    assert.equal(providers['kiro-supervisor'].command[1], 'supervisor');
    assert.equal(providers['kiro-lead'].command[1], 'lead');
    assert.equal(providers['kiro-peer'].command[1], 'peer');
  });

  test('the Peer seat gets no Paseo orchestration tools', () => {
    const providers = loadProviders(FRAGMENT, HOME);
    assert.equal(providers['kiro-peer'].paseoTools.enabled, false);
    assert.equal(providers['kiro-lead'].paseoTools.enabled, true);
    assert.equal(providers['kiro-supervisor'].paseoTools.enabled, true);
  });

  test('every model id in the fragment exists in the live catalog fixture', () => {
    const catalog = JSON.parse(
      readFileSync(join(REPO, 'tests', 'fixtures', 'model-catalog.json'), 'utf8'),
    );
    const known = new Set(catalog.models.map((m) => m.model_id));
    const providers = loadProviders(FRAGMENT, HOME);
    for (const [id, entry] of Object.entries(providers)) {
      for (const model of entry.models) {
        assert.ok(known.has(model.id), `${id} lists unknown model ${model.id}`);
      }
    }
  });

  test('every provider curates models rather than extending the catalog', () => {
    const providers = loadProviders(FRAGMENT, HOME);
    for (const [id, entry] of Object.entries(providers)) {
      assert.ok(Array.isArray(entry.models) && entry.models.length > 0, id);
      assert.ok(!('additionalModels' in entry), `${id} must not use additionalModels`);
      assert.equal(entry.models.filter((m) => m.isDefault).length, 1, `${id} needs one default`);
    }
  });

  test('a fragment declaring an unmanaged provider is rejected', () => {
    const bad = join(sandbox, 'bad-fragment.json');
    writeFileSync(
      bad,
      JSON.stringify({ agents: { providers: { 'kiro-rogue': { extends: 'acp' } } } }),
    );
    assert.throws(() => loadProviders(bad, HOME), /does not manage/);
  });

  test('a fragment using additionalModels is rejected', () => {
    const bad = join(sandbox, 'addl-fragment.json');
    const providers = loadProviders(FRAGMENT, HOME);
    providers['kiro-peer'].additionalModels = [{ id: 'x', label: 'x' }];
    writeFileSync(bad, JSON.stringify({ agents: { providers: providers } }));
    assert.throws(() => loadProviders(bad, HOME), /additionalModels/);
  });
});

describe('merge preserves the operator configuration', () => {
  test('nothing outside the three keys changes', () => {
    const before = JSON.parse(readFileSync(SAMPLE, 'utf8'));
    const providers = loadProviders(FRAGMENT, HOME);
    const { next } = mergeProviders(before, providers);
    assert.doesNotThrow(() => assertOnlyManagedKeysChanged(before, next));
  });

  test('every pre-existing provider survives byte-identically', () => {
    const before = JSON.parse(readFileSync(SAMPLE, 'utf8'));
    const { next } = mergeProviders(before, loadProviders(FRAGMENT, HOME));
    for (const id of PRESERVED) {
      assert.ok(before.agents.providers[id], `fixture is missing ${id}`);
      assert.deepEqual(
        next.agents.providers[id],
        before.agents.providers[id],
        `${id} was modified`,
      );
    }
  });

  test('the daemon block and features are untouched', () => {
    const before = JSON.parse(readFileSync(SAMPLE, 'utf8'));
    const { next } = mergeProviders(before, loadProviders(FRAGMENT, HOME));
    assert.deepEqual(next.daemon, before.daemon);
    assert.deepEqual(next.features, before.features);
    assert.equal(next.version, before.version);
    assert.deepEqual(next.agents.metadataGeneration, before.agents.metadataGeneration);
  });

  test('a merge that would touch anything else is refused', () => {
    const before = JSON.parse(readFileSync(SAMPLE, 'utf8'));
    const tampered = structuredClone(before);
    tampered.daemon.mcp.injectIntoAgents = false;
    assert.throws(
      () => assertOnlyManagedKeysChanged(before, tampered),
      /outside the three/,
    );
  });

  test('the diff names exactly the three additions', () => {
    const before = JSON.parse(readFileSync(SAMPLE, 'utf8'));
    const { next } = mergeProviders(before, loadProviders(FRAGMENT, HOME));
    const diff = diffSummary(before, next);
    assert.deepEqual(diff.sort(), MANAGED_PROVIDER_IDS.map((id) => `+ agents.providers.${id}`).sort());
  });
});

describe('conflict handling', () => {
  test('an identical existing entry counts as unchanged, not a conflict', () => {
    const before = JSON.parse(readFileSync(SAMPLE, 'utf8'));
    const providers = loadProviders(FRAGMENT, HOME);
    const { next: once } = mergeProviders(before, providers);
    const { added, unchanged, conflicts } = mergeProviders(once, providers);
    assert.deepEqual(added, []);
    assert.deepEqual(conflicts, []);
    assert.deepEqual(unchanged.sort(), [...MANAGED_PROVIDER_IDS].sort());
  });

  test('a differing existing entry is a conflict unless forced', () => {
    const before = JSON.parse(readFileSync(SAMPLE, 'utf8'));
    const providers = loadProviders(FRAGMENT, HOME);
    const { next } = mergeProviders(before, providers);
    next.agents.providers['kiro-peer'].label = 'Hand edited';

    const blocked = mergeProviders(next, providers);
    assert.deepEqual(blocked.conflicts, ['kiro-peer']);

    const forced = mergeProviders(next, providers, { force: true });
    assert.deepEqual(forced.conflicts, []);
    assert.equal(forced.next.agents.providers['kiro-peer'].label, 'Kiro Peer');
  });
});

describe('merge script CLI', () => {
  test('a dry run writes nothing', () => {
    const target = freshTarget('dry');
    const original = readFileSync(target, 'utf8');
    const report = run({ fragment: FRAGMENT, target, home: HOME, dryRun: true, quiet: true });
    assert.equal(report.wrote, false);
    assert.equal(readFileSync(target, 'utf8'), original);
  });

  test('an apply writes the three providers and takes a backup', () => {
    const target = freshTarget('apply');
    const backupDir = join(sandbox, 'backup');
    const report = run({ fragment: FRAGMENT, target, home: HOME, quiet: true, backupDir });
    assert.equal(report.wrote, true);
    assert.deepEqual(report.added.sort(), [...MANAGED_PROVIDER_IDS].sort());
    assert.ok(existsSync(report.backup), 'backup missing');
    assert.equal(readFileSync(report.backup, 'utf8'), readFileSync(SAMPLE, 'utf8'));

    const after = JSON.parse(readFileSync(target, 'utf8'));
    for (const id of MANAGED_PROVIDER_IDS) assert.ok(after.agents.providers[id], id);
    for (const id of PRESERVED) assert.ok(after.agents.providers[id], `${id} disappeared`);
  });

  test('re-applying is idempotent and reports no change', () => {
    const target = freshTarget('idem');
    run({ fragment: FRAGMENT, target, home: HOME, quiet: true });
    const first = readFileSync(target, 'utf8');
    const report = run({ fragment: FRAGMENT, target, home: HOME, quiet: true });
    assert.equal(report.wrote, false);
    assert.equal(readFileSync(target, 'utf8'), first);
  });

  test('a missing target fails rather than creating one', () => {
    const target = join(sandbox, 'absent.json');
    assert.throws(
      () => run({ fragment: FRAGMENT, target, home: HOME, quiet: true }),
      /not found/,
    );
    assert.ok(!existsSync(target));
  });

  test('the CLI prints the daemon reload reminder after writing', () => {
    const target = freshTarget('cli');
    const out = execFileSync(
      process.execPath,
      [SCRIPT, '--fragment', FRAGMENT, '--target', target, '--home', HOME],
      { encoding: 'utf8' },
    );
    assert.match(out, /paseo daemon reload/);
    assert.match(out, /silently clobbered/);
    assert.match(out, /\+ agents\.providers\.kiro-lead/);
  });

  test('the CLI exits non-zero on a conflict', () => {
    const target = freshTarget('conflict');
    execFileSync(
      process.execPath,
      [SCRIPT, '--fragment', FRAGMENT, '--target', target, '--home', HOME, '--quiet'],
      { encoding: 'utf8' },
    );
    const config = JSON.parse(readFileSync(target, 'utf8'));
    config.agents.providers['kiro-lead'].label = 'Edited';
    writeFileSync(target, JSON.stringify(config, null, 2));

    assert.throws(() =>
      execFileSync(
        process.execPath,
        [SCRIPT, '--fragment', FRAGMENT, '--target', target, '--home', HOME, '--quiet'],
        { stdio: 'pipe' },
      ),
    );
  });

  test('no temp file is left behind', () => {
    const target = freshTarget('tmpcheck');
    run({ fragment: FRAGMENT, target, home: HOME, quiet: true });
    assert.ok(!existsSync(`${target}.kiro-room.tmp`));
  });
});
