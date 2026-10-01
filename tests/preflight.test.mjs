import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkRouting, checkDeployedPolicy, preflight } from '../scripts/preflight.mjs';
import { MODEL_CLASSES } from '../extensions/policy-core.mts';
import { policyDigest } from '../extensions/kiro-policy.mts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTING = join(REPO, 'config', 'model-routing.example.json');
const CATALOG = join(REPO, 'tests', 'fixtures', 'model-catalog.json');
const SCRIPT = join(REPO, 'scripts', 'preflight.mjs');

const KNOWN = JSON.parse(readFileSync(CATALOG, 'utf8')).models.map((m) => m.model_id);
const baseTable = () => JSON.parse(readFileSync(ROUTING, 'utf8'));

let sandbox;
before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'kiro-room-preflight-test.'));
});
after(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

describe('routing table checks', () => {
  test('the shipped table passes against the live catalog fixture', () => {
    assert.deepEqual(checkRouting(baseTable(), KNOWN), []);
  });

  test('every class in the table resolves to a real model id', () => {
    const table = baseTable();
    for (const cls of MODEL_CLASSES) {
      assert.ok(KNOWN.includes(table.classes[cls].primary), `${cls} primary`);
      assert.ok(KNOWN.includes(table.classes[cls].fallback), `${cls} fallback`);
    }
  });

  test('a one-character typo in an id fails and names the class', () => {
    const table = baseTable();
    table.classes.CODING_MEDIUM.primary = 'claude-sonnet-6';
    const problems = checkRouting(table, KNOWN);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /CODING_MEDIUM\.primary/);
    assert.match(problems[0], /not in the live catalog/);
  });

  test('a missing fallback fails', () => {
    const table = baseTable();
    delete table.classes.FAST_READ.fallback;
    const problems = checkRouting(table, KNOWN);
    assert.ok(problems.some((p) => p.includes('FAST_READ') && p.includes('no fallback')));
  });

  test('a missing class fails', () => {
    const table = baseTable();
    delete table.classes.REVIEW_HIGH;
    const problems = checkRouting(table, KNOWN);
    assert.ok(problems.some((p) => p.includes('REVIEW_HIGH') && p.includes('missing')));
  });

  test('a same-family REVIEW_HIGH fallback is rejected', () => {
    const table = baseTable();
    table.classes.REVIEW_HIGH.primary = 'gpt-5.6-sol';
    table.classes.REVIEW_HIGH.fallback = 'gpt-5.6-terra';
    const problems = checkRouting(table, KNOWN);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /REVIEW_HIGH/);
    assert.match(problems[0], /different family/);
  });

  test('a same-family fallback is tolerated outside REVIEW_HIGH', () => {
    const table = baseTable();
    table.classes.CODING_MEDIUM.primary = 'claude-sonnet-5';
    table.classes.CODING_MEDIUM.fallback = 'claude-opus-5';
    assert.deepEqual(checkRouting(table, KNOWN), []);
  });

  test('an open-weight id is rejected even though it exists in the catalog', () => {
    const table = baseTable();
    table.classes.MONITOR_ECONOMY.primary = 'qwen3-coder-next';
    assert.ok(KNOWN.includes('qwen3-coder-next'), 'fixture should contain the id');
    const problems = checkRouting(table, KNOWN);
    assert.ok(problems.some((p) => p.includes('only Claude and GPT')));
  });

  test('an unknown extra class is reported', () => {
    const table = baseTable();
    table.classes.CHEAP_HACK = { primary: 'claude-haiku-4.5', fallback: 'gpt-5.6-luna', reason: 'x'.repeat(30) };
    const problems = checkRouting(table, KNOWN);
    assert.ok(problems.some((p) => p.includes('unknown routing class: CHEAP_HACK')));
  });

  test('a class without a stated reason is rejected', () => {
    const table = baseTable();
    table.classes.FAST_READ.reason = 'cheap';
    const problems = checkRouting(table, KNOWN);
    assert.ok(problems.some((p) => p.includes('FAST_READ') && p.includes('reason')));
  });

  test('a missing role default is reported', () => {
    const table = baseTable();
    delete table.roleDefaults.peer;
    const problems = checkRouting(table, KNOWN);
    assert.ok(problems.some((p) => p.includes('roleDefaults.peer')));
  });

  test('the fallback policy must document triggers and the recording obligation', () => {
    const noTriggers = baseTable();
    noTriggers.fallbackPolicy.triggers = [];
    assert.ok(checkRouting(noTriggers, KNOWN).some((p) => p.includes('triggers')));

    const noObligation = baseTable();
    delete noObligation.fallbackPolicy.obligation;
    assert.ok(checkRouting(noObligation, KNOWN).some((p) => p.includes('obligation')));
  });
});

describe('policy drift detection', () => {
  test('an absent runtime root is reported, not failed', () => {
    const result = checkDeployedPolicy(join(sandbox, 'nothing-here'), policyDigest());
    assert.deepEqual(result.problems, []);
    assert.match(result.note, /not present/);
  });

  test('matching digests pass', () => {
    const root = join(sandbox, 'rt-match');
    const stateDir = join(root, 'peer', 'kiro-room-state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 's1.json'),
      JSON.stringify({ sessionId: 's1', role: 'peer', brief: { kind: 'none' }, policyDigest: policyDigest() }),
    );
    const result = checkDeployedPolicy(root, policyDigest());
    assert.deepEqual(result.problems, []);
    assert.equal(result.checked, 1);
  });

  test('a stale digest fails and says what to do about it', () => {
    const root = join(sandbox, 'rt-drift');
    const stateDir = join(root, 'lead', 'kiro-room-state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 's1.json'),
      JSON.stringify({ sessionId: 's1', role: 'lead', brief: { kind: 'none' }, policyDigest: 'deadbeefdeadbeef' }),
    );
    const result = checkDeployedPolicy(root, policyDigest());
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /drifted/);
    assert.match(result.problems[0], /install --apply/);
    assert.match(result.findings[0], /deadbeefdeadbeef/);
  });

  test('a corrupt record does not crash the check', () => {
    const root = join(sandbox, 'rt-corrupt');
    const stateDir = join(root, 'peer', 'kiro-room-state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'bad.json'), 'not json');
    assert.doesNotThrow(() => checkDeployedPolicy(root, policyDigest()));
  });
});

describe('preflight end to end', () => {
  test('offline preflight on the shipped table succeeds', () => {
    const report = preflight({
      offline: true,
      routing: ROUTING,
      runtimeRoot: join(sandbox, 'no-runtime'),
    });
    assert.equal(report.ok, true, JSON.stringify(report.problems));
    assert.equal(report.catalogSize, KNOWN.length);
    assert.match(report.policyDigest, /^[0-9a-f]{16}$/);
  });

  test('the CLI exits 0 and prints the resolved routes', () => {
    const out = execFileSync(
      process.execPath,
      [SCRIPT, '--offline', '--routing', ROUTING, '--runtime-root', join(sandbox, 'none')],
      { encoding: 'utf8' },
    );
    assert.match(out, /preflight OK/);
    assert.match(out, /REVIEW_HIGH\s+gpt-5\.6-sol\s+\(gpt\)\s+->\s+claude-opus-5\s+\(claude\)/);
    for (const cls of MODEL_CLASSES) assert.match(out, new RegExp(cls));
  });

  test('a sabotaged table makes the CLI exit non-zero and name the class', () => {
    const bad = join(sandbox, 'bad-routing.json');
    const table = baseTable();
    table.classes.REASONING_HIGH.primary = 'claude-opus-99';
    writeFileSync(bad, JSON.stringify(table, null, 2));

    let status = 0;
    let stderr = '';
    try {
      execFileSync(
        process.execPath,
        [SCRIPT, '--offline', '--routing', bad, '--runtime-root', join(sandbox, 'none')],
        { encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (error) {
      status = error.status;
      stderr = error.stderr;
    }
    assert.equal(status, 1);
    assert.match(stderr, /preflight FAILED/);
    assert.match(stderr, /REASONING_HIGH\.primary/);
    assert.match(stderr, /claude-opus-99/);
  });

  test('--json emits a machine-readable report', () => {
    const out = execFileSync(
      process.execPath,
      [SCRIPT, '--offline', '--json', '--routing', ROUTING, '--runtime-root', join(sandbox, 'none')],
      { encoding: 'utf8' },
    );
    const report = JSON.parse(out);
    assert.equal(report.ok, true);
    assert.deepEqual(Object.keys(report.resolved).sort(), [...MODEL_CLASSES].sort());
  });

  test('a missing routing table exits 2, distinct from a validation failure', () => {
    let status = 0;
    try {
      execFileSync(process.execPath, [SCRIPT, '--offline', '--routing', '/nope/nope.json'], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, HOME: join(sandbox, 'empty-home') },
      });
    } catch (error) {
      status = error.status;
    }
    assert.equal(status, 2);
  });
});
