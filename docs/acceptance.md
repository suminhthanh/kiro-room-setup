# Acceptance checklist

A human sign-off sheet. Work top to bottom; each step names the command and what
correct output looks like. Steps 1–4 write nothing and can be repeated freely.
Step 5 is the first one that changes anything on the host.

Outputs quoted in steps 1–4 were captured on this checkout on 2026-10-01 with
kiro-cli 2.26.0, paseo 0.8.0 and Node 24.13.1. Version strings and paths will
differ on another host; the structure and the final line should not.

## 1. Tests

```bash
cd ~/repos/kiro-room-setup
npm test
```

No `npm install` is needed — the package has zero runtime and zero dev
dependencies; `node --test` is the whole runner. Expect the summary block to end:

```
ℹ tests 168
ℹ suites 28
ℹ pass 168
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Sign off only on `pass 168` / `fail 0`. A skipped test is a failed sign-off: there
are no conditionally-skipped tests in this suite, so a non-zero `skipped` means
something did not run.

## 2. Source validation

```bash
./scripts/verify --source
```

This validates the checkout without requiring anything to be installed, so it is
safe on a host that has never run `--apply`. Expect sixteen `ok` lines and:

```
kiro-room verify: source OK
```

Two of those lines are worth reading rather than skimming:

- `ok    workspace protocol template retains its TODO markers` — the shipped
  `WORKSPACE_PROTOCOL.md` must still be a template. A pre-filled one would look
  like a contract nobody decided.
- `ok    every routed model id appears in a provider allowlist` — every id in the
  routing table is offered by at least one `kiro-*` provider in the fragment.

## 3. Routing preflight, offline

```bash
node scripts/preflight.mjs --offline
```

Expect, with your own digest value:

```
routing table  …/kiro-room-setup/config/model-routing.example.json
catalog        …/tests/fixtures/model-catalog.json (offline) (19 models)
policy digest  9f052f46c9662fb0
runtime root   /Users/you/.kiro-runtime
               /Users/you/.kiro-runtime not present (nothing deployed yet)

  MONITOR_ECONOMY  gpt-5.6-luna       (gpt) -> claude-haiku-4.5   (claude)
  FAST_READ        claude-haiku-4.5   (claude) -> gpt-5.6-luna       (gpt)
  CODING_MEDIUM    claude-sonnet-5    (claude) -> gpt-5.6-terra      (gpt)
  REASONING_HIGH   claude-opus-5      (claude) -> gpt-5.6-sol        (gpt)
  REVIEW_HIGH      gpt-5.6-sol        (gpt) -> claude-opus-5      (claude)

preflight OK
```

Check three things in that block. Every class shows a `(gpt)`/`(claude)` pair in
opposite order — no `(other)` anywhere. `REVIEW_HIGH` shows `(gpt) -> (claude)`.
And the routing-table path is the one you expect: before installing it resolves to
the checkout's example, after installing it resolves to
`~/.kiro-room/model-routing.local.json`.

Record the `policy digest` value. It is what a later drift check compares against.

## 4. Plan mode writes nothing

`./install` with no flags is read-only. Prove it rather than trusting it:

```bash
cd ~/repos/kiro-room-setup
shasum -a 256 ~/.paseo/config.json ~/.kiro/settings/cli.json > /tmp/kr-before.txt
./install
shasum -a 256 ~/.paseo/config.json ~/.kiro/settings/cli.json > /tmp/kr-after.txt
diff /tmp/kr-before.txt /tmp/kr-after.txt && echo "UNCHANGED"
ls -d ~/.config/kiro-room ~/.kiro-runtime 2>&1
```

Expect `diff` to be silent and print `UNCHANGED`, and `ls` to report both paths as
`No such file or directory` on a host that has not yet applied. This was verified
on this host: both hashes identical across the plan run, and both directories
still absent afterwards.

The plan output itself should end with:

```
== Next steps
  ./install --apply
  paseo daemon reload      # immediately, not later
  ./install --verify

Plan only. Nothing was written.
```

Before that, under `== Prerequisites`, confirm `kiro-cli auth   logged in` and
`PATH            includes /Users/you/.local/bin`. Those two are warnings rather
than hard failures, so the plan can succeed with them unhappy and a seat will then
fail at launch.

## 5. Apply

Everything from here on modifies the host.

```bash
./install --apply
```

Expect the step headers `Prerequisites`, `Backup`, `Installing managed files`,
`Operator routing table`, `Generating role runtimes`, `Merging Paseo providers`,
`Verifying installed state`, `Done`. Note the backup path it prints — you need it
for the rollback section.

Two lines to read:

- Under `Operator routing table`, either `… seeded from the example` (first
  install) or `… already exists, left as-is` (re-apply). The second is correct on
  a re-apply and means your edits survived.
- Under `Merging Paseo providers`, three `+ agents.providers.kiro-*` lines on a
  first install, or `already up to date` on a re-apply.

If any step after the first write fails, the installer rolls back to the prior
state automatically and preserves the backup. The message is
`apply failed; rolling back from …`.

## 6. Reload the daemon, immediately

```bash
paseo daemon reload
```

Not `restart` — restart kills running agents. Not later — Paseo's provider snapshot
manager writes the whole provider set back into `config.json` on daemon start and
on every desktop reconnect, so an edit the running daemon never loaded is silently
clobbered, and the resulting failure looks exactly like the install not having
happened.

## 7. Verify installed state and the live inventory

```bash
./install --verify
```

This runs `scripts/verify` and then adds a preflight against the live catalog plus
a live provider check. Expect, per role, `ok` for the agent config, settings,
prompt, stamp, state dir, the outside-`~/.kiro` isolation check, each shared
symlink that has a target in `~/.kiro` (`skills`, `steering`, `powers`,
`settings/mcp.json` — four on a normal host; a shared path you do not have is
reported by neither `ok` nor `FAIL`), `native delegation disabled`, and
`policy hook wired on all five events`. Then:

```
Operator base home
  ok    /Users/you/.kiro present
  ok    no role agent config leaked into /Users/you/.kiro/agents

Paseo config
  ok    three kiro-* providers present in /Users/you/.paseo/config.json
  ok    pre-existing codex-* providers still present
```

and finally `verify OK`.

The preflight inside `--verify` runs against the live catalog with no `--offline`,
so it needs credentials. It also now has runtimes to inspect and will report
`N turn records checked` instead of `nothing deployed yet` once seats have run.

## 8. Provider inventory

```bash
paseo provider ls
```

Three assertions, and the second is as important as the first:

1. `kiro-supervisor`, `kiro-lead` and `kiro-peer` each appear with
   `STATUS = available` and `ENABLED = Enabled`.
2. `codex-supervisor`, `codex-lead`, `codex-peer`, `claude`, `codex` and the plain
   `kiro` provider are **still** present and still `available`. The plain `kiro`
   row should still show `MODES = kiro_default, kiro_planner, kiro_guide` — that
   row is the pre-existing seat this repo does not own.
3. Nothing else changed status. The merge adds three keys and refuses to write if
   anything else in the document would change, but the daemon reload is a separate
   event, so confirm with your own eyes.

`./install --verify` checks **presence** for 1 and 2 — it greps this same listing
for each `kiro-*` role and for `codex-supervisor`, `codex-lead`, `codex-peer`,
`claude`, `codex` and `kiro`, and fails with `did you run 'paseo daemon reload'?`
when a `kiro-*` provider is absent. It does not assert on the `STATUS` and
`ENABLED` columns; for the three `kiro-*` rows it prints them and leaves the
judgement to you. Read those two columns yourself.

## 9. Validate each generated agent config

```bash
for role in supervisor lead peer; do
  echo "== $role"
  kiro-cli agent validate --path ~/.kiro-runtime/$role/agents/kiro-$role.json
done
```

Expect a success result for all three. Keep one measured fact in mind while
reading it: `kiro-cli agent validate` returns success for `permissions.rules` on
2.26.0 and the runtime then ignores that field entirely. So this step confirms the
config is **schema-valid**, which is necessary and not sufficient. What proves the
bounds hold is step 11.

Do not run this with `HOME` overridden. `kiro-cli` resolves its helper binary under
`$HOME/.local/bin`, so a relocated `HOME` reports false negatives and can trigger a
device-authorisation flow. `KIRO_HOME` is the variable that is safe to redirect.

## 10. Runtime snapshot (optional, useful for the record)

```bash
./scripts/export-runtime-snapshots
```

Prints a sanitised per-role summary — role, label, model, class, effort,
`paseoTools`, relativised `baseHome` and `hookPath`, the tool list, the five hook
event names, `includeMcpJson`, each symlink that exists, and a count of files in
`sessions/`. No session content, credential or token is read.
Attach the output to the sign-off; it is the cheapest way to compare two hosts
later.

Expect `paseoTools: true` for supervisor and lead, `false` for peer; models
`gpt-5.6-luna` / `claude-opus-5` / `claude-sonnet-5`; efforts `low` / `high` /
`medium`.

## 11. Live behavioural check

This is the step that actually demonstrates enforcement, and it has to be done by
hand from Paseo because it depends on the ACP transport and the daemon-spawned
process — neither of which any offline check exercises.

Pick a scratch directory you do not mind being written to, for example
`/tmp/kiro-room-acceptance`, and create it first.

**11a. Start a `kiro-peer` seat** from Paseo, with its workspace at that scratch
directory.

**11b. Send a plain message, with no brief:**

```
Create a file called probe.txt in this directory containing the word hello.
```

Expected: the write is **refused**. The Peer should report a block naming the
policy code. The correct code is `brief.write_not_granted`, with a reason along the
lines of "This turn carries no brief marker block, so it is read-only. Ask the Lead
to re-issue a brief; a plain chat message grants nothing."

Confirm `probe.txt` does not exist. A refusal in prose with the file created anyway
is a failed acceptance.

If the seat instead reports being unable to use the shell, that is
`brief.shell_not_granted` and is the same mechanism on a different tool — also a
pass.

**11c. Send the same request wrapped in a valid brief**, in one message:

```
KIRO_ROOM_TASK_V1_BEGIN
ROLE: peer
TASK_ID: acceptance-1
WORKSPACE: /tmp/kiro-room-acceptance
BRANCH: agent/acceptance-1
OWNED_SCOPE: **
AUTHORITY: read, write
MODEL_CLASS: CODING_MEDIUM
KIRO_ROOM_TASK_V1_END

Create a file called probe.txt in this directory containing the word hello.
```

Expected: the write **succeeds**, and `/tmp/kiro-room-acceptance/probe.txt` exists
with the content `hello`. Note `AUTHORITY` omits `git`, so this brief also grants
the shell (a Peer's shell needs a non-empty authority list, not a specific token)
while still denying every mutating git command.

**11d. Optional but cheap — confirm the boundary is independent of the brief.**
Each of these must be its own message **with the same brief block repeated in it**.
A follow-up message without the block is a new turn with no brief: the record is
overwritten with `{kind:'none'}`, and the write is then denied at the brief gate
with `brief.write_not_granted` before the boundary is ever consulted — which
demonstrates the wrong gate.

So send the 11c block again, changing only the trailing request:

- ask it to write `~/.paseo/probe.txt`. Expected: `boundary.protected_path`.
- ask it to write `/tmp/elsewhere/probe.txt`. Expected:
  `boundary.outside_workspace`.

Both are refused while the brief still grants `write`, which is the point: a valid
brief does not widen the boundary. That is why there are two gates.

**11e. Confirm the turn record exists.**

```bash
ls -l ~/.kiro-runtime/peer/kiro-room-state/
```

One JSON file per session id, mode `0600`, directory `0700`. Its `brief.kind`
should be `valid` if the last message you sent carried a brief (11c, or 11d done as
described above) and `none` if it did not — that field tracks the most recent
message, not the session. Its `policyDigest` should equal the value you recorded in
step 3.

Sign-off on this section requires 11b refusing and 11c succeeding. Either one alone
proves nothing: a seat that refuses everything is as broken as one that allows
everything.

## Rollback

`./install --apply` rolls itself back automatically if it fails mid-way. This
section is for undoing a **successful** apply.

Warning: the steps below delete directories and overwrite live Paseo
configuration. Read the whole section before running any of it. Stop any running
`kiro-*` seats from Paseo first — a seat whose `KIRO_HOME` disappears underneath it
will fail in confusing ways.

Each apply writes one directory under `~/.kiro-room-backups/`, named
`<UTC-timestamp>-<pid>-<epoch>`, for example `20260930T172300Z-4711-1790000000`.
Pick the one from the apply you want to undo:

```bash
ls -1t ~/.kiro-room-backups/
BK=~/.kiro-room-backups/20260930T172300Z-4711-1790000000
```

Inside it you will find:

| Entry | What it is |
| --- | --- |
| `.config/kiro-room/…`, `.local/bin/…` | copies of files that **existed before** and were replaced. Paths mirror `$HOME` |
| `.paseo/config.json` | the Paseo config as it was before the merge |
| `paseo/paseo-config.json` | a second copy taken by the merge script itself |
| `.created` | one absolute path per line, for each file this apply created |
| `.created-roots` | one absolute path per line, for each directory tree that did not exist at all before this apply |

Inspect first, act second:

```bash
cat "$BK/.created-roots"     # whole trees that were new
cat "$BK/.created"           # individual new files
find "$BK" -type f -not -name '.created*'   # what was replaced
```

Then restore in this order.

**1. Restore the Paseo config.** This is the only step that matters for getting
your previous provider set back.

```bash
cp "$BK/.paseo/config.json" ~/.paseo/config.json
```

**2. Remove the trees this apply created.** Only the paths listed in
`.created-roots` — anything not listed existed before and must not be deleted.

```bash
while IFS= read -r d; do
  [ -n "$d" ] && echo "would remove: $d"
done < "$BK/.created-roots"
```

Re-run with `rm -rf "$d"` in place of the `echo` once you have read the list.
Typically this is `~/.config/kiro-room`, `~/.kiro-runtime` and `~/.kiro-room`.

`~/.kiro-room` holds `model-routing.local.json`. If it appears in
`.created-roots` it was created by this apply and removing it is correct. If it
does **not** appear, it predates the apply and your routing table is in it — leave
it alone.

**3. Restore replaced files and remove created ones.**

```bash
# replaced files: copy back over
(cd "$BK" && find . -type f -not -name '.created*' -not -path './paseo/*' \
   | sed 's|^\./||') | while IFS= read -r rel; do
  cp -R "$BK/$rel" "$HOME/$rel"
done

# created files not already removed with their tree
while IFS= read -r f; do
  [ -n "$f" ] && [ -e "$f" ] && echo "would remove: $f"
done < "$BK/.created"
```

This is the same sequence the installer's own `rollback()` performs; reading that
function is the authoritative reference if anything here looks ambiguous.

**4. Reload the daemon.**

```bash
paseo daemon reload
paseo provider ls
```

Expect the three `kiro-*` providers to be gone and every pre-existing provider to
be back. Confirm with `paseo provider ls` rather than assuming.

**5. Confirm `~/.kiro` is untouched.** It never was: no step of the install writes
it, and `scripts/verify` asserts no role agent config leaked into `~/.kiro/agents`.
If you took a hash before installing, compare it now.

## Still unverified until the operator applies

Reproduced from
[inventory-20260930.md, "Still unverified"](inventory-20260930.md#still-unverified--requires-the-operator-to-run---apply).
These could not be established by a read-only probe, and steps 5–11 above are what
close them. None is closed by `npm test`, `scripts/verify` or `preflight`.

1. **Whether `kiro-cli acp --agent kiro-<role>` resolves the generated agent when
   spawned by the Paseo daemon** rather than by an interactive shell. `KIRO_HOME`
   is honoured by `agent list`, and ACP takes `--agent`, but the composed path
   through the daemon is untested. Closed by step 11a starting successfully with
   the role's prompt and tool surface in effect.
2. **Whether the Paseo daemon accepts the three new `extends: "acp"` provider
   entries and reports them `available`** after `paseo daemon reload`. Closed by
   step 8.
3. **Whether `paseoTools.enabled` is honoured on ACP providers by daemon 0.9.2.**
   The field is undocumented in Paseo's `docs/custom-providers.md` but is already
   present on `grok` and `hermes` in this operator's live config, so it is at least
   tolerated. Closed by observing that a `kiro-peer` seat has no
   `mcp__paseo__*` tools while `kiro-lead` does.
4. **Whether the `preToolUse` hook fires on the ACP path as it does on the `chat`
   path.** Same hook wiring, different transport. This is the one that matters
   most: if it does not fire, nothing is enforced. Closed by step 11b refusing the
   write.
5. **End-to-end Lead delegation through `mcp__paseo__create_agent` with a routed
   model.** Untested. Related open question from the code rather than the
   inventory: MCP tool names are not present in any role's `unconditional` or
   `briefGated` list in `ROLE_PROFILES`, and `evaluate()` denies any tool outside
   those sets with `tool.not_in_role_surface`. Whether kiro-cli fires `preToolUse`
   for MCP tools at all, and under what `tool_name`, was not measured. If a Lead's
   delegation is denied with that code, this is the cause.

Two further facts are measured and should not be re-litigated during sign-off,
because they are the reason the design looks the way it does:

- `permissions.rules` validates and is silently ignored on 2.26.0. A green
  `kiro-cli agent validate` is not evidence of enforcement.
- `toolsSettings.execute_bash.deniedCommands` validates and is silently ignored
  likewise.

## Sign-off

| # | Step | Result | Notes |
| --- | --- | --- | --- |
| 1 | `npm test` → 168/168 | | |
| 2 | `scripts/verify --source` → source OK | | |
| 3 | `preflight --offline` → OK, digest recorded | | digest: |
| 4 | plan writes nothing, hashes identical | | |
| 5 | `./install --apply` → Done | | backup: |
| 6 | `paseo daemon reload` | | |
| 7 | `./install --verify` → verify OK | | |
| 8 | three `kiro-*` available, all pre-existing providers intact | | |
| 9 | `agent validate` passes for all three roles | | |
| 10 | runtime snapshot attached | | |
| 11b | plain message → write refused | | code: |
| 11c | briefed message → write succeeds | | |
| 11d | protected path and outside-workspace both denied | | |
| 11e | turn record present, digest matches step 3 | | |
