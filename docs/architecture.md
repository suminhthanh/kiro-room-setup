# Architecture

This document describes how a Kiro Room seat is composed, who owns each layer of
mutable state, and why the enforcement sits where it does. Every design claim
here traces either to a file in this checkout or to a measurement recorded in
[inventory-20260930.md](inventory-20260930.md); where a claim is neither, it is
labelled as unverified.

## Control flow

```text
~/.paseo/config.json
  agents.providers.kiro-supervisor | kiro-lead | kiro-peer
    extends: "acp"
    command: ["~/.local/bin/kiro-room", "<role>"]
    models:  explicit allowlist (REPLACES Paseo's discovered catalog)
    paseoTools.enabled: true (supervisor, lead) | false (peer)
  |
  v
~/.local/bin/kiro-room <role>
  |
  +-- ~/.local/bin/kiro-room-sync <role> --quiet      (runs on EVERY launch)
  |     +-- reads  ~/.kiro/settings/cli.json          (base, read-only)
  |     +-- reads  ~/.config/kiro-room/overlays/<role>.json
  |     +-- reads  ~/.config/kiro-room/prompts/<role>.md
  |     +-- reads  ~/.kiro-room/model-routing.local.json
  |     `-- writes ~/.kiro-runtime/<role>/
  |
  +-- reads model + effort back out of ~/.kiro-runtime/<role>/kiro-room.json
  |
  `-- exec env KIRO_HOME=~/.kiro-runtime/<role>
               KIRO_ROOM_ROLE=<role>
               KIRO_ROOM_CONFIG_DIR=~/.config/kiro-room
               KIRO_ROOM_STATE_DIR=~/.kiro-runtime/<role>/kiro-room-state
        kiro-cli acp --agent kiro-<role> --model <id> --effort <level>
                     --trust-all-tools
          |
          +-- userPromptSubmit -> kiro-room-hook.mjs -> kiro-policy.mts
          |     parseBrief(prompt); write turn record keyed by session_id
          |
          `-- preToolUse      -> kiro-room-hook.mjs -> kiro-policy.mts
                read turn record by session_id -> policy-core.evaluate()
                  allow -> exit 0
                  deny  -> exit 2  ("blocked by a pre-execution hook")
```

The launcher re-syncs before every session (`home/.local/bin/kiro-room`, the
`"$SYNC" "$ROLE" --quiet` line). An overlay or policy edit therefore takes effect
on the next seat start rather than whenever someone remembers to re-sync. The
agent engine is left at its default v2; `--agent-engine` is never passed, because
under v3 the generated custom agent was not found at all and Kiro fell back to
its built-in default, which would drop every role bound.

## Ownership of mutable state

The single most useful thing to know about this repo is which directory belongs
to whom. Mixing these up is how a governance layer quietly stops governing.

| Path | Owner | Mutable state it holds | This repo's access |
| --- | --- | --- | --- |
| `~/.kiro` | Operator | Kiro login, `settings/cli.json`, `settings/mcp.json`, `skills/`, `steering/`, `powers/`, `agents/` | read-only. Never written by `install` or by `kiro-room-sync`; `scripts/verify` asserts no role agent config leaked into `~/.kiro/agents` |
| `~/.config/kiro-room` | This repo | `extensions/*.mts`, `extensions/kiro-room-hook.mjs`, `overlays/<role>.json`, `prompts/<role>.md`, `WORKSPACE_PROTOCOL.md`, `model-routing.example.json` | written by `./install --apply`; overwritten on every re-apply |
| `~/.kiro-room` | Operator | `model-routing.local.json` — the routing table actually in force | seeded from the example **only if absent**, then never touched again (`install`, "Operator routing table" step) |
| `~/.kiro-runtime/<role>` | Generated | `settings/cli.json`, `prompts/<role>.md`, `agents/kiro-<role>.json`, `kiro-room.json`, `sessions/`, `kiro-room-state/`, symlinks | fully derived output of `kiro-room-sync`; safe to delete, regenerated on next launch. `sessions/` and `kiro-room-state/` are the two subtrees that are *not* derived |
| `~/.paseo` | Paseo | `config.json`, including `agents.providers` | exactly three keys added under `agents.providers`; the merge refuses to write if anything else would change |
| `~/.kiro-room-backups` | Installer | one timestamped directory per `--apply`, plus `.created` / `.created-roots` manifests and `paseo/paseo-config.json` | written by `./install --apply`; never pruned automatically |

Every one of these six paths is also on the unconditional protected-path deny
list, `~/.kiro-room-backups` included. The full list from
`PROTECTED_HOME_PREFIXES` in `extensions/policy-core.mts` is
`.kiro`, `.kiro-runtime`, `.kiro-room`, `.kiro-room-backups`,
`.config/kiro-room`, `.paseo`, `.claude`, `.codex`, `.aws`, `.ssh`, `.gnupg`,
`Library/Keychains`. A seat that could rewrite any of those could rewrite its own
bounds, so the deny does not depend on a brief and is not widened by one.

## The runtime merge, step by step

`syncRole()` in `extensions/room-runtime.mts` is the whole generator. It is
idempotent by construction: the output is derived from (base settings + overlay +
prompt + policy) and serialised with sorted keys, so two consecutive runs produce
byte-identical files and `writeIfChanged` leaves mtimes alone.

1. **Refuse to generate into the base home.** If `runtimeHome` equals
   `baseHome` or is under it, `syncRole` throws. There is a test for it
   (`tests/sync.test.mjs`, "generating into the base home is refused").
2. **Load the overlay** from `~/.config/kiro-room/overlays/<role>.json`. The
   overlay must declare the same `role` it is loaded as, or the load throws.
3. **Create the tree**: `agents/`, `prompts/`, `settings/`, `sessions/`, and
   `kiro-room-state/` with mode `0700`. `sessions/` exists so Kiro has somewhere
   per-role to keep conversation state; `kiro-room-state/` is where the policy
   keeps per-turn authority (see below).
4. **Read the base** `~/.kiro/settings/cli.json`. A missing or unparseable file
   resolves to `{}` rather than failing — `kiro-cli` itself creates a `{}`
   `settings/cli.json` on first use in a fresh `KIRO_HOME`, which the generator
   has to tolerate.
5. **Apply the overlay through an allowlist.** Only the five keys in
   `SETTINGS_ALLOWLIST` may be replaced: `chat.defaultModel`,
   `chat.enableThinking`, `chat.enableTodoList`, `chat.enableCodeIntelligence`,
   `chat.enableNotifications`. Anything else in `overlay.settings` is ignored. A
   role overlay pins the model and the reasoning posture; it is not a place to
   reconfigure the operator's CLI.
6. **Force the two keys that are not negotiable.**
   `chat.defaultAgent = "kiro-<role>"`, then `FORCED_SETTINGS`, which is
   `{"chat.enableSubagent": false}`. Forcing happens after the overlay, so an
   overlay cannot re-enable sub-agents. This is the second half of the
   delegation bound: the hook denies the `delegate` tool, and this stops the
   capability from being offered in the first place.
7. **Render the prompt.** `~/.config/kiro-room/prompts/<role>.md` is copied to
   `<runtime>/prompts/<role>.md` (mode `0644`). A missing prompt throws; the
   generator will not produce a seat with no role instructions.
8. **Generate the agent config** at `<runtime>/agents/kiro-<role>.json`. Notable
   fields: `prompt` is `file://../prompts/<role>.md`, resolved relative to the
   config file's own directory; `tools` and `allowedTools` are both
   `ROLE_PROFILES[role].tools`; `includeMcpJson` is `true`; `hooks` wires
   `kiro-room-hook.mjs` on all five events in **array** form, because the object
   form is rejected by 2.26.0 with `data did not match any variant of untagged
   enum Repr`; and `permissions.rules` is emitted but inert (see below).
9. **Write the stamp** `<runtime>/kiro-room.json` recording `role`, `label`,
   `model`, `modelClass`, `effort`, `paseoTools`, `baseHome`, `configDir` and
   `hookPath`. The launcher reads `model` and `effort` back out of this file to
   build the `kiro-cli acp` command line, and `scripts/verify`,
   `scripts/preflight.mjs` and `scripts/export-runtime-snapshots` all use it to
   report what was actually deployed.
10. **Symlink the shared, operator-owned parts**: `skills`, `steering`, `powers`
    and `settings/mcp.json`, each pointing back into `~/.kiro`. Two refusals
    matter here: an absent target is recorded as skipped rather than fabricated,
    and a real file or directory already sitting at the link path is left alone
    rather than deleted, because that would mean destroying operator data the
    generator does not own.

Authentication needs no step at all. A fresh `KIRO_HOME` in a tmpdir returned a
valid identity from `kiro-cli whoami --format json`, so credentials live outside
`KIRO_HOME` and every role runtime inherits the operator's login with no symlink
and no repeated device flow.

## Two gates: whether, and where

`evaluate()` in `extensions/policy-core.mts` is the only decision function, and
it applies two independent gates. Both must pass before a mutating tool runs.

**The brief gate decides *whether* this turn may write.** Authority is recomputed
from the brief of the current turn and from nothing else — not the previous turn,
not the seat's configuration. Three outcomes, from `parseBrief`:

| Turn content | `BriefParse` | Effect |
| --- | --- | --- |
| no `KIRO_ROOM_TASK_V1_BEGIN`/`END` markers at all | `{kind:'none'}` | read-only turn; a Peer also loses `shell` |
| exactly one well-formed pair | `{kind:'valid'}` | the declared `AUTHORITY` applies |
| markers present but malformed | `{kind:'invalid'}` | **everything** is denied, reads included |

The third row is deliberate and is checked before anything else in `evaluate()`
except the delegation deny. A malformed block means someone tried to grant
authority and got it wrong, which is a different situation from not asking for
any. A broken grant is a failed grant, never a partial one.

**The boundary deny decides *where* a permitted write may land.**
`checkWriteBoundary` resolves the target path (expanding `~`, resolving relative
paths against `cwd`, and normalising `..` before comparison), applies
`protectedPathHit` first, and only then checks containment in the write root. The
write root is the brief's `WORKSPACE` when a valid brief is present, otherwise
`cwd`. The same protected-path scan runs over shell command text
(`shellProtectedPathScan`), and it denies protected paths for **reads** as well
as writes: a seat inspecting `~/.aws` or `~/.paseo` through the shell has no
legitimate use, and the `read` tool is the supported route for inspecting
ordinary configuration.

The two gates do not substitute for each other. A valid brief never widens the
boundary, and being inside the boundary never supplies a missing brief.

A third bound sits above both: the tool surface. `ROLE_PROFILES` splits each
role's tools into `unconditional` and `briefGated`, and `evaluate()` denies
anything in neither with `tool.not_in_role_surface`.

| Role | `tools` written into the agent config | Usable with no brief | Brief-gated | Paseo MCP tools |
| --- | --- | --- | --- | --- |
| supervisor | read-only set + `shell` + `@mcp` | read-only set + `shell` | — | yes |
| lead | read-only set + `shell` + `write` + `@mcp` | read-only set + `shell` | `write` | yes |
| peer | read-only set + `shell` + `write` | read-only set | `write`, `shell` | no |

The read-only set is `read, grep, glob, introspect, report, thinking, todo,
knowledge`. The Supervisor has no `write` in `tools` at all, so the capability is
not merely denied later — it is absent, which is the stronger bound of the two
that were measured to work. The Lead has `write` in its surface but
`evaluate()` denies it with `lead.write_disabled` unless the seat was started
with `KIRO_ROOM_LEAD_WRITE=1`.

## Why the hook is the only real enforcement point

Four candidate mechanisms were tested on kiro-cli 2.26.0 by running a real
cheap-model session in a tmpdir `KIRO_HOME` and observing whether the guard bit.
The results are tabulated in
[inventory-20260930.md, "Enforcement: what actually holds"](inventory-20260930.md#enforcement-what-actually-holds):

- `hooks.preToolUse` in array form: validates, and **blocks**. The hook marker
  file was written and the tool reported `status: Failed` with "blocked by a
  pre-execution hook".
- `tools` allowlist: validates, and **removes the tool**. An agent declared with
  `tools:["read"]` had no shell and, asked for its tool list, printed exactly
  `read`.
- `permissions.rules`: validates, and is **silently ignored**. With
  `{capability:"shell", match:["echo *"], effect:"deny"}` present, `echo
  permcheck` ran to completion.
- `toolsSettings.execute_bash.deniedCommands`: validates, and is **silently
  ignored**. With `deniedCommands:["echo .*"]` present, `echo tscheck` ran.

The two silent-ignore rows are why this repo is shaped the way it is. A design
that leaned on `permissions.rules` would pass `kiro-cli agent validate`, read as
enforced in review, and hold nothing at runtime. `permissions.rules` is still
emitted into every generated agent config for forward compatibility with CLI 3.x
and is documented inline as inert; no decision in `policy-core.mts` consults it.

`hooks.agentSpawn` did not fire under `chat --no-interactive` in either engine.
It is wired but nothing depends on it.

The hook's own failure behaviour is asymmetric on purpose
(`extensions/kiro-room-hook.mjs`): if the policy throws while handling
`preToolUse` the process exits 2 and the tool is blocked, but any other event
exits 0, because blocking a prompt submission on an internal error would strand
the session with no way to recover. A payload that is not parseable as JSON exits
2 regardless of event. And if `KIRO_ROOM_ROLE` is unset the hook exits 0 before
reading stdin or loading any policy, so a plain `kiro-cli` session is unaffected
even if the hook is somehow reachable from a global configuration.

## Why per-turn session state exists

The brief lives in the user's message. The decision has to be made at tool-call
time. Those are two different hook events with two different payloads, and the
later one does not carry the message.

A measured `preToolUse` payload carries exactly
`{hook_event_name, cwd, session_id, tool_name, tool_input}` — and **no prompt**.
There is no field to recover the brief from. The prompt is visible only to
`userPromptSubmit`. So the two events are split by necessity:

- `userPromptSubmit` runs `parseBrief(payload.prompt)` and writes a `TurnRecord`
  — `{sessionId, role, brief, updatedAt, policyDigest}` — to
  `<stateDir>/<session_id>.json`, with the directory at mode `0700` and the file
  at `0600`. The session id is sanitised to `[A-Za-z0-9._-]` before being used as
  a filename, falling back to `unknown-session`.
- `preToolUse` reads that record back by `session_id` and passes its `brief`
  field into `evaluate()`.

The state directory is `$KIRO_ROOM_STATE_DIR`, which the launcher sets to
`~/.kiro-runtime/<role>/kiro-room-state`, falling back to
`$KIRO_HOME/kiro-room-state` and then `$HOME/.kiro-runtime/kiro-room-state`.

Two properties of this store are load-bearing:

**Overwrite-per-turn *is* the brief gate.** Every `userPromptSubmit` replaces the
record for that session. A plain chat message with no marker block writes
`{kind:'none'}`, and the turn becomes read-only. That is not a side effect to be
worked around; it is the mechanism, and it is the reason the operating rule is to
talk to the Lead rather than to a working Peer.

**A state problem degrades to read-only, never to open.** `readTurnRecord`
returns `null` for a missing file, unreadable file, invalid JSON, unknown role or
missing `brief` field, and `preToolUse` treats `null` as `{kind:'none'}`.

The record also carries the `policyDigest` of the code that wrote it, which is
what `scripts/preflight.mjs` compares against the digest of the checkout. The
digest is computed from the rule set — roles, profiles, protected prefixes, shell
rule sources, the allowed push pattern, delegation tool names, brief markers and
required fields — not from file bytes, so reformatting or a comment edit does not
read as a policy change while any change to an actual bound does. That is how a
pull that was never redeployed gets caught: without it, sessions keep enforcing
the bounds that were deployed last while every file-level check passes clean.

## Why three providers rather than one with three modes

`paseo provider ls` lists the pre-existing `kiro` provider as available with
`MODES = kiro_default, kiro_planner, kiro_guide`. Paseo surfaces Kiro agents as
ACP **modes** of a single provider. A mode is chosen inside a session; it does
not get its own process.

Everything that distinguishes a Kiro Room role is fixed at process spawn and is
declared at provider level, not mode level:

| Per-role fact | Where it lives | Mode-selectable? |
| --- | --- | --- |
| which role the policy enforces | `KIRO_ROOM_ROLE` in the launcher's `exec env` | no — set once, at spawn |
| which `KIRO_HOME` the session uses | `KIRO_HOME` in the same `exec env` | no |
| which agent config, and therefore which `tools` surface | `kiro-cli acp --agent kiro-<role>` | no |
| model and reasoning effort | `--model` / `--effort` on the same command line | no |
| the model allowlist offered in the UI | `models` array on the provider entry | no |
| whether the seat gets Paseo orchestration tools | `paseoTools.enabled` on the provider entry (`false` for `kiro-peer`, `true` for the other two) | no |

One provider with three modes would therefore mean one process, one
`KIRO_ROOM_ROLE`, one tool surface and one `paseoTools` setting for all three
roles — which is to say no roles at all. Switching modes mid-session would also
mean changing role bounds inside a session whose hook role was fixed at spawn.
Three provider entries, each with its own `command: [".../kiro-room", "<role>"]`,
is the only shape that expresses the distinction.

The `models` array is used rather than `additionalModels` for a related reason:
`models` **replaces** Paseo's runtime-discovered catalog, so a seat offers the
routing table's ids and nothing else. `additionalModels` appends, which would
reintroduce every model in the catalog including the expensive ones;
`scripts/merge-paseo-providers.mjs` throws if a fragment uses it.

## What this architecture does not do

Stated here because each item has a cost and discovering it later is more
expensive than reading it now.

- **It is a policy layer, not a sandbox.** A write-mode Peer holds `shell`. The
  hook constrains which commands start, not what a process does once started.
- **`OWNED_SCOPE` and `EXCLUDED_SCOPE` are parsed but not enforced.**
  `parseBrief` reads them into the `Brief`, and nothing in `evaluate()` consults
  them. The enforced bounds are the workspace root and the protected-path deny.
- **`classifyTask()` is a reference implementation, not a runtime hook.** It is
  exported from `policy-core.mts` and asserted by `tests/policy-core.test.mjs`,
  but no script or hook calls it. The Lead follows the procedure; the code
  documents and tests it.
- **MCP tool names are not in any role's `unconditional` or `briefGated` list.**
  `evaluate()` denies any tool outside those sets with
  `tool.not_in_role_surface`. Whether kiro-cli fires `preToolUse` for MCP tools
  at all, and under what `tool_name`, is not among the measurements in
  `inventory-20260930.md`. If it does, a Lead's `mcp__paseo__create_agent` call
  will be denied and the `briefGated`/`unconditional` sets need an MCP entry.
  Treat this as unverified until a Lead has delegated successfully end to end —
  which is also item 5 of the inventory's "Still unverified" list.
- **Parallel writers are unmodelled.** Read-only Peers parallelise; concurrent
  writers would need worktree isolation per writer.
