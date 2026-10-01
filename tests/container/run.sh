#!/usr/bin/env bash
# Container acceptance test. Runs inside `make test-container`.
#
# Checks what a unit test cannot: that the public installer produces the right
# topology against a genuinely fresh operator home, that a second apply is safe,
# and that a rollback leaves nothing behind. It needs no Kiro credentials,
# because nothing here calls the model API — the routing check runs `--offline`
# against the captured catalog fixture.
#
# What this does NOT cover, and is therefore an operator check on a real host:
# authenticated Kiro sessions, the Paseo daemon accepting the three providers,
# whether the preToolUse hook fires on the ACP transport, and macOS specifics.

set -euo pipefail

readonly REPO=/repo
readonly WORK=/work
readonly FAKE_HOME="$WORK/home"

say() { printf '\n== %s\n' "$*"; }
fail() { printf 'CONTAINER_ACCEPTANCE_FAIL: %s\n' "$*" >&2; exit 1; }

say "Environment"
node --version
bash --version | head -1
# The slim base has no git. The installer needs it present, so install it from
# the pinned base's own apt snapshot rather than loosening the requirement.
if ! command -v git >/dev/null 2>&1; then
  apt-get update -qq >/dev/null 2>&1
  apt-get install -y -qq --no-install-recommends git >/dev/null 2>&1
fi
git --version || fail "git is required and could not be installed"

say "Building a fake operator home"
mkdir -p "$FAKE_HOME"/.kiro/{settings,skills,steering,powers,agents}
mkdir -p "$FAKE_HOME"/.paseo "$FAKE_HOME"/.local/bin
cp "$REPO/tests/fixtures/base-cli.json" "$FAKE_HOME/.kiro/settings/cli.json"
printf '{"mcpServers":{}}\n' > "$FAKE_HOME/.kiro/settings/mcp.json"
printf '# house style\n' > "$FAKE_HOME/.kiro/steering/house.md"
printf 'operator data, must survive\n' > "$FAKE_HOME/.kiro/OPERATOR_NOTE.md"
cp "$REPO/tests/fixtures/paseo-config.sample.json" "$FAKE_HOME/.paseo/config.json"

# The checkout is mounted read-only, so copy it somewhere writable. The installer
# itself only reads the checkout, but `npm test` writes nothing outside tmp and
# this keeps the two cases identical.
cp -R "$REPO" "$WORK/checkout"
cd "$WORK/checkout"

# Stand-ins for the two binaries the installer requires to be present. It checks
# presence, not behaviour, and the auth probe is skipped because HOME is
# redirected here: kiro-cli resolves its helper under $HOME/.local/bin, so
# probing login with a relocated HOME reports a false negative.
mkdir -p "$WORK/stubs"
printf '#!/bin/sh\necho "kiro-cli 2.26.0"\n' > "$WORK/stubs/kiro-cli"
printf '#!/bin/sh\necho "0.8.0"\n' > "$WORK/stubs/paseo"
chmod +x "$WORK/stubs/kiro-cli" "$WORK/stubs/paseo"

export PATH="$WORK/stubs:$FAKE_HOME/.local/bin:$PATH"
export HOME="$FAKE_HOME"
export KIRO_ROOM_SKIP_AUTH_CHECK=1

hash_home() { find "$FAKE_HOME" -type f -o -type l | sort | xargs -r shasum -a 256 2>/dev/null | shasum -a 256; }

say "Unit suite"
npm test >/dev/null 2>&1 || fail "npm test failed inside the container"
printf '  suite passed\n'

say "Source verification"
./scripts/verify --source >/dev/null || fail "scripts/verify --source failed"
printf '  source OK\n'

say "Offline routing check"
node scripts/preflight.mjs --offline >/dev/null || fail "preflight --offline failed"
printf '  preflight OK\n'

say "Plan mode must write nothing"
BEFORE="$(hash_home)"
./install >/dev/null || fail "plan mode exited non-zero"
[[ "$(hash_home)" == "$BEFORE" ]] || fail "plan mode modified the fake home"
[[ ! -d "$FAKE_HOME/.config/kiro-room" ]] || fail "plan mode created .config/kiro-room"
[[ ! -d "$FAKE_HOME/.kiro-runtime" ]] || fail "plan mode created .kiro-runtime"
printf '  nothing written\n'

say "Rollback must leave nothing behind"
KIRO_ROOM_FAIL_AFTER=providers ./install --apply >/dev/null 2>&1 && \
  fail "the injected failure did not fail the install"
[[ ! -d "$FAKE_HOME/.config/kiro-room" ]] || fail "rollback left .config/kiro-room"
[[ ! -d "$FAKE_HOME/.kiro-runtime" ]] || fail "rollback left .kiro-runtime"
[[ ! -e "$FAKE_HOME/.local/bin/kiro-room" ]] || fail "rollback left the launcher"
diff -q "$FAKE_HOME/.paseo/config.json" "$REPO/tests/fixtures/paseo-config.sample.json" \
  >/dev/null || fail "rollback did not restore the Paseo config"
[[ ! -e "$FAKE_HOME/.created" && ! -e "$FAKE_HOME/.created-roots" ]] || \
  fail "rollback left installer bookkeeping in HOME"
rm -rf "$FAKE_HOME/.kiro-room-backups"
printf '  rollback clean\n'

say "First apply"
./install --apply --quiet || fail "first apply failed"

say "Role inventory"
for role in supervisor lead peer; do
  agent="$FAKE_HOME/.kiro-runtime/$role/agents/kiro-$role.json"
  [[ -f $agent ]] || fail "missing $agent"
  node -e '
    const a = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const events = ["agentSpawn","userPromptSubmit","preToolUse","postToolUse","stop"];
    for (const e of events) {
      if (!Array.isArray(a.hooks?.[e])) { console.error("hooks." + e + " is not an array"); process.exit(1); }
    }
    if (a.tools.some((t) => ["delegate","subagent","agent","task"].includes(t))) {
      console.error("a delegation tool is exposed"); process.exit(1);
    }
    process.stdout.write(`  ${a.name.padEnd(18)} model=${a.model.padEnd(18)} tools=${a.tools.join(",")}\n`);
  ' "$agent" || fail "$role agent config is malformed"

  node -e '
    const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (s["chat.enableSubagent"] !== false) { console.error("enableSubagent not false"); process.exit(1); }
  ' "$FAKE_HOME/.kiro-runtime/$role/settings/cli.json" || fail "$role settings are wrong"
done

say "Paseo provider recipients"
node -e '
  const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const p = c.agents.providers;
  for (const id of ["kiro-supervisor","kiro-lead","kiro-peer"]) {
    if (!p[id]) { console.error("missing " + id); process.exit(1); }
    process.stdout.write(`  ${id.padEnd(18)} paseoTools=${p[id].paseoTools.enabled} models=${p[id].models.length}\n`);
  }
  for (const id of ["codex-supervisor","codex-lead","codex-peer","claude","codex","kiro"]) {
    if (!p[id]) { console.error("pre-existing provider lost: " + id); process.exit(1); }
  }
  process.stdout.write("  pre-existing providers preserved\n");
' "$FAKE_HOME/.paseo/config.json" || fail "provider merge is wrong"

say "Operator base home untouched"
[[ "$(cat "$FAKE_HOME/.kiro/OPERATOR_NOTE.md")" == "operator data, must survive" ]] || \
  fail "the installer modified ~/.kiro"
for f in kiro-supervisor kiro-lead kiro-peer; do
  [[ ! -e "$FAKE_HOME/.kiro/agents/$f.json" ]] || fail "a role config leaked into ~/.kiro/agents"
done
printf '  ~/.kiro intact\n'

say "Runtime tree"
find "$FAKE_HOME/.kiro-runtime" -maxdepth 2 | sort | sed "s|$FAKE_HOME|~|"

say "Second apply must be safe and preserve operator edits"
marker="$FAKE_HOME/.kiro-runtime/peer/sessions/keep-me.jsonl"
printf 'session data\n' > "$marker"
routing="$FAKE_HOME/.kiro-room/model-routing.local.json"
node -e '
  const fs = require("node:fs");
  const t = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  t.classes.FAST_READ.primary = "claude-sonnet-4.5";
  fs.writeFileSync(process.argv[1], JSON.stringify(t, null, 2) + "\n");
' "$routing"
config_before="$(shasum -a 256 < "$FAKE_HOME/.paseo/config.json")"

./install --apply --quiet || fail "second apply failed"

[[ "$(cat "$marker")" == "session data" ]] || fail "a session file was destroyed"
node -e '
  const t = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (t.classes.FAST_READ.primary !== "claude-sonnet-4.5") {
    console.error("the operator routing table was overwritten"); process.exit(1);
  }
' "$routing" || fail "routing table clobbered"
[[ "$(shasum -a 256 < "$FAKE_HOME/.paseo/config.json")" == "$config_before" ]] || \
  fail "the second apply rewrote the Paseo config"
printf '  repeat apply preserved operator state\n'

say "Installed-state verification"
./scripts/verify || fail "scripts/verify failed after apply"

say "Legacy-role rejection"
./install --apply --quiet >/dev/null 2>&1
if "$FAKE_HOME/.local/bin/kiro-room" architect >/dev/null 2>&1; then
  fail "the launcher accepted an unknown role"
fi
printf '  unknown role refused\n'

printf '\nCONTAINER_ACCEPTANCE_OK\n'
