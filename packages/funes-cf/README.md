# funes-cf

The edge writer: the Worker `funes-taste`, one per deployment, serving every star key in its R2 bucket (PLAN-0.5.0 item 33, ADR-0011, ADR-0024). A star is `/mcp/<key>` and `/mint/<key>`; its Durable Object is `STAR.getByName(key)` (class `StarDO`); its canon and its `star.yaml` are R2's `<key>/_/…`, which only the deploy login writes. It is private and never published.

## Tests

`npm test` runs the typecheck, then three vitest projects under Node 22: `config` (the wrangler configs' invariants), `workerd` (funes-taste under local workerd, serving the neutral fixture star of `test/fixture-star.ts`), and `probe` (funes-probe under local workerd). The test configs carry no `ai` binding. Workers AI, R2 and OpenRouter are local fakes, so the tests never touch the account.

The Bun-side edge cluster in `replica/` is not part of `npm test`: the repo root's `bun run test` typechecks it and runs its `*.test.ts` files.

## The edge cluster: `replica/`

The taste replica, its outbox, the writer-endpoint file, the seed and the replica's location refusal left the funes CLI in 0.6.0 (RAI-303). They are a dormant 1.0.0 edge process that runs under Bun from a funes checkout:

```sh
bun packages/funes-cf/replica/cli.ts replica|outbox|seed …
```

They import engine internals (a named seam: a change to one of them ports this folder in the same change). `replica/launchd/tech.funes.replica.plist` is the LaunchAgent template; it stays out of the public projection.

## Operator statements: `sql/`

The writer's `apply_journal` and `receipts` are never edited by hand (record 24 §4), except by the three sanctioned statements in `sql/`, each run once in Data Studio on the `STAR` namespace, in the object named by the star key:

| File | When |
|---|---|
| `abandon-journal.sql` | A journal that can never finish: `health` stays at `applyState: pending`. Replace `JOURNAL_ID`; the next hold turns the row into a conflict and re-indexes its pages from R2. |
| `delete-conflict.sql` | A `conflict` row you have read and whose pages you have repaired. Replace `JOURNAL_ID`. |
| `clear-seed-built.sql` | Once, after the seed's last apply, so the post-seed full build re-arms (Vlad, 2026-10-10). |

## Acting on the account: `scripts/cf-session.sh`

Every Cloudflare act runs inside one session (PLAN-0.5.0 item 36; record 24 §10):

```sh
scripts/cf-session.sh <act>…
```

The script logs in, runs the acts in argv order, and logs out from one `trap … EXIT`, so the logout also runs after a failed act. No write credential stays at rest on the machine. It takes no `--name` and no `--env`, and it refuses to start if `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_API_KEY` is set.

| Act | What it does |
|---|---|
| `deploy` | Runs this package's tests first and stops if they fail. Then `wrangler deploy` of funes-taste. Never `versions upload`, so every deploy is non-gradual. |
| `bucket-create <name>`, `bucket-delete <name>` | Creates or deletes an R2 bucket. The throwaway `funes-probe-spike` never outlives the session. |
| `secret-put <NAME> <worker>` | Puts a Worker secret on `funes-taste` or `taste-bot`. The value is one line of stdin, or a no-echo prompt on a terminal. It never goes on argv and is never echoed. |
| `deploy-bot` | Runs `../taste-bot/deploy.sh --in-session` (item 56) from the side-by-side checkout. |
| `probe` | Record 35 E7, the gate before the seed. Deploys `probe/` as `funes-probe` on workers.dev and pipes it a random per-session bearer. Calls it once and saves the report to `~/.funes/cf-probe/`. Then deletes the Worker and the throwaway bucket. |

Session A of the runbook (steps 10–11) runs as `scripts/cf-session.sh bucket-create <canonical> bucket-create funes-probe-spike probe`.

The probe report has two parts:
- `spike`: the real-R2 checks.
- `probe`: per length class (`short` under 128 bytes, `passage` otherwise), `byteEqual`, `maxAbsDelta` and `minCosine`. Also `pooling`, `shapes`, and the latency of each call. Item 38's canary tolerance is set from it (runbook 11b).

**Never `wrangler dev --remote`** (record 31). There is no local `ai` binding, so the deployed throwaway `funes-probe` is the only path to Workers AI. funes-taste's config has no `preview_bucket_name`, so a remote dev session fails closed.

## Terms

These two terms are edge-internal. `GLOSSARY.md` keeps a one-line pointer to each.

**Apply journal** (ADR-0011, ADR-0010's revision; RAI-173) — the edge write locus's record of one
change it has committed to but not finished: every write it will make to the vault, durable before the
first of them. A restart finishes the change from it; nothing undoes it. Only an operator can abandon
one, which leaves a conflict. Like a receipt, it is the writer's protocol state: not memory, not
execution lifecycle, and never kept in the index.

**Fence** (ADR-0011, RAI-173) — the edge write locus's write to its own storage, confirmed durable,
made before every write to the vault. The platform refuses it to an instance that is no longer
current, so a replaced instance cannot start a vault write; one it started before the replacement can
still land (the residual window). Not a lock: it orders nothing; it only stops a stale writer. Never
the publish lock.
