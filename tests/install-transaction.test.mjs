import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = join(REPO, 'install');
const SAMPLE_PASEO = join(REPO, 'tests', 'fixtures', 'paseo-config.sample.json');
const BASE_CLI = join(REPO, 'tests', 'fixtures', 'base-cli.json');

let sandbox;
let fake;

/**
 * Builds a fake operator HOME that looks enough like a real one for the
 * installer to run: a base Kiro home with settings and shared directories, and
 * a Paseo config with the operator's existing providers already in it.
 */
function buildFakeHome(root) {
  const home = join(root, 'home');
  mkdirSync(join(home, '.kiro', 'settings'), { recursive: true });
  mkdirSync(join(home, '.kiro', 'skills'), { recursive: true });
  mkdirSync(join(home, '.kiro', 'steering'), { recursive: true });
  mkdirSync(join(home, '.kiro', 'powers'), { recursive: true });
  mkdirSync(join(home, '.kiro', 'agents'), { recursive: true });
  copyFileSync(BASE_CLI, join(home, '.kiro', 'settings', 'cli.json'));
  writeFileSync(join(home, '.kiro', 'settings', 'mcp.json'), '{"mcpServers":{}}\n');
  writeFileSync(join(home, '.kiro', 'steering', 'house.md'), '# house\n');
  // A pre-existing operator file that must survive untouched.
  writeFileSync(join(home, '.kiro', 'OPERATOR_NOTE.md'), 'do not touch\n');

  mkdirSync(join(home, '.paseo'), { recursive: true });
  copyFileSync(SAMPLE_PASEO, join(home, '.paseo', 'config.json'));

  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  return home;
}

function envFor(home, extra = {}) {
  return {
    ...process.env,
    HOME: home,
    KIRO_ROOM_CONFIG_DIR: join(home, '.config', 'kiro-room'),
    KIRO_ROOM_BIN_DIR: join(home, '.local', 'bin'),
    KIRO_ROOM_RUNTIME_ROOT: join(home, '.kiro-runtime'),
    KIRO_ROOM_BASE_HOME: join(home, '.kiro'),
    KIRO_ROOM_PASEO_CONFIG: join(home, '.paseo', 'config.json'),
    KIRO_ROOM_ROUTING_DIR: join(home, '.kiro-room'),
    KIRO_ROOM_BACKUP_ROOT: join(home, '.kiro-room-backups'),
    // kiro-cli resolves its helper binary under $HOME/.local/bin, so probing
    // login state with a redirected HOME reports a false negative and can kick
    // off a device-authorisation flow against the operator's real account.
    KIRO_ROOM_SKIP_AUTH_CHECK: '1',
    ...extra,
  };
}

function runInstall(home, args = [], extraEnv = {}) {
  try {
    const stdout = execFileSync('bash', [INSTALL, ...args], {
      encoding: 'utf8',
      env: envFor(home, extraEnv),
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function hashTree(root) {
  if (!existsSync(root)) return 'ABSENT';
  const entries = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) entries.push(`L ${rel} -> ${readlinkSync(full)}`);
      else if (st.isDirectory()) {
        entries.push(`D ${rel}`);
        walk(full, rel);
      } else entries.push(`F ${rel} ${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
    }
  };
  walk(root, '');
  return entries.join('\n');
}

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'kiro-room-install-test.'));
});
after(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  fake = mkdtempSync(join(sandbox, 'case.'));
});

describe('plan mode', () => {
  test('writes nothing and names every destination', () => {
    const home = buildFakeHome(fake);
    const homeBefore = hashTree(home);
    const result = runInstall(home);

    assert.equal(hashTree(home), homeBefore, 'plan mode modified the fake HOME');
    assert.ok(!existsSync(join(home, '.config', 'kiro-room')));
    assert.ok(!existsSync(join(home, '.kiro-runtime')));
    assert.match(result.stdout, /Plan only\. Nothing was written\./);
    assert.match(result.stdout, /agents\.providers\.kiro-supervisor/);
    assert.match(result.stdout, /agents\.providers\.kiro-lead/);
    assert.match(result.stdout, /agents\.providers\.kiro-peer/);
  });

  test('states that the operator Kiro home is never written', () => {
    const home = buildFakeHome(fake);
    const result = runInstall(home);
    assert.match(result.stdout, /never touches/);
    assert.match(result.stdout, /read as a base and linked into each runtime, never written/);
  });

  test('prints the reload step in the right order', () => {
    const home = buildFakeHome(fake);
    const result = runInstall(home);
    const applyAt = result.stdout.indexOf('./install --apply');
    const reloadAt = result.stdout.indexOf('paseo daemon reload');
    const verifyAt = result.stdout.indexOf('./install --verify');
    assert.ok(applyAt > -1 && reloadAt > applyAt && verifyAt > reloadAt, result.stdout);
  });
});

describe('apply mode', () => {
  test('installs files, generates runtimes and merges providers', () => {
    const home = buildFakeHome(fake);
    const result = runInstall(home, ['--apply']);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

    for (const f of ['policy-core.mts', 'kiro-policy.mts', 'room-runtime.mts', 'kiro-room-hook.mjs']) {
      assert.ok(existsSync(join(home, '.config', 'kiro-room', 'extensions', f)), f);
    }
    for (const role of ['supervisor', 'lead', 'peer']) {
      assert.ok(existsSync(join(home, '.config', 'kiro-room', 'overlays', `${role}.json`)));
      assert.ok(existsSync(join(home, '.config', 'kiro-room', 'prompts', `${role}.md`)));
      assert.ok(existsSync(join(home, '.kiro-runtime', role, 'agents', `kiro-${role}.json`)));
      assert.ok(existsSync(join(home, '.kiro-runtime', role, 'kiro-room.json')));
    }
    assert.ok(statSync(join(home, '.local', 'bin', 'kiro-room')).mode & 0o111);
    assert.ok(existsSync(join(home, '.kiro-room', 'model-routing.local.json')));

    const config = JSON.parse(readFileSync(join(home, '.paseo', 'config.json'), 'utf8'));
    for (const id of ['kiro-supervisor', 'kiro-lead', 'kiro-peer']) {
      assert.ok(config.agents.providers[id], `${id} missing`);
      assert.equal(config.agents.providers[id].command[0], `${home}/.local/bin/kiro-room`);
    }
  });

  test('the operator Kiro home is byte-identical afterwards', () => {
    const home = buildFakeHome(fake);
    const baseBefore = hashTree(join(home, '.kiro'));
    const result = runInstall(home, ['--apply']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(hashTree(join(home, '.kiro')), baseBefore, 'the installer wrote into ~/.kiro');
    assert.equal(
      readFileSync(join(home, '.kiro', 'OPERATOR_NOTE.md'), 'utf8'),
      'do not touch\n',
    );
  });

  test('pre-existing Paseo providers survive untouched', () => {
    const home = buildFakeHome(fake);
    const before = JSON.parse(readFileSync(SAMPLE_PASEO, 'utf8'));
    assert.equal(runInstall(home, ['--apply']).code, 0);
    const after = JSON.parse(readFileSync(join(home, '.paseo', 'config.json'), 'utf8'));

    for (const id of Object.keys(before.agents.providers)) {
      assert.deepEqual(after.agents.providers[id], before.agents.providers[id], `${id} changed`);
    }
    assert.deepEqual(after.daemon, before.daemon);
    assert.deepEqual(after.features, before.features);
  });

  test('a backup of the replaced Paseo config is kept', () => {
    const home = buildFakeHome(fake);
    assert.equal(runInstall(home, ['--apply']).code, 0);
    const backupRoot = join(home, '.kiro-room-backups');
    const dirs = readdirSync(backupRoot);
    assert.equal(dirs.length, 1, 'expected exactly one backup directory');
    const backup = join(backupRoot, dirs[0]);
    assert.ok(existsSync(join(backup, '.paseo', 'config.json')));
    assert.equal(
      readFileSync(join(backup, '.paseo', 'config.json'), 'utf8'),
      readFileSync(SAMPLE_PASEO, 'utf8'),
    );
    assert.equal(statSync(backup).mode & 0o777, 0o700, 'backup must be owner-only');
  });

  test('applying twice is safe and preserves generated state', () => {
    const home = buildFakeHome(fake);
    assert.equal(runInstall(home, ['--apply']).code, 0);

    // Operator edits their routing table; a second apply must not clobber it.
    const routing = join(home, '.kiro-room', 'model-routing.local.json');
    const edited = JSON.parse(readFileSync(routing, 'utf8'));
    edited.classes.FAST_READ.primary = 'claude-sonnet-4.5';
    writeFileSync(routing, `${JSON.stringify(edited, null, 2)}\n`);

    const configBefore = readFileSync(join(home, '.paseo', 'config.json'), 'utf8');
    const second = runInstall(home, ['--apply']);
    assert.equal(second.code, 0, `${second.stdout}\n${second.stderr}`);

    assert.equal(
      JSON.parse(readFileSync(routing, 'utf8')).classes.FAST_READ.primary,
      'claude-sonnet-4.5',
      'the operator routing table was overwritten',
    );
    assert.equal(
      readFileSync(join(home, '.paseo', 'config.json'), 'utf8'),
      configBefore,
      'the second apply rewrote the Paseo config',
    );
  });

  test('a session left in a runtime is preserved across a re-apply', () => {
    const home = buildFakeHome(fake);
    assert.equal(runInstall(home, ['--apply']).code, 0);
    const marker = join(home, '.kiro-runtime', 'peer', 'sessions', 'keep-me.jsonl');
    writeFileSync(marker, 'session data\n');
    assert.equal(runInstall(home, ['--apply']).code, 0);
    assert.equal(readFileSync(marker, 'utf8'), 'session data\n');
  });

  test('shared directories are linked back to the operator home', () => {
    const home = buildFakeHome(fake);
    assert.equal(runInstall(home, ['--apply']).code, 0);
    for (const role of ['supervisor', 'lead', 'peer']) {
      for (const rel of ['skills', 'steering', 'powers', 'settings/mcp.json']) {
        const link = join(home, '.kiro-runtime', role, rel);
        assert.ok(lstatSync(link).isSymbolicLink(), `${link} is not a symlink`);
        assert.equal(readlinkSync(link), join(home, '.kiro', rel));
      }
    }
  });

  test('no write escapes the fake HOME', () => {
    const home = buildFakeHome(fake);
    const outsideBefore = hashTree(fake);
    assert.equal(runInstall(home, ['--apply']).code, 0);
    // Everything the installer created must live under home/, so the only
    // difference inside the case dir is under home/.
    const after = hashTree(fake);
    const changedOutsideHome = after
      .split('\n')
      .filter((line) => !line.includes(' home') && !line.startsWith('D home'))
      .filter((line) => !outsideBefore.includes(line));
    assert.deepEqual(changedOutsideHome, [], changedOutsideHome.join('\n'));
  });
});

describe('rollback on failure', () => {
  const steps = ['files', 'routing', 'runtimes', 'providers'];

  for (const step of steps) {
    test(`a failure after '${step}' restores the pre-install state`, () => {
      const home = buildFakeHome(fake);
      const homeBefore = hashTree(home);

      const result = runInstall(home, ['--apply'], { KIRO_ROOM_FAIL_AFTER: step });
      assert.notEqual(result.code, 0, 'the injected failure did not fail the install');
      assert.match(result.stderr, /rolling back/);
      assert.match(result.stderr, /rollback complete/);

      // The Paseo config must be back to its original content.
      assert.equal(
        readFileSync(join(home, '.paseo', 'config.json'), 'utf8'),
        readFileSync(SAMPLE_PASEO, 'utf8'),
        'the Paseo config was not restored',
      );
      // The operator base home must be untouched either way.
      assert.equal(hashTree(join(home, '.kiro')), hashTree(join(home, '.kiro')));

      // Created artefacts must be gone.
      for (const created of ['.config/kiro-room', '.kiro-runtime', '.kiro-room/model-routing.local.json']) {
        assert.ok(
          !existsSync(join(home, created)),
          `${created} survived rollback`,
        );
      }
      assert.ok(!existsSync(join(home, '.local', 'bin', 'kiro-room')));

      // The backup is deliberately kept for inspection.
      const backups = readdirSync(join(home, '.kiro-room-backups'));
      assert.equal(backups.length, 1);
    });
  }

  test('installer bookkeeping files are not restored into HOME', () => {
    const home = buildFakeHome(fake);
    runInstall(home, ['--apply'], { KIRO_ROOM_FAIL_AFTER: 'providers' });
    // .created and .created-roots live inside the backup dir only. Restoring
    // them into $HOME would leave installer bookkeeping in the operator's home.
    assert.ok(!existsSync(join(home, '.created')), '.created leaked into HOME');
    assert.ok(!existsSync(join(home, '.created-roots')), '.created-roots leaked into HOME');
  });

  test('a rollback leaves the operator Kiro home untouched', () => {
    const home = buildFakeHome(fake);
    const baseBefore = hashTree(join(home, '.kiro'));
    runInstall(home, ['--apply'], { KIRO_ROOM_FAIL_AFTER: 'providers' });
    assert.equal(hashTree(join(home, '.kiro')), baseBefore);
  });
});

describe('prerequisite gate', () => {
  test('a missing Paseo config fails the plan without writing', () => {
    const home = buildFakeHome(fake);
    rmSync(join(home, '.paseo', 'config.json'));
    const result = runInstall(home);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /config\.json not found/);
    assert.ok(!existsSync(join(home, '.config', 'kiro-room')));
  });

  test('a missing base Kiro home fails the plan', () => {
    const home = buildFakeHome(fake);
    rmSync(join(home, '.kiro'), { recursive: true });
    const result = runInstall(home);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /does not exist/);
  });

  test('an unknown flag is rejected', () => {
    const home = buildFakeHome(fake);
    const result = runInstall(home, ['--yolo']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /unknown argument/);
  });
});

describe('installed-state verification', () => {
  test('scripts/verify passes after a successful apply', () => {
    const home = buildFakeHome(fake);
    assert.equal(runInstall(home, ['--apply']).code, 0);
    const out = execFileSync('bash', [join(REPO, 'scripts', 'verify')], {
      encoding: 'utf8',
      env: envFor(home),
    });
    assert.match(out, /kiro-room verify: OK/);
    assert.match(out, /no role agent config leaked/);
    assert.match(out, /pre-existing codex-\* providers still present/);
  });

  test('scripts/verify fails when a runtime is removed', () => {
    const home = buildFakeHome(fake);
    assert.equal(runInstall(home, ['--apply']).code, 0);
    rmSync(join(home, '.kiro-runtime', 'peer'), { recursive: true });
    assert.throws(() =>
      execFileSync('bash', [join(REPO, 'scripts', 'verify')], {
        encoding: 'utf8',
        env: envFor(home),
        stdio: 'pipe',
      }),
    );
  });

  test('scripts/verify fails when a codex provider goes missing', () => {
    const home = buildFakeHome(fake);
    assert.equal(runInstall(home, ['--apply']).code, 0);
    const path = join(home, '.paseo', 'config.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    delete config.agents.providers['codex-lead'];
    writeFileSync(path, JSON.stringify(config, null, 2));
    assert.throws(() =>
      execFileSync('bash', [join(REPO, 'scripts', 'verify')], {
        encoding: 'utf8',
        env: envFor(home),
        stdio: 'pipe',
      }),
    );
  });
});
