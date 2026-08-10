# funes

> *"To think is to forget differences, generalize, make abstractions. In the teeming world of Funes there were only details."* — Borges, *Funes the Memorious*

A memory layer for AI agents that keeps **markdown as the source of truth**. Recall fuses three arms
— full-text, vector, and a graph walk over the links you already write — with Reciprocal Rank
Fusion. The index is derived: you can delete it and rebuild it at any time. Your notes are just
files, and they stay yours.

Named for the man who remembered everything and understood nothing. funes is the inverse bet:
memory is useful only if it *forgets* — by compacting at ingest, superseding rather than deleting,
and returning a ranked handful instead of your history.

**Alpha.** Interfaces will move. Read [Honest limits](#honest-limits) before relying on it.

## Install

```bash
npm i -g @funes-tech/cli@alpha
```

The alpha lives on the `alpha` dist-tag, so a bare `npm i @funes-tech/cli` will not pick it up.

Two things to know before you run it:

- **The install is ~393 MB.** The embedding runtime (`onnxruntime-node`) and image codecs (`sharp`)
  dominate. There is no lighter path today — recall without the vector arm is not funes.
- **npm 11 will refuse to run their install scripts** and tell you to run `npm approve-scripts`.
  That is npm's supply-chain default, not something funes asks for.

## Quickstart

Point it at a folder of markdown. No config file, no init step.

```bash
funes reindex --vault ./notes      # first run downloads the model — about 70s on a laptop
funes query "what did I decide about the roof" --vault ./notes
```

Then give an agent access over MCP:

```bash
claude mcp add funes -- funes mcp --vault ./notes
```

That exposes eleven tools: `recall`, `page`, `tree`, `neighbors`, `graph`, `health`, `hotlist`,
`indexed_page`, and the mutations `remember`, `supersede`, `forget`.

Agent writes land in `out_memory/<id>.md` as ordinary markdown, recorded **untrusted**. Trust is
stamped by the server and is never accepted from a tool argument; promoting a memory is a separate
human act (`funes elevate`). Every recall hit carries its trust label and file path, so a consumer
can weight or filter instead of believing everything equally.

## How it works

Every page is a node. Recall runs three arms and fuses them by **rank**, not by score:

- **FTS5**, title-weighted and unicode-aware — non-English text rides the full-text arm too.
- **Vector**, over 1800-character chunks with 200 of overlap, so a detail buried deep inside a long
  document is still reachable.
- **Graph**, a bounded walk over wikilinks and typed frontmatter edges.

Fused results are then adjusted by trust, by zone (a curated page outranks a raw import that merely
mentions the term), and by an exact-name boost, with near-duplicates collapsed.

Supersession and tombstones live in the markdown frontmatter, not only in the index — so a rebuild
from scratch reproduces the same state. That is the design bet: **the database is disposable.**

## Honest limits

- **Alpha.** Expect breaking changes.
- **One backend.** libSQL. A Postgres tier exists in the source but is not in this build and has
  never run against a live cluster.
- **Bun-first.** The CLI is tested on Node ≥ 22, Linux and macOS. Windows is unsupported. The
  daemon and HTTP serving faces are not part of this package.
- **Configless reindex skips** `node_modules`, `dist`, `build`, `vendor` and `target`, so pointing
  it at a code repo does not ingest your dependencies' docs. Declare `memory.index_scope.exclude` in
  a `star.yaml` to take control — a declared scope is authoritative and never silently extended.
- **The index lives outside your vault**, under `~/.twinkling/` in this release — a name inherited
  from the harness funes was extracted from. It moves to `~/.funes/` in a later release.
  `FUNES_LIBSQL_DIR` overrides it.
- `FUNES_DEBUG=1` turns a one-line error into a stack trace.

## Numbers, and what they mean

On a frozen 63-query judged fixture, scored on a held-out slice: **MRR 0.873, hit@5 0.952**.

Read that carefully. `hit@5` asks whether the right document appeared anywhere in the top five. It
is not precision, and it is a much easier question — judged precision on the same fixture is lower.
The fixture is one person's vault, so the numbers describe *that* corpus, not yours.

They are published anyway, with the caveat attached, because a benchmark you cannot interrogate is
worth nothing.

## License

MIT.
