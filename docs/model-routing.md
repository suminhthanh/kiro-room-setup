# Model routing

Five classes, so the Lead routes by task risk rather than by habit. Every id was
verified present in this account's live catalog on 2026-09-30 and every multiplier
below is the live value, not the value in the public documentation — the two
disagree in places, and the measurement wins. The catalog was captured verbatim to
`tests/fixtures/model-catalog.json`.

## The table

| Class | Primary | Fallback | Use for |
| --- | --- | --- | --- |
| `MONITOR_ECONOMY` | `gpt-5.6-luna` **1.1x** | `claude-haiku-4.5` **0.4x** | scheduled sweeps, reconcile, heartbeat, status checks |
| `FAST_READ` | `claude-haiku-4.5` **0.4x** | `gpt-5.6-luna` **1.1x** | lookup, grep, summarise, "where is X" |
| `CODING_MEDIUM` | `claude-sonnet-5` **1.3x** | `gpt-5.6-terra` **2.2x** | bounded implementation, tests, fixes |
| `REASONING_HIGH` | `claude-opus-5` **2.2x** | `gpt-5.6-sol` **4.4x** | multi-file refactor, migration, root-cause, security |
| `REVIEW_HIGH` | `gpt-5.6-sol` **4.4x** | `claude-opus-5` **2.2x** | acceptance review, audit, sign-off |

Two of these look inverted and are not. `MONITOR_ECONOMY` has a 1.1x primary and a
0.4x fallback, so its fallback is the cheaper model — the primary is chosen for
behaviour on unattended sweeps, and the cheaper Claude tier is what it degrades
to. `FAST_READ` is the same pair in the opposite order. `claude-haiku-4.5` is
**0.4x**, which corrects a planning assumption that had it cheaper; it is still
the cheapest Claude tier in this account and still cheaper than `gpt-5.6-luna`.

Role defaults, from `roleDefaults` in the table:

| Seat | Default class | Model at launch | Effort at launch |
| --- | --- | --- | --- |
| `kiro-supervisor` | `MONITOR_ECONOMY` | `gpt-5.6-luna` | `low` |
| `kiro-lead` | `REASONING_HIGH` | `claude-opus-5` | `high` |
| `kiro-peer` | `CODING_MEDIUM` | `claude-sonnet-5` | `medium` |

The model in that table comes from `classes[roleDefaults[role]].primary`, and the
effort from `classes[roleDefaults[role]].effort`. Both are read by
`kiro-room-sync` and written into the runtime stamp, which is where the launcher
picks them up.

The role overlay (`~/.config/kiro-room/overlays/<role>.json`) also carries an
`effort`, and it is the fallback used when a class does not state one — so a
routing table written before the per-class field was added still produces a
usable runtime. When both are present the class wins, because the class is the
more specific statement about the work the seat does and keeping the decision in
one file is worth more than the flexibility of two.

To change a seat's reasoning posture, edit the class in
`~/.kiro-room/model-routing.local.json`, then re-sync.

Two models appear in the public documentation but are **not in this account's
catalog**: `claude-opus-5.5` and `claude-fable-5.1`. Neither is referenced by the
table. `claude-opus-4.8` is 2.2x here, not the 2.0x the docs imply for Opus
5.5.

## Reviewer on a different family

A reviewer runs on a different model family than the implementer. A model is a
poor auditor of its own failure modes, and same-family review reads as independent
without being independent. That is why `REVIEW_HIGH` is a GPT primary with a
Claude fallback while `REASONING_HIGH` is the mirror image: whichever family built
the change, the review class has a member of the other one.

**`preflight` enforces cross-family only for `REVIEW_HIGH`.** From `checkRouting`
in `scripts/preflight.mjs`:

```
} else if (cls === 'REVIEW_HIGH' && pf === ff) {
  problems.push(
    `REVIEW_HIGH: primary ${entry.primary} and fallback ${entry.fallback} are both ` +
      `${pf}. A reviewer must run on a different family than the implementer; ` +
      'same-family review reads as independent without being independent.',
  );
}
```

The check is scoped that narrowly because it is the only class where the
cross-family property is the point of the class. For the other four, a fallback in
the other family is a diversity-of-failure nicety; if the table were ever changed
to a same-family fallback for `CODING_MEDIUM`, nothing about the design would
break. For `REVIEW_HIGH`, a same-family fallback would mean that under quota
pressure the reviewer silently becomes the implementer's family and the
independence claim becomes false without any visible change — which is exactly the
failure a preflight check is for.

What `preflight` does **not** do is check that a specific review agent was
dispatched on a different family than the specific Peer that wrote the code. It
checks the table, not the dispatch. That obligation sits with the Lead and is
stated in `home/.config/kiro-room/prompts/lead.md` as non-negotiable.

Family is derived from the id prefix by `modelFamily()`: `/^claude[-.]/` is
`claude`, `/^gpt[-.]/` is `gpt`, and everything else is `other`.

## Classification

`classifyTask(description)` in `extensions/policy-core.mts` maps free text onto a
class. Read it as a written-down procedure rather than a runtime component: it is
exported and covered by `tests/policy-core.test.mjs`, but no script or hook calls
it. The Lead applies the procedure; the code makes it testable and unambiguous.

The implementation walks `CLASSIFY_RULES` in order and returns the first class with
any matching pattern. Order therefore is the tie-break, and it is
most-specific-first:

| # | Class | Patterns (English, then Vietnamese) |
| --- | --- | --- |
| 1 | `REVIEW_HIGH` | `review`, `audit`, `critique`, `acceptance`, `sign-off`/`sign off`/`signoff` · `duyệt`, `rà soát`, `kiểm tra chất lượng` |
| 2 | `REASONING_HIGH` | `refactor`, `architect`/`architecture`, `redesign`, `migrate`/`migration`, `root-cause`/`root cause`, `debug`, `multi-file`/`multi file`, `security` · `tái cấu trúc`, `thiết kế`, `phân tích nguyên nhân` |
| 3 | `MONITOR_ECONOMY` | `monitor`/`monitoring`, `sweep`, `watchdog`, `reconcile`, `heartbeat`, `status check` · `giám sát`, `quét` |
| 4 | `FAST_READ` | `grep`, `search`, `lookup`/`look up`, `find the`/`find all`/`find where`, `summary`/`summarise`/`summarize`, `where is` · `tìm`, `tra cứu`, `tóm tắt` |
| 5 | `CODING_MEDIUM` | `implement`, `add`, `fix`, `write`, `test`, `feature` · `triển khai`, `sửa`, `thêm` |

All patterns are case-insensitive and word-bounded. The Vietnamese patterns are
written with character alternations for the diacritics (for example
`/\bduy[ệe]t\b/i`), so both the accented and unaccented spellings match.

Two consequences of this shape are worth stating explicitly, because both are
asserted by tests:

**Review beats reasoning.** `"review this refactor of the auth layer"` classifies
as `REVIEW_HIGH`, not `REASONING_HIGH`, because rule 1 is checked first. That is
correct: reviewing a refactor is a review task, and the model doing it should be
the independent one.

**An unrecognised task defaults to `CODING_MEDIUM`, not to a cheap class.**
`classifyTask('zzzz qqqq')` and `classifyTask('')` both return `CODING_MEDIUM`
(1.3x). The fallback deliberately costs something. A cheap default would
under-resource every task whose description happened to use vocabulary the rules
do not cover, and the symptom of that — a weak model failing a task it should have
handled — is expensive and hard to attribute.

Also note that rule 5 is broad on purpose (`add`, `fix`, `write`, `test` catch
most ordinary work) while rule 4 is narrow (`find the`, not bare `find`), so an
implementation task phrased as "find and fix the off-by-one" lands in
`CODING_MEDIUM` rather than `FAST_READ`.

## Why no open-weight models

This account's catalog includes five open-weight ids at prices well below anything
in the table:

| Model | Multiplier | Context |
| --- | --- | --- |
| `qwen3-coder-next` | 0.05x | 256K |
| `minimax-m2.1` | 0.15x | 196K |
| `deepseek-3.2` | 0.25x | 164K |
| `minimax-m2.5` | 0.25x | 196K |
| `glm-5` | 0.5x | 200K |

None is used. This is the operator's decision — Claude and GPT only — and it is
enforced rather than merely documented. `checkRouting` fails the routing table if
either side of any class resolves to family `other`:

```
if (pf === 'other' || ff === 'other') {
  problems.push(
    `${cls}: only Claude and GPT ids are permitted ` +
      `(primary ${entry.primary}, fallback ${entry.fallback})`,
  );
}
```

So editing the table to route `FAST_READ` at `qwen3-coder-next` 0.05x makes
`node scripts/preflight.mjs` exit non-zero, and `./install --verify` fails with
it. The same rule rejects `auto`, which is also family `other`: a seat must know
which model it is running, and `auto` is the catalog default that would otherwise
be the easiest thing to fall into.

The exclusion is a governance choice, not a quality claim about those models. The
harness's output is judged on review provenance, and a table restricted to two
families keeps the cross-family review guarantee expressible as a simple
prefix check.

## Changing the table safely

The live table is `~/.kiro-room/model-routing.local.json`. It is operator-owned:
`./install --apply` seeds it from `config/model-routing.example.json` **only if it
is absent**, and never touches it again. Editing the example in the checkout does
not change what is in force.

```bash
# 1. confirm the id exists in this account
kiro-cli chat --list-models --format json | node -e '
  const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
  for (const m of j.models) console.log(m.model_id);'

# 2. edit the live table
$EDITOR ~/.kiro-room/model-routing.local.json

# 3. validate before anything runs on it
node scripts/preflight.mjs

# 4. regenerate the runtimes so a changed roleDefault reaches the seats
./scripts/sync-all
```

Step 3 is the whole safety property, and it checks five things beyond the id
existing:

- all five classes present, each with a `primary` and a `fallback`. A missing
  fallback is rejected, so a quota or region error degrades instead of stalling;
- each class carries a `reason` of at least 20 characters. A routing choice with
  no stated rationale is rejected outright;
- no unknown class names;
- `roleDefaults` present for all three roles, each naming a known class;
- `fallbackPolicy.triggers` non-empty and `fallbackPolicy.obligation` present.

Use `node scripts/preflight.mjs --offline` to run the same checks against the
captured catalog fixture instead of the live one — useful in CI or a container with
no credentials, but it validates against 2026-09-30's catalog, not today's.

Two things step 3 cannot tell you:

- **The provider allowlist is separate.** `~/.paseo/config.json` gives each
  `kiro-*` provider an explicit `models` array that **replaces** Paseo's
  discovered catalog, so an id not listed there cannot be selected from the Paseo
  UI even if the routing table names it. `scripts/verify --source` checks the
  shipped table against the shipped fragment ("every routed model id appears in a
  provider allowlist"), but after you edit the live table, cross-check
  `paseo provider models kiro-peer --json` yourself. Widen the fragment with
  `models`, never `additionalModels` — the latter appends to the discovered
  catalog instead of replacing it, reintroducing every model including the
  expensive ones, and `merge-paseo-providers.mjs` throws if it sees it.
- **A running seat keeps its old model.** `kiro-room` reads the model out of
  `~/.kiro-runtime/<role>/kiro-room.json` at launch and passes it as `--model`.
  Restart the seat from Paseo after `sync-all`.

## Effort is pinned, not chosen

`kiro-cli acp` accepts `--effort` with values `low`, `medium`, `high`, `xhigh`,
`max`, which answered an open planning question: effort **is** available in ACP
mode. But it cannot be chosen per session from Paseo, because
`paseo provider models kiro --json` reports `"thinkingOptions": "none"` for every
one of the 19 discovered models. Kiro's ACP surface does not advertise reasoning
levels, so Paseo has no control to offer.

Pinning it on the launcher command line is therefore the only route.
`home/.local/bin/kiro-room` reads `effort` from the runtime stamp and passes it:

```bash
exec env KIRO_HOME="$RUNTIME_HOME" KIRO_ROOM_ROLE="$ROLE" … \
  "$KIRO_BIN" acp --agent "kiro-$ROLE" --model "$MODEL" --effort "$EFFORT" \
  --trust-all-tools "$@"
```

The value originates in the role overlay, is recorded in the stamp by
`syncRole()`, and is read back by the launcher. To change a seat's reasoning
posture, edit `~/.config/kiro-room/overlays/<role>.json` — or better, the
checkout's copy plus `./install --apply`, so the change survives the next apply —
then restart the seat.

The provider fragment deliberately does not declare effort as a thinking option,
with a comment saying why, so that nobody adds one later and expects it to take
effect.
