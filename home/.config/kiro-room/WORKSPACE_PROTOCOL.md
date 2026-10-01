# Workspace protocol — TODO: project name

Copy this to `docs/WORKSPACE_PROTOCOL.md` in the project being governed and fill
in every `TODO`. It is loaded into every seat's context as a resource, so it is
the contract the whole harness is judged against.

A generated protocol that nobody read is worse than no protocol at all, because
it looks like a contract. `scripts/verify` checks that the template in this repo
still has its `TODO` markers, precisely so the unfilled version cannot be
mistaken for a finished one.

## Project identity

- **Repository**: TODO
- **Paseo workspace `project` field**: TODO
  This must match exactly what `paseo workspace ls` shows. A mismatch makes every
  owned agent read as foreign and any project-scoped reconcile refuse.
- **Default branch**: TODO
- **Remote**: TODO

## PROJECT_CRITICALITY

TODO: pick one and say why in one sentence.

- `EXPERIMENT` — breakage costs only time. Review is optional.
- `INTERNAL` — breakage affects the team. Review before merge.
- `PRODUCTION` — breakage affects users or money. Review plus a verified rollback
  path before merge.

## What is expensive to undo here

TODO: name the specific things in *this* repository that are hard or impossible
to reverse. Be concrete; "be careful" is not an answer. Examples of the shape
wanted:

- a database migration that drops a column
- a published package version
- a change to the auth boundary
- anything that writes to a third-party system

This list is what a reviewer checks against before accepting a candidate, and
what a Peer is expected to stop and escalate on rather than decide alone.

## Verification commands

TODO: the exact commands a Peer runs before returning a candidate.

```bash
# install
TODO

# test
TODO

# build / typecheck
TODO

# lint
TODO
```

If a command does not exist for this project, write `none` rather than leaving
the line blank, so a Peer knows it was a decision and not an omission.

## Scope conventions

TODO: which directories are normally owned by a single Peer, and which are
shared and therefore need a Lead decision before anyone writes to them.

Remember what is and is not enforced. `OWNED_SCOPE` and `EXCLUDED_SCOPE` in a
brief are declarations. The enforced bounds are the workspace root and the
protected-path deny list. Scope discipline inside the workspace is caught at
review, not at the tool call.

## Branch and integration

- Peers push only to `agent/<task-slug>`, and only as
  `git push -u origin HEAD:refs/heads/agent/<task-slug>`.
- Integration into TODO: default branch is the Lead's decision after review.
- Force-push, `--amend`, `reset --hard`, `clean -f` and history rewriting are
  denied for every seat.

## Review requirement

TODO: state when an independent review is mandatory for this project, and who
may waive it.

An independent review runs on a different model family than the implementer. A
same-family review reads as independent without being independent.
