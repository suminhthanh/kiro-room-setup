# Operations

A runbook for the human operating a Kiro Room. It assumes the architecture is
already understood; if not, read [architecture.md](architecture.md) first.

## One-time setup

Nothing in this document works until all five of these are true.

**1. Prerequisites on `PATH`.** Node 22.18 or newer (the policy is loaded as
`.mts` via type stripping), Bash, Git, `kiro-cli`, `paseo`, and `~/.local/bin` on
`PATH`. `./install` with no flags checks all of them and prints the versions it
found. `~/.kiro` must already exist and `kiro-cli whoami` must succeed — this repo
does not install or authenticate Kiro.

**2. Paseo must have been started at least once**, so `~/.paseo/config.json`
exists. The provider merge refuses to create that file; it only edits an existing
one.

**3. Apply, then reload, in that order and without a gap.**

```bash
cd ~/repos/kiro-room-setup
npm test                 # 168 tests, no npm install needed — zero runtime deps
./install                # read-only plan; writes nothing
./install --apply        # transactional, with backup and rollback
paseo daemon reload      # immediately
./install --verify
```

`paseo daemon reload` is not a suggestion. Paseo's provider snapshot manager
writes the whole provider set back into `config.json` on daemon start and on every
desktop reconnect, so an edit the running daemon never loaded is silently
clobbered. The failure mode looks exactly like the install not having happened.
Use `reload`, not `restart` — `restart` kills running agents.

**4. Fill in the workspace protocol for the project being governed.** Copy
`~/.config/kiro-room/WORKSPACE_PROTOCOL.md` to `docs/WORKSPACE_PROTOCOL.md` in
that project and replace every `TODO`. It is listed in each generated agent
config's `resources`, so it is loaded into every seat's context, and it is where
`PROJECT_CRITICALITY`, the verification commands, and the list of things that are
expensive to undo are recorded. `scripts/verify` deliberately fails if the
template in this repo still has no `TODO` markers, so the unfilled version cannot
be mistaken for a finished one.

The `Paseo workspace project field` line in that file matters operationally: it
must equal exactly what `paseo workspace ls` shows.

**5. Confirm the routing table resolves.** `./install --apply` seeds
`~/.kiro-room/model-routing.local.json` from the shipped example **only if it does
not already exist**, and never touches it again. Check it with
`node scripts/preflight.mjs`, which validates every id against the live catalog.

## The brief

Authority is recomputed from the brief in the current turn. A turn with no brief
is read-only. This block is the only thing that grants write or git authority.

Emit it exactly once, in the message that dispatches the work:

```
KIRO_ROOM_TASK_V1_BEGIN
ROLE: peer
TASK_ID: t-014
WORKSPACE: /Users/you/work/acme-api-t014
BRANCH: agent/t014-csv-export
OWNED_SCOPE: src/export/**, tests/export/**
EXCLUDED_SCOPE: docs/**, infra/**
AUTHORITY: read, write, git
MODEL_CLASS: CODING_MEDIUM
KIRO_ROOM_TASK_V1_END
```

### Field rules

All of these are enforced by `parseBrief` in `extensions/policy-core.mts`.

| Field | Required | Rule | Violation produces |
| --- | --- | --- | --- |
| `ROLE` | yes | one of `supervisor`, `lead`, `peer`; case-insensitive | `unknown ROLE in brief` |
| `TASK_ID` | yes | any non-empty string; use a stable id you can search for later | `missing required brief field: TASK_ID` |
| `WORKSPACE` | yes | must be **absolute** (start with `/`). Becomes the write root for the turn | `WORKSPACE must be an absolute path` |
| `AUTHORITY` | yes | comma-separated, drawn only from `read`, `write`, `git`. `NONE` and empty entries are dropped | `unknown AUTHORITY token in brief` |
| `BRANCH` | no | when present must match `agent/<name>`, where `<name>` is `[A-Za-z0-9._/-]+` | `BRANCH must match agent/<name>` |
| `MODEL_CLASS` | no | one of the five class names; case-insensitive | `unknown MODEL_CLASS in brief` |
| `OWNED_SCOPE` | no | comma-separated list. **Declaration only** — not enforced anywhere | — |
| `EXCLUDED_SCOPE` | no | same | — |

Structural rules on the block as a whole:

- Exactly one `BEGIN` and one `END`. Two of either is invalid, and `END` before
  `BEGIN` is invalid.
- Lines are `KEY: value`. Blank lines and lines starting with `#` are ignored. A
  line with no colon is an error, not a skipped line.
- A duplicate key is an error.
- Keys are upper-cased before matching, so `role:` and `ROLE:` both work.

**A malformed block denies everything, including reads.** Not just writes. This is
checked in `evaluate()` before the tool surface, the brief gate and the boundary,
and it is intentional: a malformed block means someone tried to grant authority
and got it wrong, which is a different situation from not asking for any. When
this happens, `userPromptSubmit` also prints the specific parse errors, so read
the message rather than guessing.

### Grant `git` sparingly

`git` authority unlocks exactly one push shape:

```
git push -u origin HEAD:refs/heads/agent/<name>
```

Every other shape is denied, including every spelling of force-push (`-f`, `-uf`,
`--force`, `--force-with-lease`, `--force-if-includes`, `+refspec`). Without `git`
in `AUTHORITY`, any mutating git command — `commit`, `push`, `merge`, `tag`,
`cherry-pick`, `revert`, `stash drop`, `worktree add|remove` — is denied.

## Talk to the Lead, not to a Peer

This is the one operating rule worth memorising, and it follows directly from
brief-gating rather than being an additional convention.

`userPromptSubmit` **overwrites** the turn record on every message. A plain chat
message contains no marker block, so `parseBrief` returns `{kind:'none'}`, the
record is replaced with that, and `preToolUse` for the rest of the turn sees a
turn with no brief. For a Peer that means no `write` **and** no `shell`, because
both are brief-gated on that seat.

So: sending a working Peer a plain chat message strips its authority for that
turn. The Peer will say so and stop. Asking it "are you nearly done?" mid-task
costs it the turn.

Address the Lead instead. The Lead re-issues a proper brief, and a re-issued
brief restores authority immediately because authority is recomputed per turn
with no memory of the previous one.

If you must interact with a Peer directly, include a valid brief in your message.
There is no other way.

## Dispatching work

The Lead does this; the operator should know what correct looks like so a
malformed dispatch is recognisable.

1. **Pick the routing class from the task's risk, not from habit.** See
   [model-routing.md](model-routing.md). Reviews run on a different family than
   the implementation they review.
2. **Pass the model explicitly** to `mcp__paseo__create_agent`. Never let a
   worker inherit a default — an inherited default is invisible in the cost
   report and unattributable in review.
3. **Label the agent** with `harness.owner`, `harness.run`, `harness.project`,
   `harness.role`, `harness.task`, `harness.retention`.

   `harness.project` must equal the Paseo workspace `project` field **exactly**.
   A mismatch makes every agent you own read as foreign, and a project-scoped
   reconcile then refuses rather than adopting them. Check the value with
   `paseo workspace ls` and copy it, do not retype it.
4. **Issue the brief in the same message that dispatches the work.** A brief sent
   in a follow-up message is a brief for that message's turn, and the dispatch
   turn will already have run read-only.
5. **Bind a review to an exact SHA**, so the reviewer cannot drift onto later
   commits.

## Fallback

Switch a class to its fallback model when, and only when, one of the documented
triggers fires. They are listed in `fallbackPolicy.triggers` in the routing table:

- the primary id is absent from the live provider inventory;
- the provider returns a quota, region or capacity error;
- the same tool loop fails repeatedly on the primary.

**Record the switch and its trigger in the brief that dispatched the work.** This
is an obligation, not a courtesy: `fallbackPolicy.obligation` states that an
unrecorded switch makes cost attribution and review provenance unreadable. Six
weeks later, a task that cost 4.4x with no note explaining why is indistinguishable
from a routing mistake.

Nothing automates the switch. There is no runtime fallback logic in this repo —
`preflight` fails closed on a bad id before an agent is created, and the human or
the Lead does the switching.

## After a git pull

```bash
cd ~/repos/kiro-room-setup
git pull
npm test
./install --apply
node scripts/preflight.mjs
```

Re-applying is the upgrade path. It regenerates the three runtimes, preserves
`~/.kiro-room/model-routing.local.json` and existing session data, and leaves
`~/.paseo/config.json` unchanged when the three provider keys are already correct.

The `preflight` run afterwards is the point of the exercise. It compares the
`policyDigest` stamped into each deployed turn record against the digest computed
from the checkout you just pulled. A pull alone changes the files you are reading
and changes nothing about what running seats enforce; without this check, agents
keep applying the bounds that were deployed last while every file-level check
passes clean. The failure message names the drifted records and tells you to
re-apply.

Two things the re-apply does not cover:

- **If the pull changed `home/.paseo/config.json.kiro-providers.json`**, the merge
  finds the three keys present with different content, reports them as conflicts,
  and the install dies with `provider merge failed`. That is the guard working.
  Inspect the difference, then run the merge deliberately:

  ```bash
  node scripts/merge-paseo-providers.mjs \
    --fragment home/.paseo/config.json.kiro-providers.json \
    --target ~/.paseo/config.json --dry-run
  ```

  and re-run with `--force` instead of `--dry-run` once you agree with the diff.
  `--force` overwrites the three managed keys; it still refuses to change
  anything else. Then `paseo daemon reload`.
- **A running seat does not pick up the new policy.** `kiro-room` re-syncs on
  launch, so restart the seat from Paseo to get the new bounds.

## Routine maintenance

```bash
./scripts/sync-all                    # regenerate all runtimes after editing an overlay
./scripts/verify --source             # validate the checkout, no install required
./scripts/verify                      # validate installed state, no daemon required
./install --verify                    # installed state plus live provider inventory
node scripts/preflight.mjs --offline  # routing check with no credentials
./scripts/export-runtime-snapshots    # sanitised per-role summary for comparing hosts
```

These are maintenance interfaces used by the public lifecycle, not alternate
fresh-install commands. `./install --apply` is the install.

`~/.kiro-runtime/<role>` is fully derived and safe to delete; the next seat launch
regenerates it. The two exceptions are `sessions/`, which holds conversation
state, and `kiro-room-state/`, which holds the per-turn authority records — both
are lost on deletion, and losing a turn record mid-session makes that session
read-only until the next message re-establishes one.

`~/.kiro-room-backups` is never pruned automatically. One directory accumulates
per `--apply`.

## Troubleshooting by policy code

A denied tool call returns `kiro-room policy [code]: reason`. The code is stable
and is the fastest route to the cause. Codes below are exactly those emitted by
`extensions/policy-core.mts`; a code not in this table does not exist.

Do not retry a denied call in a different spelling. Every deny here is a rule with
a reason, and the spellings were enumerated deliberately.

### Brief and authority

| Code | What happened | What to do |
| --- | --- | --- |
| `brief.invalid` | The marker block is present but malformed, so the turn grants nothing at all — reads included | Read the parse errors in the message; they name the exact field. Fix the block and resend. Do not strip the block to "get reads back": that works, but it also silently drops the write grant you intended |
| `brief.write_not_granted` | `write` was attempted with no brief, or with a brief whose `AUTHORITY` omits `write` | If the message carried no brief, this is the talk-to-the-Lead rule biting. Ask the Lead to re-issue. If the brief was present, add `write` to `AUTHORITY` |
| `brief.shell_not_granted` | A **Peer** attempted `shell` with a brief granting no authority at all | Grant at least `read` in `AUTHORITY`. An empty authority list disables the Peer's shell entirely; this is the only gate that keys on authority being non-empty rather than on a specific token |
| `lead.write_disabled` | The Lead attempted `write` and `KIRO_ROOM_LEAD_WRITE=1` is not set on the seat | Delegate the write to a Peer. That is the design: a seat that both writes and accepts has no independent review step. Setting the variable is a deliberate operator act, not a workaround |
| `delegation.denied` | `delegate`, `subagent`, `agent` or `task` was called | Use `mcp__paseo__create_agent`. A Kiro-native sub-agent is a second control plane Paseo cannot see, bound or account for |
| `tool.not_in_role_surface` | The tool is not in this role's `unconditional` or `briefGated` list | Check the surface table in [architecture.md](architecture.md). Most common on a Supervisor attempting `write`, which that seat does not have at all. If the tool name looks like `mcp__…`, see the MCP caveat in architecture.md — that path is unverified |
| `tool.unhandled` | The tool passed the surface check but no rule covers it | A policy bug, not an operator error. `evaluate()` refuses to fail open. File it with the exact `tool_name` |
| `role.unknown` | `evaluate()` received a role that is not `supervisor`, `lead` or `peer` | The seat was launched wrong. Check `KIRO_ROOM_ROLE` in the provider `command`. A related failure has no code: the hook exits 2 with `KIRO_ROOM_ROLE=… is not one of supervisor\|lead\|peer` and blocks everything |

### Boundary

| Code | What happened | What to do |
| --- | --- | --- |
| `boundary.protected_path` | A write resolved inside one of the twelve protected prefixes | Never overridable, by any brief. If the work genuinely needs to change policy, runtime, control-plane or credential state, that is an operator action outside a seat |
| `boundary.outside_workspace` | A permitted write resolved outside the brief's `WORKSPACE` (or outside `cwd` when there is no brief) | Usually a relative path resolved against an unexpected `cwd`, or a `../` escape — traversal is normalised before the check, so it cannot be smuggled through. Either correct the path or have the Lead issue a brief whose `WORKSPACE` legitimately covers it |
| `boundary.missing_path` | A `write` call arrived with no recognisable target | The policy looks at `path`, `file_path`, `filePath`, `target` and `file`. A tool payload with none of them is a bug worth reporting |
| `shell.protected_path` | A shell command mentioned a protected path — **including for a read** | Use the `read` tool for ordinary configuration. Shell reads of credential and control-plane directories have no legitimate use from a seat, so this fires on any protected token anywhere in the command |

### Git

| Code | What happened | What to do |
| --- | --- | --- |
| `shell.push_without_git_authority` | `git push` with no `git` in `AUTHORITY` | Have the Lead re-issue the brief with `AUTHORITY: read, write, git`. Grant it only when the Peer genuinely needs to publish a branch |
| `shell.push_shape` | `git push` with `git` authority but the wrong shape | Use exactly `git push -u origin HEAD:refs/heads/agent/<name>`. The rejected command is echoed in the message — compare character by character |
| `shell.force_push` | Force-push in any spelling | Not overridable. If history genuinely has to be rewritten, the operator does it outside a seat |
| `shell.git_without_authority` | Some other mutating git command (`commit`, `merge`, `tag`, `cherry-pick`, `revert`, `stash drop`, `worktree add\|remove`) with no `git` authority | Same fix as `push_without_git_authority` |
| `shell.peer_merge` | A Peer ran `git merge` | A Peer never merges. Return the candidate; integration is the Lead's decision after review |
| `shell.amend` | `git commit --amend` | Make a new commit. A reviewer may already have seen the commit you would rewrite |
| `shell.reset_hard` | `git reset --hard` | Use `git stash`, or a new commit that reverts. `--hard` discards uncommitted work irrecoverably |
| `shell.clean_force` | `git clean -f` | Remove the specific files you mean, by name |
| `shell.branch_delete` | `git branch -D` or `--delete --force` | Leave the branch. Force-deleting can drop an unmerged review candidate |
| `shell.history_rewrite` | `git rebase`, `filter-branch` or `filter-repo` | Not available to a seat: history rewriting invalidates SHA-bound review evidence |
| `shell.remote_mutation` | `git push --delete`, or `git remote set-url\|remove\|rm` | Remote topology and remote branch deletion are operator decisions |

### Shell, everything else

| Code | What happened | What to do |
| --- | --- | --- |
| `shell.sudo` | `sudo`, `doas` or `su` | Privilege escalation is never available to a seat. If a task needs root, it is not a task for a seat |
| `shell.recursive_delete` | `rm` with recursive **and** force flags in any order or spelling | Delete specific paths, or use recursive without `-f` so the shell can refuse |
| `shell.control_plane` | `paseo daemon stop\|restart\|reload` | Operator only. Reloading or restarting the daemon disrupts every running agent |
| `shell.auth_mutation` | `kiro-cli login\|logout`, or `aws configure` | Credential state is operator-owned |
| `shell.publish` | `npm publish`, `gh release create`, `docker push` | Publishing is an external effect reserved for the operator. Report readiness instead |
| `shell.pipe_to_shell` | `curl`/`wget` piped into a shell | Download, read, then run — or add the dependency properly |
| `shell.ownership` | `chown`, `chgrp`, or `chmod -R` | Out of scope for a seat |
| `shell.empty` | An empty command | Tool-level noise; no operator action |

### Non-policy failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| `kiro-room: missing ~/.config/kiro-room; run ./install --apply first` | Seat launched before installing | `./install --apply`, then `paseo daemon reload` |
| `kiro-room-<role>` missing from `paseo provider ls` after `--apply` | The daemon never loaded the config edit, or overwrote it | `paseo daemon reload`, then `./install --verify`. `--verify` says this explicitly when a provider is absent |
| `preflight FAILED … is not in the live catalog` | A model id in the routing table does not exist in this account | Fix `~/.kiro-room/model-routing.local.json` against `kiro-cli chat --list-models --format json` |
| `preflight FAILED … deployed policy has drifted from this checkout` | Pulled without re-applying | `./install --apply` (or `./scripts/sync-all`), then restart the seats |
| `provider merge failed` during `--apply` | The three managed keys already exist with different content | See "After a git pull" above |
| `apply failed; rolling back from …` | Any step after the first write failed | The install is transactional and has already restored the prior state. The backup is preserved; read the error above the rollback line |
