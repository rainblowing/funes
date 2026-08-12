# Contributing to funes

funes is the memory plane for AI agents — hybrid text + vector + graph recall, markdown-canonical,
local-first. Issues and PRs are welcome; this file is the short version of how the repo expects to be
worked on.

## Setup

```bash
bun install
bun run test        # lint:core + lint:dag + the suite
```

Bun is the primary runtime. Tests that download models (the E5 embedder, the cross-encoder reranker)
are excluded from `bun run test` by a name filter — run them explicitly if you touch that code.

## The two structural rules

Both are enforced by lints wired into `bun run test`, so CI will tell you before a reviewer does:

1. **`funes-core` stays edge-portable** (`bun run lint:core`). No `node:` / `bun:` / bare-package
   runtime imports and no runtime globals (`process.env`, `Bun.*`) — core has to run on a Worker.
   Type-only imports are fine (they erase). Anything needing node builtins goes in `funes-shared`.
2. **The package graph stays acyclic** (`bun run lint:dag`). Tiers, low to high:
   `funes-core` → `funes-shared` → `funes-libsql` / `funes-api` → `funes-engine`. A package may only
   import from a strictly lower tier. A cycle makes the packages unpublishable, which is exactly the
   bug this lint exists to prevent from coming back.

## Conventions that matter

- **Compact at ingest, not at recall** — extract structured facts; never store raw transcripts.
- **Supersede, don't delete** — temporal chains over hard deletes.
- **Ranking changes are versioned.** Recall ordering is pinned by golden fixtures. If you change
  ranking, you re-baseline the goldens *in the same commit* and say why in the message. Ranking
  changes should be justified against the judged fixture (per-set metrics with a frozen holdout),
  not tuned on the holdout.
- **Index-schema changes bump `INDEX_SCHEMA_VERSION`** and ship a migration path (libSQL migrates
  additively on a writer open; a read-only handle refuses rather than silently serving a stale shape).

## Commits

Conventional-commit prefixes (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`) with a scope where it
helps (`feat(recall):`). Explain *why* in the body — this repo's history is used as documentation.

## Security

Never commit secrets; `gitleaks` runs in CI over full history. If you find a vulnerability, open a
private security advisory rather than a public issue.
