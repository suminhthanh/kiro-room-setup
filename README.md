# Kiro Room Setup

Supervisor / Lead / Peer governance for **Kiro CLI** agents running under
**Paseo**. Paseo owns lifecycle and control-plane truth; this repo owns role
invariants (prompt + tool policy), isolated per-role runtimes, and the model
routing procedure.

```text
~/.paseo/config.json  (kiro-supervisor | kiro-lead | kiro-peer)
  -> ~/.local/bin/kiro-room <role>
       -> kiro-room-sync <role>
            +-- reads ~/.kiro/settings/cli.json        (base, read-only)
            +-- reads ~/.config/kiro-room/overlays/<role>.json
            `-- writes ~/.kiro-runtime/<role>/
       -> KIRO_HOME=~/.kiro-runtime/<role> kiro-cli acp --agent kiro-<role>
            `-- preToolUse hook -> policy-core
```

The rules are enforced by a `preToolUse` hook, and that choice is not stylistic.
On kiro-cli 2.26.0 the agent-config `permissions.rules` field **validates
successfully and is then ignored at runtime** — measured, with a `deny` rule in
place and the command running anyway. A design that leaned on that field would
look enforced, pass `kiro-cli agent validate`, and hold nothing. The hook does
block: `exit 2` produces `status: Failed` with "blocked by a pre-execution
hook". See [docs/inventory-20260930.md](docs/inventory-20260930.md) for the
measurements.

This repository deliberately does **not** own `~/.kiro`. You install and
authenticate Kiro yourself. The sync script reads your existing
`~/.kiro/settings/cli.json` as its base and shares your skills, steering, powers
and MCP servers by symlink. Authentication needs no wiring at all: it lives
outside `KIRO_HOME`, verified by running `whoami` in a fresh one.

## Install

Prerequisites: macOS or another Unix-like environment with Bash, Node **22.18+**
(the policy is loaded as `.mts` via type stripping), Git, `kiro-cli` and `paseo`
on `PATH`, and `~/.local/bin` on `PATH`.

```bash
git clone <this repo> kiro-room-setup
cd kiro-room-setup

npm test                 # 168 tests, no npm install needed — zero runtime deps
./install                # read-only plan and prerequisite check
./install --apply        # transactional install with backup and rollback
paseo daemon reload      # immediately, see below
./install --verify       # installed state plus live provider inventory
```

### Reload immediately, not later

`paseo daemon reload` is a required step, not a suggestion. Paseo's provider
snapshot manager writes the whole provider set back into `config.json` on daemon
start and on every desktop reconnect. An edit the running daemon never loaded is
silently clobbered, and the failure looks like the install not having happened.

Use `reload`, not `restart`. Restart kills running agents.

## What gets installed

| Repository source | Local destination |
| --- | --- |
| `extensions/*.mts`, `extensions/*.mjs` | `~/.config/kiro-room/extensions/` |
| `home/.config/kiro-room/` | `~/.config/kiro-room/` |
| `home/.local/bin/kiro-room*` | `~/.local/bin/` |
| `config/model-routing.example.json` | `~/.kiro-room/model-routing.local.json` (only if absent) |
| generated | `~/.kiro-runtime/<role>/` |
| three provider keys | `~/.paseo/config.json` |

`~/.kiro` is never written. Sessions, logs, credentials, runtimes and backups are
never committed.

### Your existing seats are untouched

`codex-supervisor`, `codex-lead`, `codex-peer`, `claude`, `codex`, the plain
`kiro` provider, the `daemon` block and the `features` block are all left
byte-identical. The merge adds exactly three keys under `agents.providers` and
**refuses to write** if anything else would change. That guard is covered by
tests that diff the whole document with the three managed keys removed from both
sides.

## Roles

| Provider | Role | Authority | Paseo tools |
| --- | --- | --- | --- |
| `kiro-supervisor` | Supervisor | observe, monitor, one gated Lead recovery. No write tool at all. | yes |
| `kiro-lead` | Lead | orchestrate, delegate, verify, accept. No product writes unless `KIRO_ROOM_LEAD_WRITE=1`. | yes |
| `kiro-peer` | Peer | one bounded scope; authority only from the current turn's brief. | **no** |

Native delegation is denied for every role, and `chat.enableSubagent` is forced
`false` in every generated runtime. Paseo is the only control plane; a
Kiro-native sub-agent is a second one Paseo cannot see, bound or bill. The Lead
delegates through `mcp__paseo__create_agent`.

## How authority works

Two independent gates, and both must pass before a mutating tool runs.

**The brief gate** decides *whether* this turn may write. Authority is
recomputed from the brief of the current turn; only a
`KIRO_ROOM_TASK_V1_BEGIN … END` block grants write or git authority. A turn with
no block is read-only. A block that is present but malformed denies
**everything**, including reads — a broken grant is a failed grant, never a
partial one.

**The boundary deny** decides *where* a permitted write may land. Writes are
confined to the brief's `WORKSPACE`, and `~/.kiro`, `~/.kiro-runtime`,
`~/.kiro-room`, `~/.config/kiro-room`, `~/.paseo`, `~/.claude`, `~/.codex`,
`~/.aws`, `~/.ssh` and the keychain are denied unconditionally, for shell reads
as well as writes.

A valid brief never widens the boundary, and being inside the boundary never
substitutes for a brief.

### Talk to the Lead, not to a Peer

This follows from brief-gating and is the one operating rule worth memorising:
**sending a working Peer a plain chat message strips its write authority for that
turn**, because your message carries no brief. The Peer will say so and stop. Ask
the Lead instead; the Lead re-issues a proper brief.

Push is restricted to exactly
`git push -u origin HEAD:refs/heads/agent/<name>`. Force-push is denied in every
spelling (`-f`, `-uf`, `--force`, `--force-with-lease`, `--force-if-includes`,
`+refspec`), and so are `--amend`, `reset --hard`, `clean -f`, `branch -D`,
rebase, filter-branch, peer merges, `sudo`, recursive forced deletion,
publishing, daemon control and credential mutation.

## Model routing

Five classes so the Lead routes by task risk rather than habit. Every id was
verified against the live catalog on 2026-09-30; multipliers are the live values.

| Class | Primary | Fallback | |
| --- | --- | --- | --- |
| `MONITOR_ECONOMY` | `gpt-5.6-luna` 1.1x | `claude-haiku-4.5` 0.4x | scheduled sweeps |
| `FAST_READ` | `claude-haiku-4.5` 0.4x | `gpt-5.6-luna` 1.1x | lookup, summarise |
| `CODING_MEDIUM` | `claude-sonnet-5` 1.3x | `gpt-5.6-terra` 2.2x | bounded implementation |
| `REASONING_HIGH` | `claude-opus-5` 2.2x | `gpt-5.6-sol` 4.4x | refactor, root-cause |
| `REVIEW_HIGH` | `gpt-5.6-sol` 4.4x | `claude-opus-5` 2.2x | acceptance review |

A reviewer runs on a **different family** than the implementer. `preflight`
enforces this for `REVIEW_HIGH` and fails the check if both sides are the same
family: a model is a poor auditor of its own failure modes, and same-family
review reads as independent without being independent.

`node scripts/preflight.mjs` checks every id against the live inventory and
fails before an agent is ever created. It also compares the policy digest
recorded in each deployed runtime against this checkout, so a pull that was never
redeployed is caught — agents would otherwise keep enforcing the bounds that were
deployed last while every file check passed clean.

Reasoning effort is pinned on the launcher command line rather than chosen per
session, because Kiro's ACP surface reports `thinkingOptions: "none"` for every
model and Paseo therefore has no per-session control to offer.

## Common operations

```bash
./scripts/sync-all                    # regenerate all runtimes after editing an overlay
./scripts/verify --source             # validate the checkout without requiring an install
./scripts/verify                      # validate installed state, no daemon needed
./install --verify                    # installed state plus live provider inventory
node scripts/preflight.mjs --offline  # routing check without credentials
./scripts/export-runtime-snapshots    # sanitised per-role summary for comparing hosts
```

The lower-level scripts are maintenance interfaces used by the public lifecycle.
They are not alternate fresh-install commands; `./install --apply` is.

Repeating `./install --apply` is the upgrade path. It regenerates the three
runtimes, preserves your routing table and existing session data, and leaves the
Paseo config unchanged when the providers are already correct.

## What this does NOT do

Each of these has a cost, and stating it is cheaper than discovering it.

- **It is a policy layer, not a sandbox.** A write-mode Peer holds `shell`. The
  hook constrains which commands run, not what a process does once started.
- **`OWNED_SCOPE` and `EXCLUDED_SCOPE` are not enforced.** The brief declares
  scope; the enforced bounds are the workspace root and the protected-path deny.
  Scope discipline inside the workspace is convention backed by the reviewer
  reading the diff.
- **`permissions.rules` in the generated agent config does nothing on CLI 2.x.**
  It is emitted for forward compatibility with 3.x and is documented as inert.
  Nothing in the policy depends on it.
- **Parallel writers are unmodelled.** Read-only Peers parallelise; concurrent
  writers would need worktree isolation per writer.
- **No product layer.** There is no PRD, story or acceptance-criteria vocabulary.
  Every objective comes from a human.
- **Brief-gating has a usability cost.** Messaging a Peer directly makes it
  read-only for that turn. That is the mechanism working, not a bug.

## Compatibility

| Component | Version | Verified |
| --- | --- | --- |
| kiro-cli | 2.26.0 | 2026-09-30 |
| Paseo CLI / daemon | 0.8.0 / 0.9.2 | 2026-09-30 |
| Node | 22.18+ (tested on 24.13.1) | 2026-09-30 |

The agent engine is left at its default (**v2**). Under `--agent-engine v3` the
generated custom agent is not found and Kiro falls back to its built-in default,
which would silently drop every role bound.

Further reading: [architecture](docs/architecture.md) ·
[operations](docs/operations.md) · [model routing](docs/model-routing.md) ·
[acceptance](docs/acceptance.md) · [inventory](docs/inventory-20260930.md)

## License

MIT
