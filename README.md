# funes

> *"To think is to forget differences, generalize, make abstractions. In the teeming world of Funes there were only details."* — Borges, *Funes the Memorious*

A memory layer for AI agents that keeps **markdown as the source of truth**. Recall fuses three arms
— full-text, vector, and a graph walk over the links you already write — with Reciprocal Rank
Fusion. The index is derived: you can delete it and rebuild it at any time. Your notes are just
files, and they stay yours.

Named for the man who remembered everything and understood nothing. funes is the inverse bet:
memory is useful only if it *forgets* — by superseding rather than deleting, and returning a ranked
handful instead of your history. (Compaction at ingest is a seam, not a feature: `FunesStore` takes
an optional distiller, the default is no compaction, and neither the CLI nor the MCP server supplies
one. Nothing shortens your text today.)

**Pre-1.0.** Interfaces will move. Read [Honest limits](#honest-limits) before relying on it.

## Install

```bash
npm i -g @funes-tech/cli
```

The dist-tag is derived from the version: a release with no prerelease suffix publishes under
`latest`, so a bare install gets the current one. The `alpha` tag is frozen on the `0.1.0-alpha`
line and no longer tracks releases — ask for it only to pin one of those old builds.

Two things to know before you run it:

- **The install is ~393 MB.** The embedding runtime (`onnxruntime-node`) and image codecs (`sharp`)
  dominate. There is no lighter path today — recall without the vector arm is not funes.
- **npm 11 will refuse to run their install scripts** and tell you to run `npm approve-scripts`.
  That is npm's supply-chain default, not something funes asks for.

## Quickstart

A star is a folder of markdown pages. No config file, no init step.

```bash
cd ~/notes                            # a star: a folder of markdown pages
funes reindex                         # read the pages into the index (re-run after you edit outside funes)
funes recall "what did we decide about the roof"
```

The index is derived: rebuild it any time with `funes reindex`. The first build downloads the
embedding model (about 135 MB). A recall never builds the index; over an empty one it says so.

Write a memory, then replace it with the id that `remember` printed:

```bash
funes remember --title "Roof start date" --body "Roofers start on 12 May."
funes supersede out_memory/roof-start-date-cb9ff3 --title "Roof start date" --body "Moved to 19 May."
```

Then give an agent access over MCP:

```bash
claude mcp add funes -- funes mcp     # the same ops as MCP tools, for an agent
```

That exposes eleven tools: `recall`, `page`, `tree`, `neighbors`, `graph`, `health`, `hotlist`,
`indexed_page`, and the mutations `remember`, `supersede`, `forget`. `recall` answers
`{ contentGeneration, results }`: the content stamp of the index that answered, and the ranked hits.

Agent writes land in `out_memory/<id>.md` as ordinary markdown, recorded **untrusted** — or in
`out/out_memory/` if your vault already has an `out/` directory, so read the path off the write
rather than assuming it. Trust is
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
mentions the term), and by an exact-name boost.

Results sharing a normalized **title** (with the same trust and zone) then collapse to their best
slot, carrying a `duplicates` count. This is title identity, not near-duplicate detection: bodies
and embeddings are never compared, so the same text under two titles survives twice, and two
unrelated pages both called "Meeting notes" fold together.

Supersession and tombstones live in the markdown frontmatter, not only in the index — so a rebuild
from scratch reproduces the same state. That is the design bet: **the database is disposable.**

Two things are honestly index-only, and a rebuild loses them: recall telemetry (`--stats` counters,
advisory and never used for ranking), and `writeActor`, the actor recorded against a write.
An ordinary reindex no longer overwrites a stamped `writeActor` with `unknown`, but it is still
last-writer-wins between real actors, and a from-scratch rebuild — `reindex --fresh`, or simply
a new index file — starts it empty. Treat it as provenance, not as an audit trail; the durable fix
is an append-only ledger.

## Honest limits

- **Pre-1.0.** Expect breaking changes until 1.0.0 freezes the contract.
- **Two backends.** libSQL for a home star. Turso (`memory.substrate: turso`) for an org star
  (`memory.tier: org`), which only its one `funes serve` opens; every other local open refuses.
- **Bun-first.** The CLI is tested on Node ≥ 22, Linux and macOS. Windows is unsupported.
- **Configless reindex skips** `node_modules`, `dist`, `build`, `vendor` and `target`, so pointing
  it at a code repo does not ingest your dependencies' docs. Declare `memory.index_scope.exclude` in
  a `star.yaml` to take control — a declared scope is authoritative and never silently extended.
  When the `star.yaml` of a scoped index goes away, `funes reindex` refuses: restore the file, or
  run `funes reindex --fresh` to rebuild without the scope.
- **The index lives outside your vault**, under the **funes home**: `~/.funes/`, or `$FUNES_HOME`
  when set. Every machine-local path derives from that one home; `funes home` prints it. On a
  machine where an older funes kept its state in `~/.twinkling/`, every command refuses until
  `funes home move` moves it.
- **The index refuses to live inside a sync root.** A live SQLite database whose `-wal`/`-shm` a
  provider copies independently is a torn database, not a replica, so an index path under a
  Syncthing, Dropbox or Resilio root refuses to open (the vault may be synced; the index may not).
  There is no override: set `FUNES_HOME` to a folder outside the sync root.
- **A Syncthing conflict copy is never a page.** `notes.sync-conflict-20260909-120000-ABCDEFG.md`
  is skipped by reindex whatever `star.yaml` says, and `funes doctor`
  lists every copy on disk — plus any an older index still serves — until you merge it by hand. A
  page that merely has the words in its name, like `how.sync-conflict-resolution.md`, is a page.
- **`funes serve` binds the exact address you name.** `--bind` takes an IP literal, never a
  wildcard. Off loopback it refuses to start without a version-2 `--access` file, an exact `--host`,
  the star's `write_locus` equal to this machine's locus and (home tier) a Tailscale address, and the
  home ceiling there drops `page`, `tree`, `neighbors`, `graph`, `supersede` and `forget`: the
  cross-star reads and `remember` stay. On loopback with no access file it
  serves tokenless reads only.
- **A write's actor comes from a grant, never from the request.** A stdio session under
  `FUNES_ACTOR_MAP` stamps its grant's actor; a server with many callers stamps `unknown`. No
  operation declares an actor argument, so there is nothing to ignore at runtime. `--actor` was
  removed in 0.6.0 and refuses.
- An error is one line. Only a bug (a `TypeError` and its kin) prints a stack trace.
- **Model weights cache in `<funes home>/models`** (135 MB; `funes --help` prints the resolved
  path). It is outside `node_modules` deliberately, so upgrading
  the CLI does not re-download them.
- `funes --help` lists every command. `--vault` defaults to the current directory.

## Numbers, and what they mean

On a frozen 63-query judged fixture, scored on a held-out slice: **MRR 0.873, hit@5 0.952**.

Read that carefully. `hit@5` asks whether the right document appeared anywhere in the top five. It
is not precision, and it is a much easier question — judged precision on the same fixture is lower.
The fixture is one person's vault, so the numbers describe *that* corpus, not yours.

What you can check, and what you cannot: the **method** is fully specified — 63 queries, a frozen
15 train / 27 dev / 21 holdout split, MRR and hit@5 computed on the holdout only, with the split
fixed before any tuning so the reported numbers are not fit to. The **corpus** is a personal vault
and is not publishable, so you cannot re-run these exact numbers. Point the same method at your own
notes; that is the number that should decide anything.

## License

MIT.
