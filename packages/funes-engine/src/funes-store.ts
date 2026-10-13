import type {
  MemoryItem, MemoryMeta, MemoryStore, RecallQuery, RecallResult, RememberInput, RememberManyResult,
} from "funes-core";
import { isTombstoned, normalizeRelationType } from "funes-core";
import type { FunesIndexStore } from "./store.ts";
import { fileToItem, fileToItemWithMeta } from "./markdown.ts";
import { withCoordination } from "./coordination.ts";
import { sanitizeText } from "./sanitize.ts";
import { closeSync, constants, copyFileSync, existsSync, fsyncSync, openSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { absFor, deleteMemoryFile, memoryId, patchFrontmatter, readMemoryFile, writeMemoryItem } from "./write.ts";
import { memoryZoneOf, withScopedWriteLock } from "funes-shared";

export interface FunesStoreOpts {
  /** Vault root; canonical memory files live under `<root>/<memoryDir>/`. */
  root: string;
  /** Agent-memory zone. Default: layout-detected — `out/out_memory` when an `out/` container
   *  exists at the root (vault-v2), else legacy `out_memory` (zones.ts memoryZoneOf). */
  memoryDir?: string;
  /** Injectable ISO clock (created/updated). Default `new Date().toISOString()`. */
  now?: () => string;
  /** D11/§3d sanitize hook applied to title+body before persisting. Default: the real H4
   *  normalizer (sanitize.ts) — override only in tests. */
  sanitize?: (text: string) => string;
  /** M1 extract-at-ingest compaction seam (S4): a HARNESS-injected async distiller applied to
   *  the body before sanitize. funes never names an LLM (the no-LLM rule) — the harness routes
   *  this through the star's llm: block, role=compaction. Absent = no compaction (default). */
  compact?: (text: string) => Promise<string>;
}

/**
 * The profile-A Library surface (D7, PLAN Amend 2026-06-08d): canonical **markdown** is written
 * FIRST (`out_memory/<id>.md`), then reflected into the derived index (a `FunesIndexStore`). Supersession
 * and tombstones live in the markdown so they survive `reindex` deterministically. This is the
 * surface a harness (Flue `SessionStore`, an MCP server, the CLI) consumes; the SessionStore
 * adapter is a thin wrapper added when Flue is wired (M1/C).
 */
export class FunesStore implements MemoryStore {
  private readonly root: string;
  private readonly memoryDir: string;
  private readonly now: () => string;
  private readonly sanitize: (t: string) => string;
  private readonly compact?: (t: string) => Promise<string>;

  // P3.15: explicit field, not a parameter property (non-erasable TS — Node's loader refuses it).
  private readonly index: FunesIndexStore;
  /** RAI-163: the key of the one host-local lock every canonical mutation of this vault takes. */
  private readonly vaultKey: string;

  constructor(index: FunesIndexStore, opts: FunesStoreOpts) {
    this.index = index;
    this.root = opts.root;
    this.memoryDir = opts.memoryDir ?? memoryZoneOf(opts.root);
    this.now = opts.now ?? (() => new Date().toISOString());
    this.sanitize = opts.sanitize ?? sanitizeText; // H4: identity seam closed at S3
    this.compact = opts.compact; // S4: compaction seam (harness-injected)
    // The REAL path: a vault reached through a symlink (Dropbox's CloudStorage alias) must not get a
    // second key. lockPathFor only resolve()s. A root that does not exist yet keys on its resolved path.
    try { this.vaultKey = realpathSync(opts.root); } catch { this.vaultKey = resolve(opts.root); }
  }

  /** H3 (GBrain): mutations are legal only on funes-written items under `out_memory/` — never a
   *  human-authored page, and never an absolute/traversing path. Closes the arbitrary-path write. */
  private assertOwned(id: string): void {
    if (!id.startsWith(`${this.memoryDir}/`) || id.includes("..") || id.startsWith("/")) {
      throw new Error(`funes: refusing to mutate "${id}" — only items under ${this.memoryDir}/ are mutable.`);
    }
  }

  // ── coordination (re-homing plan item 12; review major #4): every CANONICAL-vault mutation runs
  // under the cross-container vault transaction lock when FUNES_COORDINATION_DIR is set (the NAS
  // composition shares one lock.db with the git sidecar); unset ⇒ plain call-through (Mac
  // single-process, today's behaviour). The lock is reentrant per process, so supersede()'s
  // delegation into remember() nests instead of deadlocking. ──────────────────────────────────────

  /** P3.15: every canonical mutation runs as ONE indivisible operation — markdown write AND index
   *  update under the same cross-process lock, serialized against other async contexts in this
   *  process. Before this, writeMemoryItem landed on disk and the index took its own narrower lock
   *  afterwards, so two writers (MCP is spawned one process per session) could leave markdown from
   *  one request and index rows from another. withCoordination is the OUTER, optional
   *  cross-container lock; this is the inner one and is always on. */
  private withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
    // RAI-163 (PLAN-0.4.0 P6): the index lock alone does not serialize the VAULT. Surfaces on one
    // machine write different indexes — the surface and a stdio MCP the live index.db, a broker the
    // published gen-*.db it serves — so a broker `remember` and a local `supersede` of the same page
    // held different locks and could interleave a read-modify-write (RAI-155's carry, RAI-156's
    // restore). Every mutation now takes one lock keyed by the vault's real path first, with no
    // configuration; order: publication fence (caller) → coordination → vault → index. It is
    // host-local by construction, which is exactly the one-writer-machine model P6 relies on.
    return withScopedWriteLock(this.vaultKey, () => {
      const res = this.index.lockResource;
      return res ? withScopedWriteLock(res, fn) : fn();
    });
  }

  /** Every canonical mutation: coordination → vault lock → index lock → undo frame. */
  private mutation<T>(fn: (keep: (id: string) => void) => Promise<T>): Promise<T> {
    return withCoordination(() => this.withIndexLock(() => this.undoable(fn)));
  }

  /** RAI-156 (PLAN-0.4.0 item 19; Turso spike hazard F4b). Every mutation writes canonical markdown
   *  FIRST and the index second, so an index write that fails — an I/O error, a full disk, an
   *  unreachable primary — used to report failure after the vault had already changed, and nothing
   *  recorded that it had. `fn` calls `keep(id)` before it writes a page; `keep` copies the page
   *  aside (a sibling dotfile, which walkMd never reads) BEFORE the forward write, while space still
   *  exists — so a full disk fails the mutation there, with the vault untouched. If anything throws
   *  later, pages that did not exist are removed first (that frees space), then every copy is renamed
   *  back (that needs none). Held under the vault lock, so no other mutation sees the interim.
   *
   *  What it does not promise: the INDEX. A multi-input batch, or a supersede whose second index
   *  call fails, may leave a row the rollback cannot reach; the caller's error names it where known,
   *  and the next full reindex prunes it (ADR-0003: the index is derived). */
  private async undoable<T>(fn: (keep: (id: string) => void) => Promise<T>): Promise<T> {
    const saved = new Map<string, string | null>(); // id -> restore copy, or null: the page did not exist
    const keep = (id: string) => {
      if (saved.has(id)) return;
      const abs = absFor(this.root, id);
      if (!existsSync(abs)) { saved.set(id, null); return; }
      const copy = join(dirname(abs), `.${basename(abs)}.${process.pid}.${undoSeq++}.undo`);
      copyFileSync(abs, copy, constants.COPYFILE_FICLONE); // a clone where the filesystem has them
      saved.set(id, copy);
    };
    try {
      const out = await fn(keep);
      for (const copy of saved.values()) if (copy) rmSync(copy, { force: true });
      return out;
    } catch (e) {
      const stuck: string[] = [];
      const dirs = new Set<string>();
      for (const [id, copy] of saved) {
        if (copy !== null) continue;
        try { rmSync(absFor(this.root, id), { force: true }); dirs.add(dirname(absFor(this.root, id))); } catch { stuck.push(id); }
      }
      for (const [id, copy] of saved) {
        if (copy === null) continue;
        try { renameSync(copy, absFor(this.root, id)); dirs.add(dirname(copy)); } catch { stuck.push(id); }
      }
      for (const d of dirs) { try { const fd = openSync(d, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } } catch { /* best effort */ } }
      if (stuck.length) {
        throw new Error(`${(e as Error).message} — and the vault could not be put back for ${stuck.join(", ")}`, { cause: e });
      }
      throw e;
    }
  }

  async remember(inputs: RememberInput[]): Promise<RememberManyResult> {
    return (await this.mutation((keep) => this.rememberInner(inputs, keep))).result;
  }

  /** `keep` belongs to the caller's undo frame — supersede passes its own, so the successor page and
   *  the old page's patch go back together. Also reports which ids are tombstoned on disk and which
   *  pages it created, which supersede needs. */
  private async rememberInner(inputs: RememberInput[], keep: (id: string) => void): Promise<{ result: RememberManyResult; tombstoned: Set<string>; fresh: Set<string> }> {
    const items: MemoryItem[] = [];
    const ids: string[] = [];
    const tombstoned = new Set<string>();
    const fresh = new Set<string>();
    for (const raw of inputs) {
      // S4 compact-at-ingest: distill BEFORE sanitize (the distiller sees the raw content;
      // its output still passes the deterministic normalizer like any other input).
      const distilled = this.compact ? await this.compact(raw.body) : raw.body;
      const input: RememberInput = { ...raw, title: this.sanitize(raw.title), body: this.sanitize(distilled) };
      // C1: an explicit id must be owned — closes the arbitrary-path write AND supersede()
      // smuggling a foreign `next.id` through (supersede delegates here).
      if (input.id) this.assertOwned(input.id);
      input.id = memoryId(input, this.memoryDir);
      let prior = readMemoryFile(this.root, input.id);
      // A file already at this id is normally a PRIOR VERSION of this very item — the hash covers
      // title+body, so an id match means the payload matches and the write is an in-place update.
      // When the payload differs, it is a hash collision, and the code below would read the victim
      // as our own history and overwrite it: silent, permanent data loss. Widen the hash until the
      // name is free. Existing ids are untouched, because an identical payload still lands on its
      // original 6-char id.
      for (let width = 10; prior && (prior.data.title !== input.title || prior.body.trim() !== input.body.trim()); width += 4) {
        if (width > 64) throw new Error(`remember: could not find a free id for "${input.title}" — refusing to overwrite`);
        input.id = memoryId({ ...input, id: undefined }, this.memoryDir, width);
        prior = readMemoryFile(this.root, input.id);
      }
      // RAI-155 (PLAN-0.4.0 item 18): a prior file at this id IS this page — same title, same body (the
      // loop above made sure). A re-remember re-asserts what the page already records, so it writes
      // NOTHING: the page keeps its bytes, its tombstone, its trust, its links and its date. Before, the
      // page was rebuilt from the call, which the served `remember` barely fills — a verbatim
      // re-remember revived a supersede or a forget, demoted an elevation and dropped every link. And
      // keeping only the lifecycle would let an untrusted caller re-date or re-tag a trusted page.
      // Changing what a page records is a successor's job (supersede).
      if (!prior) {
        const ts = this.now();
        const meta: MemoryMeta = {
          ...(raw.meta ?? {}),
          // H4: default-untrusted at the write boundary. Trust lives in canonical frontmatter;
          // elevation is an explicit separate act (elevate()/CLI), never implied by a write.
          trust: raw.meta?.trust ?? "untrusted",
          created: raw.meta?.created ?? ts,
          updated: ts,
        };
        keep(input.id);
        fresh.add(input.id);
        writeMemoryItem(this.root, input, meta);
      }
      // Index what is ON DISK, through the parser reindex uses (the pattern link and elevate already
      // follow): the incremental row and a rebuilt row cannot disagree, a tombstoned page stays off
      // the index exactly as reindex keeps it off (isTombstoned), and a re-remember whose row went
      // missing puts it back (an unchanged row hash-skips).
      const onDisk = fileToItemWithMeta(absFor(this.root, input.id), this.root);
      ids.push(input.id);
      if (isTombstoned(onDisk.meta)) tombstoned.add(input.id);
      else items.push(onDisk.item);
    }
    const r = await this.index.remember(items);
    if (tombstoned.size) await this.index.remove([...tombstoned]);
    return { result: { ...r, ids }, tombstoned, fresh };
  }

  async recall(q: RecallQuery): Promise<RecallResult[]> {
    return this.index.recall(q);
  }

  async supersede(oldId: string, next: RememberInput): Promise<{ id: string }> {
    return this.mutation((keep) => this.supersedeInner(oldId, next, keep));
  }

  private async supersedeInner(oldId: string, next: RememberInput, keep: (id: string) => void): Promise<{ id: string }> {
    this.assertOwned(oldId);
    // 0.4.0 item 11: patchFrontmatter refuses a page whose frontmatter does not parse. Refuse HERE,
    // before the successor is written and indexed — the undo frame puts pages back, never rows.
    const old = readMemoryFile(this.root, oldId);
    if (old?.error !== undefined) {
      throw new Error(`supersede: the frontmatter of "${oldId}" does not parse (${old.error}) — fix the page's YAML first`);
    }
    // write + index the successor inside THIS undo frame (the lock frame is already held)
    const w = await this.rememberInner([next], keep);
    const newId = w.result.ids[0]!;
    // RAI-155: content is identity, so a successor whose title+body already exist lands ON that page
    // — and a re-remember keeps its tombstone. Superseding with it would retire the old page into a
    // successor nobody can recall (or into itself, or into a cycle). Refuse; the undo frame puts back
    // whatever the successor's write touched.
    if (newId === oldId || w.tombstoned.has(newId)) {
      throw new Error(
        `supersede: the successor's content is already the page "${newId}", which is ` +
        `${newId === oldId ? "the page being superseded" : "itself superseded or forgotten"} — a successor needs new content`,
      );
    }
    // `old` is still the page: rememberInner never rewrites one that exists, and newId !== oldId.
    if (old) {
      try {
        keep(oldId);
        patchFrontmatter(this.root, oldId, { superseded_by: newId, updated: this.now() });
        await this.index.remove([oldId]); // canonical kept, dropped from recall
      } catch (e) {
        // A NEW successor is indexed and its page is about to go back to nothing: take its row out
        // too, whatever threw — the copy, the patch (a full disk) or the index. A successor that
        // existed before keeps its row — its page comes back, and removing the row would drop a
        // live memory from recall with nothing to notice.
        if (!w.fresh.has(newId)) throw e;
        const undone = await this.index.remove([newId]).then(() => true, () => false);
        if (!undone) {
          throw new Error(`${(e as Error).message} — and "${newId}" stays indexed with no page until a full reindex, or a retry of this supersede`, { cause: e });
        }
        throw e;
      }
    }
    return { id: newId };
  }

  async link(fromId: string, toId: string, type = "related_to"): Promise<void> {
    return this.mutation((keep) => this.linkInner(fromId, toId, type, keep));
  }

  private async linkInner(fromId: string, toId: string, type: string, keep: (id: string) => void): Promise<void> {
    this.assertOwned(fromId);
    const f = readMemoryFile(this.root, fromId);
    if (!f) throw new Error(`link: no memory file for fromId "${fromId}"`);
    const edges = (Array.isArray(f.data.edges) ? [...(f.data.edges as Record<string, unknown>[])] : []);
    // N4: compare through normalizeRelationType so `related_to` and `related-to` (or any
    // underscore/hyphen variant) count as the SAME edge — no more spelling-twin duplicates.
    const want = normalizeRelationType(type);
    const exists = edges.some((e) => e?.target === toId && normalizeRelationType(String(e?.type ?? "related_to")) === want);
    if (!exists) edges.push({ type, target: toId });
    keep(fromId);
    patchFrontmatter(this.root, fromId, { edges, updated: this.now() });
    // reflect new edge into the derived index (edge change -> content hash changes -> re-indexed)
    await this.index.remember([fileToItem(absFor(this.root, fromId), this.root)]);
  }

  async forget(id: string, opts?: { hard?: boolean }): Promise<void> {
    return this.mutation((keep) => this.forgetInner(id, keep, opts));
  }

  private async forgetInner(id: string, keep: (id: string) => void, opts?: { hard?: boolean }): Promise<void> {
    this.assertOwned(id);
    keep(id);
    if (opts?.hard) {
      deleteMemoryFile(this.root, id); // true removal (only Dropbox history retains it on A)
    } else if (readMemoryFile(this.root, id)) {
      patchFrontmatter(this.root, id, { forgotten: true, updated: this.now() });
    }
    await this.index.remove([id]); // off-index either way
  }

  /** H4 explicit elevation: flip a funes-written item to trusted. A deliberate, separate act
   *  (CLI/human surface only — NOT exposed through the remote op-registry), recorded in the
   *  canonical frontmatter and trust-synced into the index. */
  async elevate(id: string): Promise<void> {
    return this.mutation((keep) => this.elevateInner(id, keep));
  }

  private async elevateInner(id: string, keep: (id: string) => void): Promise<void> {
    this.assertOwned(id);
    const f = readMemoryFile(this.root, id);
    if (!f) throw new Error(`elevate: no memory file for id "${id}"`);
    keep(id);
    patchFrontmatter(this.root, id, { trust: "trusted", updated: this.now() });
    await this.index.remember([fileToItem(absFor(this.root, id), this.root)]);
  }

  /** Close the underlying index handle. */
  async close(): Promise<void> {
    await this.index.close();
  }
}

let undoSeq = 0;
