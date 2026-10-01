# Convenience targets. Everything here is read-only with respect to the operator
# home except `install-apply`, which is deliberately not a default target.

SHELL := /usr/bin/env bash

.PHONY: help test check verify preflight plan snapshots test-container

help:
	@printf 'targets:\n'
	@printf '  test            run the full suite (zero dependencies)\n'
	@printf '  preflight       validate the routing table offline\n'
	@printf '  check           test + preflight + source verification\n'
	@printf '  verify          check installed state (needs an install)\n'
	@printf '  plan            print the install plan, writing nothing\n'
	@printf '  snapshots       sanitised per-role runtime summary\n'
	@printf '  test-container  run the installer twice against a throwaway HOME in Docker\n'

test:
	npm test

preflight:
	node scripts/preflight.mjs --offline

check: test preflight
	./scripts/verify --source

verify:
	./scripts/verify

plan:
	./install

snapshots:
	./scripts/export-runtime-snapshots

# Exercises the public installer against a fresh, fake operator home inside a
# container, so topology, repeatability and rollback are checked without touching
# the host. The model catalog fixture stands in for the live API, so no Kiro
# credentials are needed and none are mounted.
#
# The checkout is mounted read-only. The host's ~/.kiro, ~/.paseo, auth and
# sessions are never mounted or copied.
test-container:
	docker run --rm \
	  -v "$(CURDIR)":/repo:ro \
	  -w /work \
	  node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 \
	  bash -euo pipefail /repo/tests/container/run.sh
