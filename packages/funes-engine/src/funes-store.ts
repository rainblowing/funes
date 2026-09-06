import type {
  MemoryItem, MemoryMeta, MemoryStore, RecallQuery, RecallResult, RememberInput, RememberManyResult,
} from "funes-core";
import { normalizeRelationType } from "funes-core";
import type { FunesIndexStore } from "./store.ts";
import { fileToItem } from "./markdown.ts";
import { withCoordination } from "./coordination.ts";
import { sanitizeText } from "./sanitize.ts";
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

  constructor(index: FunesIndexStore, opts: FunesStoreOpts) {
    this.index = index;
    this.root = opts.root;
    this.memoryDir = opts.memoryDir ?? memoryZoneOf(opts.root);
    this.now = opts.now ?? (() => new Date().toISOString());
    this.sanitize = opts.sanitize ?? sanitizeText; // H4: identity seam closed at S3
    this.compact = opts.compact; // S4: compaction seam (harness-injected)
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
    const res = this.index.lockResource;
    return res ? withScopedWriteLock(res, fn) : fn();
  }

  async remember(inputs: RememberInput[]): Promise<RememberManyResult> {
    return withCoordination(() => this.withIndexLock(() => this.rememberInner(inputs)));
  }

  private async rememberInner(inputs: RememberInput[]): Promise<RememberManyResult> {
    const items: MemoryItem[] = [];
    const ids: string[] = [];
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
      const ts = this.now();
      const meta: MemoryMeta = {
        ...(raw.meta ?? {}),
        // H4: default-untrusted at the write boundary. Trust lives in canonical frontmatter;
        // elevation is an explicit separate act (elevate()/CLI), never implied by a write.
        trust: raw.meta?.trust ?? "untrusted",
        created: (prior?.data.created as string) ?? raw.meta?.created ?? ts,
        updated: ts,
      };
      const written = writeMemoryItem(this.root, input, meta);
      written.trust = meta.trust; // index column mirrors the frontmatter
      items.push(written);
      ids.push(input.id);
    }
    const r = await this.index.remember(items);
    return { ...r, ids };
  }

  async recall(q: RecallQuery): Promise<RecallResult[]> {
    return this.index.recall(q);
  }

  async supersede(oldId: string, next: RememberInput): Promise<{ id: string }> {
    return withCoordination(() => this.withIndexLock(() => this.supersedeInner(oldId, next)));
  }

  private async supersedeInner(oldId: string, next: RememberInput): Promise<{ id: string }> {
    this.assertOwned(oldId);
    const { ids } = await this.remember([next]); // write + index the successor (reentrant lock frame)
    const newId = ids[0]!;
    if (readMemoryFile(this.root, oldId)) {
      patchFrontmatter(this.root, oldId, { superseded_by: newId, updated: this.now() });
      await this.index.remove([oldId]); // canonical kept, dropped from recall
    }
    return { id: newId };
  }

  async link(fromId: string, toId: string, type = "related_to"): Promise<void> {
    return withCoordination(() => this.withIndexLock(() => this.linkInner(fromId, toId, type)));
  }

  private async linkInner(fromId: string, toId: string, type: string): Promise<void> {
    this.assertOwned(fromId);
    const f = readMemoryFile(this.root, fromId);
    if (!f) throw new Error(`link: no memory file for fromId "${fromId}"`);
    const edges = (Array.isArray(f.data.edges) ? [...(f.data.edges as Record<string, unknown>[])] : []);
    // N4: compare through normalizeRelationType so `related_to` and `related-to` (or any
    // underscore/hyphen variant) count as the SAME edge — no more spelling-twin duplicates.
    const want = normalizeRelationType(type);
    const exists = edges.some((e) => e?.target === toId && normalizeRelationType(String(e?.type ?? "related_to")) === want);
    if (!exists) edges.push({ type, target: toId });
    patchFrontmatter(this.root, fromId, { edges, updated: this.now() });
    // reflect new edge into the derived index (edge change -> content hash changes -> re-indexed)
    await this.index.remember([fileToItem(absFor(this.root, fromId), this.root)]);
  }

  async forget(id: string, opts?: { hard?: boolean }): Promise<void> {
    return withCoordination(() => this.withIndexLock(() => this.forgetInner(id, opts)));
  }

  private async forgetInner(id: string, opts?: { hard?: boolean }): Promise<void> {
    this.assertOwned(id);
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
    return withCoordination(() => this.withIndexLock(() => this.elevateInner(id)));
  }

  private async elevateInner(id: string): Promise<void> {
    this.assertOwned(id);
    const f = readMemoryFile(this.root, id);
    if (!f) throw new Error(`elevate: no memory file for id "${id}"`);
    patchFrontmatter(this.root, id, { trust: "trusted", updated: this.now() });
    await this.index.remember([fileToItem(absFor(this.root, id), this.root)]);
  }

  /** Close the underlying index handle. */
  async close(): Promise<void> {
    await this.index.close();
  }
}
