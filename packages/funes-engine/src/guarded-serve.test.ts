import { test, expect } from "bun:test";
import type { Embedder } from "funes-core";
import { LibsqlStore } from "../../funes-libsql/src/index.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownStarExpectation, scopeHash } from "./scope.ts";

// H9 — the ATOMIC cross-star serve guard at the store level. The scope check and the content
// retrieval must be ONE guarded read (check-retrieve-recheck), never check-then-use: a reindex that
// re-admits excluded rows between the guard and the dispatch must REFUSE, never serve the row.

class FakeEmbedder implements Embedder {
  readonly dim = 16;
  private vec(t: string): Float32Array {
    const v = new Float32Array(this.dim);
    for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) v[[...w].reduce((a, c) => a + c.charCodeAt(0), 0) % this.dim]! += 1;
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= n;
    return v;
  }
  async embedQuery(t: string) { return this.vec(t); }
  async embedPassage(t: string) { return this.vec(t); }
  async embedPassages(ts: string[]) { return ts.map((t) => this.vec(t)); }
}

const HASH = scopeHash(["raw/**"]);

/** PLAN-0.3.0 item 16: `guardedRead` now takes the desired scope as a THUNK, re-evaluated on both
 *  checks, so a `star.yaml` that narrows mid-read refuses on the way out. These cases pin the BUILT
 *  scope's behaviour, where the desired half is fixed — this wraps a constant hash in the
 *  cross-star expectation (refuseWhileDirty: true), which is exactly what they asserted before. */
const xs = (hash: string) => () => ({ hash, refuseWhileDirty: true });


async function seeded() {
  const store = await LibsqlStore.create(new FakeEmbedder());
  await store.remember([{ id: "wiki/keep", path: "wiki/keep.md", title: "Keep", body: "alpha kept tokens", trust: "trusted" }]);
  await store.setScopeSignature({ hash: HASH, ignoreScope: false });
  return store;
}

test("guardedRead: boundary holds (matching hash, not ignored, not dirty) -> serves the rows", async () => {
  const store = await seeded();
  try {
    const res = await store.guardedRead(xs(HASH), () => store.recall({ query: "alpha kept tokens", k: 5 }));
    expect("ok" in res).toBe(true);
    if ("ok" in res) expect(res.ok.some((r) => r.id === "wiki/keep")).toBe(true);
  } finally { await store.close(); }
});

test("guardedRead: refuses on hash mismatch / --ignore-scope / missing signature at the FIRST check", async () => {
  const store = await seeded();
  try {
    const mm = await store.guardedRead(xs(scopeHash(["other/**"])), () => store.recall({ query: "alpha", k: 5 }));
    expect((mm as { refusal: string }).refusal).toContain("scope-hash mismatch");

    await store.setScopeSignature({ hash: HASH, ignoreScope: true });
    const ig = await store.guardedRead(xs(HASH), () => store.recall({ query: "alpha", k: 5 }));
    expect((ig as { refusal: string }).refusal).toContain("--ignore-scope");

    await store.clearScopeSignature();
    const missing = await store.guardedRead(xs(HASH), () => store.recall({ query: "alpha", k: 5 }));
    expect((missing as { refusal: string }).refusal).toContain("no index_scope signature");
  } finally { await store.close(); }
});

test("guardedRead: refuses while a reindex is IN PROGRESS at the first check (reindexDirty)", async () => {
  const store = await seeded();
  try {
    await store.beginReindex(); // dirty=1
    const res = await store.guardedRead(xs(HASH), () => store.recall({ query: "alpha", k: 5 }));
    expect((res as { refusal: string }).refusal).toContain("reindex is in progress");
    await store.finalizeReindex({ contentGeneration: "v2:" + "f".repeat(64) });
  } finally { await store.close(); }
});

test("guardedRead BARRIER: a reindex that STARTS between the guard-read and the dispatch refuses (re-check catches it) — the re-admitted row is never served", async () => {
  const store = await seeded();
  try {
    // s1 passes (clean, matching). The retrieve fires beginReindex — modelling a reindex that starts
    // AFTER the guard-read but before/while the content is fetched — then recalls. The post-retrieval
    // re-check sees reindexDirty and REFUSES, so the row the retrieve returned is never served.
    let retrieved = false;
    const res = await store.guardedRead(xs(HASH), async () => {
      await store.beginReindex();
      const rows = await store.recall({ query: "alpha kept tokens", k: 5 });
      retrieved = rows.length > 0; // the row WAS retrievable...
      return rows;
    });
    expect(retrieved).toBe(true);          // ...retrieval succeeded...
    expect("refusal" in res).toBe(true);   // ...but the guard refused rather than serve it
    expect((res as { refusal: string }).refusal).toContain("reindex is in progress");
    await store.finalizeReindex({ contentGeneration: "v2:" + "f".repeat(64) });
  } finally { await store.close(); }
});

test("guardedRead BARRIER: a full reindex that COMPLETES during retrieval with a DIFFERENT scope refuses on the re-check", async () => {
  const store = await seeded();
  try {
    // The reindex runs to completion inside the retrieval window AND re-stamps a different scope
    // (widened policy). s1 matched HASH; s2 sees the moved hash and refuses — nothing stale served.
    const res = await store.guardedRead(xs(HASH), async () => {
      await store.beginReindex();
      await store.setScopeSignature({ hash: scopeHash(["changed/**"]), ignoreScope: false });
      await store.finalizeReindex({ contentGeneration: "v2:" + "f".repeat(64) });
      return store.recall({ query: "alpha", k: 5 });
    });
    expect("refusal" in res).toBe(true);
    expect((res as { refusal: string }).refusal).toContain("scope-hash mismatch");
  } finally { await store.close(); }
});


// ── PLAN-0.3.0 item 16 — the DESIRED-scope half of the barrier ──────────────────────────────────
// The cases above all move the BUILT scope during a retrieval. Review R5 #15 named the other half:
// the desired hash was computed ONCE, before the read, so a `star.yaml` that NARROWED during the
// retrieval had its now-out-of-policy rows served anyway. `guardedRead` takes a thunk for exactly
// this — it re-evaluates local policy on the way out, not just on the way in.
test("guardedRead BARRIER (item 16): star.yaml that NARROWS during retrieval refuses on the re-check", async () => {
  const store = await seeded();
  try {
    let desired = HASH;
    let retrieved = false;
    const res = await store.guardedRead(() => ({ hash: desired, refuseWhileDirty: false }), async () => {
      const rows = await store.recall({ query: "alpha kept tokens", k: 5 });
      retrieved = rows.length > 0;
      desired = scopeHash(["raw/**", "secrets/**"]); // the operator narrows the manifest mid-read
      return rows;
    });
    expect(retrieved).toBe(true);        // the rows WERE retrievable under the old policy...
    expect("refusal" in res).toBe(true); // ...and are refused under the new one
    expect((res as { refusal: string }).refusal).toContain("scope-hash mismatch");
  } finally { await store.close(); }
});

test("guardedRead (item 16): a null expectation (no declared policy) serves, even with no built signature", async () => {
  const store = await LibsqlStore.create(new FakeEmbedder());
  try {
    await store.remember([{ id: "wiki/keep", path: "wiki/keep.md", title: "Keep", body: "alpha kept tokens", trust: "trusted" }]);
    // No signature stamped and none expected — a configless own-star vault. Refusing here would
    // take every configless index ever built off the air to enforce a policy nobody declared.
    const res = await store.guardedRead(() => null, () => store.recall({ query: "alpha kept tokens", k: 5 }));
    expect("ok" in res).toBe(true);
  } finally { await store.close(); }
});

// The case above moves a synthetic thunk. This one moves the REAL FILE, through the REAL
// `ownStarExpectation`, because that is the path the memo added on 2026-09-02 sits on:
// `readIndexScopeExcludes` now reuses a parse while star.yaml's (mtimeMs, size, ino) is unchanged.
// The property item 16 depends on is that a mid-read edit is STILL visible to the post-retrieval
// check — which a stat key preserves (an edit moves the key, so the second call re-reads) and a
// TTL memo would have destroyed silently, since an edit landing inside the window would be
// invisible to precisely the check that exists to catch it. A synthetic thunk cannot tell the two
// designs apart; this test can.
test("guardedRead (item 16): a star.yaml EDIT between the two checks is still detected through the real ownStarExpectation", async () => {
  const vault = mkdtempSync(join(tmpdir(), "funes-scope-memo-"));
  const manifest = join(vault, "star.yaml");
  writeFileSync(manifest, "memory:\n  index_scope:\n    exclude:\n      - 'raw/**'\n");
  const store = await seeded(); // built under exactly this scope
  try {
    const expected = ownStarExpectation(vault);
    expect((expected() as { hash: string }).hash).toBe(HASH); // the FIRST check passes
    let retrieved = false;
    const res = await store.guardedRead(expected, async () => {
      const rows = await store.recall({ query: "alpha kept tokens", k: 5 });
      retrieved = rows.length > 0;
      // the operator narrows the manifest WHILE the retrieval is in flight
      writeFileSync(manifest, "memory:\n  index_scope:\n    exclude:\n      - 'raw/**'\n      - 'secrets/**'\n");
      return rows;
    });
    expect(retrieved).toBe(true);        // retrievable under the policy that was in force...
    expect("refusal" in res).toBe(true); // ...and refused under the one that replaced it
    expect((res as { refusal: string }).refusal).toContain("scope-hash mismatch");
    // and the thunk itself now reports the NEW policy — a memo that had gone stale would still
    // be answering HASH here, with the refusal above coming from somewhere else entirely.
    expect((expected() as { hash: string }).hash).toBe(scopeHash(["raw/**", "secrets/**"]));
  } finally { await store.close(); rmSync(vault, { recursive: true, force: true }); }
});
