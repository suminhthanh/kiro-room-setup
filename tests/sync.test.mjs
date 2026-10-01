import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { ROLES, ROLE_PROFILES } from '../extensions/policy-core.mts';
import {
  SETTINGS_ALLOWLIST,
  FORCED_SETTINGS,
  buildSettings,
  buildAgentConfig,
  loadOverlay,
  syncRole,
} from '../extensions/room-runtime.mts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_SRC = join(REPO, 'home', '.config', 'kiro-room');
const SYNC_BIN = join(REPO, 'home', '.local', 'bin', 'kiro-room-sync');
const ROUTING = join(REPO, 'config', 'model-routing.example.json');

let sandbox;
let fakeHome;
let baseHome;
let configDir;
let runtimeRoot;

function hashTree(root) {
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
      } else {
        entries.push(`F ${rel} ${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
      }
    }
  };
  walk(root, '');
  return entries.join('\n');
}

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'kiro-room-sync-test.'));
  fakeHome = join(sandbox, 'home');
  baseHome = join(fakeHome, '.kiro');
  configDir = join(fakeHome, '.config', 'kiro-room');
  runtimeRoot = join(fakeHome, '.kiro-runtime');

  // Operator base home, built from a fixture rather than copied from the real
  // ~/.kiro so the suite never reads the host's configuration.
  mkdirSync(join(baseHome, 'settings'), { recursive: true });
  mkdirSync(join(baseHome, 'skills'), { recursive: true });
  mkdirSync(join(baseHome, 'steering'), { recursive: true });
  mkdirSync(join(baseHome, 'powers'), { recursive: true });
  cpSync(join(REPO, 'tests', 'fixtures', 'base-cli.json'), join(baseHome, 'settings', 'cli.json'));
  writeFileSync(join(baseHome, 'settings', 'mcp.json'), '{"mcpServers":{}}\n');
  writeFileSync(join(baseHome, 'steering', 'house-style.md'), '# house style\n');

  // Installed config layout.
  cpSync(CONFIG_SRC, configDir, { recursive: true });
  mkdirSync(join(configDir, 'extensions'), { recursive: true });
  for (const f of ['policy-core.mts', 'kiro-policy.mts', 'room-runtime.mts', 'kiro-room-hook.mjs']) {
    cpSync(join(REPO, 'extensions', f), join(configDir, 'extensions', f));
  }
  cpSync(ROUTING, join(configDir, 'model-routing.example.json'));
});

after(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

describe('settings generation', () => {
  test('the overlay may only replace allowlisted keys', () => {
    const base = { 'chat.defaultModel': 'auto', 'telemetry.enabled': true };
    const overlay = {
      role: 'peer',
      label: 'x',
      description: 'x',
      modelClass: 'CODING_MEDIUM',
      effort: 'medium',
      settings: { 'chat.defaultModel': 'claude-sonnet-5', 'telemetry.enabled': false },
    };
    const out = buildSettings(base, overlay, 'peer');
    assert.equal(out['chat.defaultModel'], 'claude-sonnet-5', 'allowlisted key applied');
    assert.equal(out['telemetry.enabled'], true, 'non-allowlisted key must not be overridden');
  });

  test('base keys outside the allowlist are preserved untouched', () => {
    const base = { 'chat.enableNotifications': true, 'some.operator.key': 'keep me' };
    const out = buildSettings(base, loadOverlay(configDir, 'peer'), 'peer');
    assert.equal(out['some.operator.key'], 'keep me');
  });

  test('defaultAgent is forced to the role agent and subagent is forced off', () => {
    for (const role of ROLES) {
      const out = buildSettings(
        { 'chat.enableSubagent': true },
        loadOverlay(configDir, role),
        role,
      );
      assert.equal(out['chat.defaultAgent'], `kiro-${role}`);
      assert.equal(out['chat.enableSubagent'], false, 'native delegation must stay off');
    }
  });

  test('a forced setting cannot be re-enabled by an overlay', () => {
    const overlay = {
      ...loadOverlay(configDir, 'peer'),
      settings: { 'chat.enableSubagent': true },
    };
    const out = buildSettings({}, overlay, 'peer');
    assert.equal(out['chat.enableSubagent'], false);
    assert.ok(!SETTINGS_ALLOWLIST.includes('chat.enableSubagent'));
    assert.equal(FORCED_SETTINGS['chat.enableSubagent'], false);
  });
});

describe('agent config generation', () => {
  const opts = (role) => ({
    role,
    baseHome: '/base',
    runtimeHome: `/rt/${role}`,
    configDir: '/cfg',
    model: 'claude-sonnet-5',
    hookPath: '/cfg/extensions/kiro-room-hook.mjs',
  });

  test('hooks are emitted in array form for all five events', () => {
    const agent = buildAgentConfig(opts('peer'), loadOverlay(configDir, 'peer'));
    for (const event of ['agentSpawn', 'userPromptSubmit', 'preToolUse', 'postToolUse', 'stop']) {
      assert.ok(Array.isArray(agent.hooks[event]), `${event} must be an array`);
      assert.equal(agent.hooks[event].length, 1);
      assert.match(agent.hooks[event][0].command, /kiro-room-hook\.mjs/);
    }
  });

  test('the prompt is a file:// URI resolved against the agents directory', () => {
    const agent = buildAgentConfig(opts('lead'), loadOverlay(configDir, 'lead'));
    assert.equal(agent.prompt, 'file://../prompts/lead.md');
  });

  test('tools match the role profile and never include a delegation tool', () => {
    for (const role of ROLES) {
      const agent = buildAgentConfig(opts(role), loadOverlay(configDir, role));
      assert.deepEqual(agent.tools, ROLE_PROFILES[role].tools);
      for (const forbidden of ['delegate', 'subagent', 'agent', 'task']) {
        assert.ok(!agent.tools.includes(forbidden), `${role} must not list ${forbidden}`);
      }
    }
  });

  test('the Supervisor agent has no write tool', () => {
    const agent = buildAgentConfig(opts('supervisor'), loadOverlay(configDir, 'supervisor'));
    assert.ok(!agent.tools.includes('write'));
  });

  test('permissions.rules is emitted but documented as unenforced on 2.x', () => {
    const agent = buildAgentConfig(opts('peer'), loadOverlay(configDir, 'peer'));
    const rules = agent.permissions.rules;
    assert.ok(rules.some((r) => r.capability === 'subagent' && r.effect === 'deny'));
    assert.ok(rules.some((r) => r.capability === 'fs_write' && r.effect === 'deny'));
    // The generator must state in-file that this field is inert on 2.x, so a
    // future reader does not mistake it for the enforcement layer.
    const source = readFileSync(join(REPO, 'extensions', 'room-runtime.mts'), 'utf8');
    assert.ok(
      source.includes('ignored at runtime') || source.includes('is then ignored'),
      'room-runtime.mts must document that permissions.rules is inert on CLI 2.x',
    );
  });

  test('the model is the one the caller resolved, not a default', () => {
    const agent = buildAgentConfig({ ...opts('peer'), model: 'gpt-5.6-terra' }, loadOverlay(configDir, 'peer'));
    assert.equal(agent.model, 'gpt-5.6-terra');
  });
});

describe('syncRole on a fake HOME', () => {
  test('generates the expected tree for every role', () => {
    for (const role of ROLES) {
      const result = syncRole({
        role,
        baseHome,
        runtimeHome: join(runtimeRoot, role),
        configDir,
        model: 'claude-sonnet-5',
        hookPath: join(configDir, 'extensions', 'kiro-room-hook.mjs'),
      });
      assert.ok(existsSync(result.agentPath), `${role} agent config missing`);
      assert.ok(existsSync(join(result.runtimeHome, 'settings', 'cli.json')));
      assert.ok(existsSync(join(result.runtimeHome, 'prompts', `${role}.md`)));
      assert.ok(existsSync(join(result.runtimeHome, 'kiro-room.json')));
      assert.ok(existsSync(join(result.runtimeHome, 'sessions')));
      assert.ok(existsSync(join(result.runtimeHome, 'kiro-room-state')));
    }
  });

  test('shared operator directories are symlinked, not copied', () => {
    for (const role of ROLES) {
      for (const rel of ['skills', 'steering', 'powers', 'settings/mcp.json']) {
        const link = join(runtimeRoot, role, rel);
        assert.ok(lstatSync(link).isSymbolicLink(), `${link} should be a symlink`);
        assert.equal(readlinkSync(link), join(baseHome, rel));
      }
    }
  });

  test('no symlink escapes the operator base home', () => {
    for (const role of ROLES) {
      for (const rel of ['skills', 'steering', 'powers', 'settings/mcp.json']) {
        const target = readlinkSync(join(runtimeRoot, role, rel));
        assert.ok(
          target === baseHome || target.startsWith(`${baseHome}/`),
          `${target} must live under ${baseHome}`,
        );
      }
    }
  });

  test('a second sync is byte-identical and reports nothing written', () => {
    const before = hashTree(runtimeRoot);
    const results = ROLES.map((role) =>
      syncRole({
        role,
        baseHome,
        runtimeHome: join(runtimeRoot, role),
        configDir,
        model: 'claude-sonnet-5',
        hookPath: join(configDir, 'extensions', 'kiro-room-hook.mjs'),
      }),
    );
    assert.equal(hashTree(runtimeRoot), before, 'runtime tree changed on re-sync');
    for (const r of results) {
      assert.deepEqual(r.written, [], `${r.role} rewrote files on an unchanged sync`);
    }
  });

  test('the operator base home is never modified', () => {
    const baseBefore = hashTree(baseHome);
    syncRole({
      role: 'peer',
      baseHome,
      runtimeHome: join(runtimeRoot, 'peer'),
      configDir,
      model: 'gpt-5.6-terra',
      hookPath: join(configDir, 'extensions', 'kiro-room-hook.mjs'),
    });
    assert.equal(hashTree(baseHome), baseBefore, 'sync wrote into the operator base home');
  });

  test('generating into the base home is refused', () => {
    assert.throws(
      () =>
        syncRole({
          role: 'peer',
          baseHome,
          runtimeHome: join(baseHome, 'runtime'),
          configDir,
          model: 'claude-sonnet-5',
          hookPath: 'x',
        }),
      /inside the operator base home/,
    );
  });

  test('an absent shared target is skipped rather than fabricated', () => {
    const bare = join(sandbox, 'bare-base');
    mkdirSync(join(bare, 'settings'), { recursive: true });
    writeFileSync(join(bare, 'settings', 'cli.json'), '{}\n');
    const result = syncRole({
      role: 'peer',
      baseHome: bare,
      runtimeHome: join(sandbox, 'bare-runtime', 'peer'),
      configDir,
      model: 'claude-sonnet-5',
      hookPath: 'x',
    });
    assert.ok(result.skippedLinks.length >= 3, 'absent targets should be reported as skipped');
    assert.ok(!existsSync(join(sandbox, 'bare-runtime', 'peer', 'skills')));
  });

  test('a real file in place of a shared link is not destroyed', () => {
    const rt = join(sandbox, 'guard-runtime', 'peer');
    mkdirSync(join(rt, 'settings'), { recursive: true });
    writeFileSync(join(rt, 'settings', 'mcp.json'), '{"operator":"data"}\n');
    const result = syncRole({
      role: 'peer',
      baseHome,
      runtimeHome: rt,
      configDir,
      model: 'claude-sonnet-5',
      hookPath: 'x',
    });
    assert.equal(readFileSync(join(rt, 'settings', 'mcp.json'), 'utf8'), '{"operator":"data"}\n');
    assert.ok(result.skippedLinks.some((s) => s.includes('real file present')));
  });

  test('the routing class effort overrides the overlay effort', () => {
    const rt = join(sandbox, 'effort-runtime', 'peer');
    syncRole({
      role: 'peer',
      baseHome,
      runtimeHome: rt,
      configDir,
      model: 'claude-sonnet-5',
      effort: 'xhigh',
      hookPath: 'x',
    });
    const stamp = JSON.parse(readFileSync(join(rt, 'kiro-room.json'), 'utf8'));
    assert.equal(stamp.effort, 'xhigh', 'the caller-supplied effort should win');

    // Absent an override the overlay value is used, so an older routing table
    // that predates the per-class field still produces a usable runtime.
    const rt2 = join(sandbox, 'effort-runtime-2', 'peer');
    syncRole({
      role: 'peer',
      baseHome,
      runtimeHome: rt2,
      configDir,
      model: 'claude-sonnet-5',
      hookPath: 'x',
    });
    const overlayEffort = loadOverlay(configDir, 'peer').effort;
    assert.equal(JSON.parse(readFileSync(join(rt2, 'kiro-room.json'), 'utf8')).effort, overlayEffort);
  });

  test('an unknown role is refused', () => {
    assert.throws(
      () => syncRole({ role: 'admin', baseHome, runtimeHome: join(sandbox, 'x'), configDir, model: 'm', hookPath: 'h' }),
      /unknown role/,
    );
  });
});

describe('kiro-room-sync CLI', () => {
  const env = () => ({
    ...process.env,
    HOME: fakeHome,
    KIRO_ROOM_CONFIG_DIR: configDir,
    KIRO_ROOM_BASE_HOME: baseHome,
    KIRO_ROOM_RUNTIME_ROOT: join(sandbox, 'cli-runtime'),
    KIRO_ROOM_ROUTING: ROUTING,
  });

  test('--all generates three runtimes with the routed model per role', () => {
    const out = execFileSync(process.execPath, [SYNC_BIN, '--all'], {
      env: env(),
      encoding: 'utf8',
    });
    assert.match(out, /supervisor:.*model gpt-5\.6-luna/);
    assert.match(out, /lead:.*model claude-opus-5/);
    assert.match(out, /peer:.*model claude-sonnet-5/);
    // Effort must come from the routing class, not the overlay, so the table is
    // the single place a cost/depth decision is recorded.
    const routing = JSON.parse(readFileSync(ROUTING, 'utf8'));
    for (const role of ROLES) {
      const cls = routing.roleDefaults[role];
      const stamp = JSON.parse(
        readFileSync(join(sandbox, 'cli-runtime', role, 'kiro-room.json'), 'utf8'),
      );
      assert.equal(stamp.effort, routing.classes[cls].effort, `${role} effort`);
    }
    for (const role of ROLES) {
      const stamp = JSON.parse(
        readFileSync(join(sandbox, 'cli-runtime', role, 'kiro-room.json'), 'utf8'),
      );
      assert.equal(stamp.role, role);
      assert.ok(stamp.model);
      assert.ok(stamp.effort);
    }
  });

  test('a second --all run reports everything already up to date', () => {
    const out = execFileSync(process.execPath, [SYNC_BIN, '--all'], {
      env: env(),
      encoding: 'utf8',
    });
    const upToDate = out.split('\n').filter((l) => l.includes('already up to date'));
    assert.equal(upToDate.length, ROLES.length, out);
  });

  test('an unknown role exits non-zero', () => {
    assert.throws(() =>
      execFileSync(process.execPath, [SYNC_BIN, 'admin'], { env: env(), stdio: 'pipe' }),
    );
  });

  test('no arguments exits non-zero with usage', () => {
    assert.throws(() => execFileSync(process.execPath, [SYNC_BIN], { env: env(), stdio: 'pipe' }));
  });
});
