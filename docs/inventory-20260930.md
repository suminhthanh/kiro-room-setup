# Inventory & feasibility spike — 2026-09-30

Read-only probe of the operator host. Every claim below was produced by a command
run on this machine, not inferred from documentation. Where documentation and
measurement disagree, the measurement wins and the disagreement is called out.

Probes wrote only into `mktemp -d` directories. Baseline hashes of
`~/.paseo/config.json`, `~/.kiro/settings/cli.json` and `~/.kiro/settings/mcp.json`
were captured before and re-checked after; all three were unchanged, and
`~/.kiro/agents/` was still empty.

## Versions

| Component | Version |
| --- | --- |
| `kiro-cli` | 2.26.0 |
| Paseo CLI | 0.8.0 |
| Paseo daemon | 0.9.2 (running, `127.0.0.1:6767`, PID 83481) |
| Node | v24.13.1 |
| jq | 1.8.1 |
| git | 2.54.0 |

`kiro-cli` is **2.x**, not 3.x. This matters: several fields in the public
`kiro.dev` agent-configuration reference are documented as "new in CLI 3.0" and
are **silently ignored** by 2.26.0. See [Enforcement](#enforcement-what-actually-holds).

## Model catalog (live)

19 models, default `auto`. Captured verbatim to `tests/fixtures/model-catalog.json`.

| Model id | Multiplier | Context |
| --- | --- | --- |
| `auto` | 1.0x | 1M |
| `claude-opus-5` | 2.2x | 1M |
| `claude-sonnet-5` | 1.3x | 1M |
| `claude-opus-4.8` | 2.2x | 1M |
| `gpt-5.6-sol` | 4.4x | 1M |
| `gpt-5.6-terra` | 2.2x | 1M |
| `gpt-5.6-luna` | 1.1x | 1M |
| `claude-opus-4.7` | 2.2x | 1M |
| `claude-opus-4.6` | 2.2x | 1M |
| `claude-sonnet-4.6` | 1.3x | 1M |
| `claude-opus-4.5` | 2.2x | 200K |
| `claude-sonnet-4.5` | 1.3x | 200K |
| `claude-sonnet-4` | 1.3x | 200K |
| `claude-haiku-4.5` | 0.4x | 200K |
| `deepseek-3.2` | 0.25x | 164K |
| `minimax-m2.5` | 0.25x | 196K |
| `minimax-m2.1` | 0.15x | 196K |
| `glm-5` | 0.5x | 200K |
| `qwen3-coder-next` | 0.05x | 256K |

All five routing classes resolve against this catalog, so the proposed table
needs no substitution:

| Class | Primary | Multiplier | Fallback | Multiplier |
| --- | --- | --- | --- | --- |
| `MONITOR_ECONOMY` | `gpt-5.6-luna` | 1.1x | `claude-haiku-4.5` | 0.4x |
| `FAST_READ` | `claude-haiku-4.5` | 0.4x | `gpt-5.6-luna` | 1.1x |
| `CODING_MEDIUM` | `claude-sonnet-5` | 1.3x | `gpt-5.6-terra` | 2.2x |
| `REASONING_HIGH` | `claude-opus-5` | 2.2x | `gpt-5.6-sol` | 4.4x |
| `REVIEW_HIGH` | `gpt-5.6-sol` | 4.4x | `claude-opus-5` | 2.2x |

Corrections to the planning assumptions:

- `claude-haiku-4.5` is **0.4x**, not the "cheapest Claude" guess; it is still
  the cheapest Claude tier available and cheaper than `gpt-5.6-luna`.
- `claude-opus-5.5` and `claude-fable-5.1` appear in the public docs but are
  **not in this account's catalog**. Neither is referenced by the routing table.
- `claude-opus-4.8` is 2.2x here, not the 2.0x the docs imply for Opus 5.5.

## Runtime isolation

`KIRO_HOME` behaves as required.

- `KIRO_HOME=<tmp> kiro-cli agent list` reported `Global: <tmp>/agents`, so the
  global agent directory follows the variable.
- On first use `kiro-cli` **creates** `<tmp>/settings/cli.json` (`{}`) and
  `<tmp>/agents/agent_config.json.example`. The sync generator must tolerate
  and preserve these rather than assume an empty tree.
- Workspace scope is resolved from the process CWD (`<cwd>/.kiro/agents`),
  independently of `KIRO_HOME`.

### Authentication is shared — isolation needs no auth symlink

`KIRO_HOME=<fresh tmpdir> kiro-cli whoami --format json` returned a valid
identity:

```
accountType  IamIdentityCenter
region       us-east-1
profile      KiroProfile-us-east-1
```

Credentials therefore live outside `KIRO_HOME`. Each role runtime inherits the
operator's login with no extra wiring and no repeated device flow. This was the
one finding that could have blocked the design; it did not.

## ACP surface

`kiro-cli acp` accepts more than the public docs show:

| Flag | Effect |
| --- | --- |
| `--agent <AGENT>` | agent for the first session |
| `--model <MODEL>` | model id for the first session |
| `--effort <EFFORT>` | `low`,`medium`,`high`,`xhigh`,`max` |
| `--agent-engine <ENGINE>` | `v1`, `v2` (**default**), `v3` |
| `--trust-all-tools` / `--trust-tools <LIST>` | approval posture |

So `--effort` **is** available in ACP mode — one of the open questions from
planning, now answered. It is set on the launcher command line.

Paseo's side of the same connection:

- `paseo provider models kiro --json` discovers all 19 models, every one with
  `"thinkingOptions": "none"`. Kiro's ACP does not advertise reasoning levels,
  so effort **cannot** be chosen per session from the Paseo UI. Pinning it in
  the launcher command is the only route.
- `paseo provider ls` lists the existing `kiro` provider as available with
  `MODES = kiro_default, kiro_planner, kiro_guide`. Paseo surfaces Kiro agents
  as ACP *modes*, which is why each role needs its own provider entry rather
  than one entry with three modes.

## Agent config schema on 2.26.0

`kiro-cli` writes its own example, which is the authoritative schema for this
version:

```
name, description, prompt, mcpServers, tools, toolAliases,
allowedTools, resources, toolsSettings, includeMcpJson, model
```

Tool tags accepted by 2.26.0:

```
read, write, shell, aws, report, introspect, knowledge,
thinking, todo, delegate, grep, glob
```

Note `delegate` — this is the sub-agent capability on 2.x, not the `subagent`
tag named in the 3.0 docs. Denying delegation means omitting `delegate`.

## Enforcement: what actually holds

Four mechanisms were tested by running a real cheap-model session in a tmpdir
`KIRO_HOME` and observing whether the guard bit.

| Mechanism | Validate | Actually enforced | Evidence |
| --- | --- | --- | --- |
| `hooks.preToolUse` (array form) | pass | **YES — blocks** | hook marker file written; tool reported `status: Failed` with "blocked by a pre-execution hook" |
| `hooks` object form | **schema error** | n/a | `data did not match any variant of untagged enum Repr` |
| `tools` allowlist | pass | **YES — removes tool** | agent with `tools:["read"]` had no shell; asked for its tool list it printed exactly `read` |
| `permissions.rules` | pass | **NO — silently ignored** | `{capability:"shell", match:["echo *"], effect:"deny"}` present, `echo permcheck` still ran to completion |
| `toolsSettings.execute_bash.deniedCommands` | pass | **NO — silently ignored** | `deniedCommands:["echo .*"]` present, `echo tscheck` still ran |

The two silent-ignore rows are the important ones. `kiro-cli agent validate`
returns success for `permissions.rules` on 2.26.0 and then the runtime does
nothing with it. A design that relied on that field would look enforced,
validate clean, and hold nothing.

Consequences adopted by this repo:

1. The `preToolUse` hook is **the** enforcement layer. Both the brief gate and
   the workspace-boundary deny are implemented there, because that is the only
   place measured to actually block a tool.
2. The `tools` allowlist is the second real bound: a capability absent from
   `tools` cannot be reached at all, which is stronger than denying it later.
3. `permissions.rules` is still emitted into generated agent configs for
   forward compatibility with CLI 3.x, and is documented as **not enforced on
   2.26.0**. Nothing in the policy depends on it.

`hooks.agentSpawn` did not fire under `chat --no-interactive` in either engine.
It is not on the enforcement path, so this was not pursued further; the repo
does not depend on `agentSpawn`.

Under `--agent-engine v3` the custom agent was not found at all
(`agent "hookprobe" not found, using "default"`, KAS 0.66.15). The v3 harness
resolves agents differently. This repo therefore targets the **default v2
engine** and does not pass `--agent-engine`.

## Still unverified — requires the operator to run `--apply`

These cannot be established without installing, which is out of scope here:

1. Whether `kiro-cli acp --agent kiro-<role>` resolves the generated agent when
   spawned by the Paseo daemon rather than by an interactive shell. `KIRO_HOME`
   is honoured by `agent list`, and ACP takes `--agent`, but the composed path
   through the daemon is untested.
2. Whether the Paseo daemon accepts the three new `extends: "acp"` provider
   entries and reports them `available` after `paseo daemon reload`.
3. Whether `paseoTools.enabled` is honoured on ACP providers by daemon 0.9.2.
   The field is undocumented in `docs/custom-providers.md` but is already
   present on `grok` and `hermes` in this operator's live config, so it is at
   least tolerated.
4. Whether the `preToolUse` hook fires on the ACP path as it does on the `chat`
   path. Same hook wiring, different transport.
5. End-to-end Lead delegation through `mcp__paseo__create_agent` with a routed
   model.
