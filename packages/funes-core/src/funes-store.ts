// FunesStore, the kernel's write-through surface (RAI-313): every page write goes through the Vault
// port, every mutation holds the injected serializer. A host composes the four ports (vault, star,
// memoryDir, serialize): the engine's folder composition is `folderFunesStore` (funes-engine), the
// edge's is the StarDO writer (funes-cf).
import type { MemoryItem, MemoryMeta, MemoryStore, PageSwap, RecallQuery, RecallResult, RememberInput, RememberManyResult } from "./types.ts";
import { isTombstoned } from "./types.ts";
import { assertWritable, historyPath, isPagePath, type Vault, type VaultTx, type Version } from "./vault.ts";
import type { ServingIndex } from "./index-store.ts";
import { normalizePage, parseFrontmatter, textToItemWithMeta } from "./markdown.ts";
import { sanitizeText } from "./sanitize.ts";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { memoryId, memoryPageText, patchedPageText } from "./write.ts";
import type { Serialize } from "./mutex.ts";
import { isItemPath } from "./page-id.ts";
import { edgeKeysFromText, starIdentityFromText, type StarIdentity } from "./star-identity.ts";
import { scopeExcludesFromText, type ScopeExcludesResult } from "./scope.ts";
import { recallDeclarationFromText, type RecallDeclarationRead } from "./recall-planner.ts";

/** A page as FunesStore read it: its text, parsed, and the version every write to it expects. */
interface ReadPage { bytes: Uint8Array; text: string; data: Record<string, unknown>; body: string; malformed?: string; version: Version }

// keep a BOM, as readFileSync("utf8") did; `fatal: false` is the default, spelled out because
// workers-types requires it and funes-cf typechecks this module through the kernel
const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
const encoder = new TextEncoder();
const pagePath = (id: string) => `${id}.md`;
export const sha256Hex = (b: string | Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** ADR-0010's refused answer: an error whose `code` is the reason the dispatcher answers with. */
export type RefusalReason = "stale-base" | "not-found" | "invalid" | "protected-field" | "out-of-scope"; // `not-granted` is the grant check's (ops.ts); `out-of-scope` the scope guard's
export const refusal = (reason: RefusalReason, message: string, extra: { currentHash?: string } = {}): Error =>
  Object.assign(new Error(message), { code: reason }, extra);

/** The writer's own fields (ADR-0010): a `put_page` replace copies them from its base and refuses a
 *  change to one; a create-once may carry none. */
const PROTECTED = ["trust", "superseded_by", "supersedes", "forgotten", "created", "id", "generated"] as const;

/** The writer's record that it applied a proposal id (ADR-0010 "Receipts"): protocol state, never
 *  the index. The edge writer injects its DO SQLite table. */
export interface Receipt { proposalId: string; payloadHash: string; writtenHash?: string; appliedAt: string }
export interface Receipts {
  get(proposalId: string): Promise<Receipt | null>;
  put(r: Receipt): Promise<void>;
  /** Told in the hold, after the window and the lookup and before the apply: the receipt this apply
   *  will write if it lands. The edge writer's apply journal carries it, so a restart that finishes
   *  the apply writes it too (record 24 S1). */
  pending?(r: Pick<Receipt, "proposalId" | "payloadHash">): void;
}

export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DAY = 86_400_000;
/** A ULID's time (its first 10 Crockford characters, ms since the epoch). */
export const ulidTime = (id: string): number => [...id.slice(0, 10)].reduce((t, c) => t * 32 + CROCKFORD.indexOf(c), 0);

export interface FunesStoreOpts {
  /** The port every page read and write goes through (ADR-0011): a FolderVault at a folder, R2 at the edge. */
  vault: Vault;
  /** The star's live configuration: at a folder `star.yaml` through its stat memo (`folderStar`), at
   *  the edge the bundled copy. */
  star: () => StarConfig;
  /** Agent-memory zone: at a folder layout-detected — `out/out_memory` when an `out/` container
   *  exists at the root (vault-v2), else legacy `out_memory` (`memoryZoneOf`). */
  memoryDir: string;
  /** Injectable ISO clock (created/updated). Default `new Date().toISOString()`. */
  now?: () => string;
  /** D11/§3d sanitize hook applied to title+body before persisting. Default: the real H4
   *  normalizer (sanitize.ts) — override only in tests. */
  sanitize?: (text: string) => string;
  /** M1 extract-at-ingest compaction seam (S4): a HARNESS-injected async distiller applied to
   *  the body before sanitize. funes never names an LLM (the no-LLM rule) — the harness routes
   *  this through the star's llm: block, role=compaction. Absent = no compaction (default). */
  compact?: (text: string) => Promise<string>;
  /** The serializer every mutation holds (0.5.0 item 14; ADR-0011, record 24 §5): at a folder the
   *  star's write lock (`withScopedWriteLock`), at the edge the DO's one in-memory mutex (`serialize`). */
  serialize: Serialize;
  /** Where applied proposal ids are kept (ADR-0010 "Receipts"). The edge writer injects it; a host
   *  with none takes no proposals (RAI-313 Q12). */
  receipts?: Receipts;
  /** The taste star's page rules (ADR-0010 §Revision, record 24 §6 step 5): a create-once `put_page`
   *  names a path of the page-id rule (`isItemPath`), and `supersede` refuses an item page under
   *  `<memoryDir>/<domain>/` — an item changes only by a `put_page` replace. Both refuse `invalid`. */
  itemPages?: boolean;
  /** The trust a create-once `put_page` gets (H4; record 24 §6 step 10). Default `untrusted`, stamped.
   *  `zone`: no stamp, so the page takes its zone's default — the edge writer's choice only for its
   *  outbox grant, which carries Vlad's own seed and replica edits. */
  createTrust?: "untrusted" | "zone";
}

/**
 * The profile-A Library surface (D7, PLAN Amend 2026-06-08d): canonical **markdown** is written
 * FIRST (`out_memory/<id>.md`), then reflected into the derived index (a `FunesIndexStore`). Supersession
 * and tombstones live in the markdown so they survive `reindex` deterministically. This is the
 * surface a harness (Flue `SessionStore`, an MCP server, the CLI) consumes; the SessionStore
 * adapter is a thin wrapper added when Flue is wired (M1/C).
 */
export class FunesStore implements MemoryStore {
  /** Every page read and write goes through the port (ADR-0011); at a folder, a FolderVault. */
  private readonly vault: Vault;
  private readonly memoryDir: string;
  private readonly now: () => string;
  private readonly sanitize: (t: string) => string;
  private readonly compact?: (t: string) => Promise<string>;

  // P3.15: explicit field, not a parameter property (non-erasable TS — Node's loader refuses it).
  private readonly index: ServingIndex;
  private readonly serialize: Serialize;
  /** The star's live configuration (ADR-0011 "Star configuration"): its `memory.okf` says whether a
   *  write is held to the OKF floor (0.5.0 item 20). */
  private readonly star: () => StarConfig;
  private readonly receipts?: Receipts;
  private readonly itemPages: boolean;
  private readonly createTrust: "untrusted" | "zone";

  /** ADR-0015: the index is a `ServingIndex` — FunesStore calls remember, remove, recall and close. */
  constructor(index: ServingIndex, opts: FunesStoreOpts) {
    this.index = index;
    this.serialize = opts.serialize;
    this.vault = opts.vault;
    this.star = opts.star;
    this.memoryDir = opts.memoryDir;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.sanitize = opts.sanitize ?? sanitizeText; // H4: identity seam closed at S3
    this.compact = opts.compact; // S4: compaction seam (harness-injected)
    this.receipts = opts.receipts;
    this.itemPages = opts.itemPages === true;
    this.createTrust = opts.createTrust ?? "untrusted";
  }

  /** H3 (GBrain): mutations are legal only on funes-written items under `out_memory/` — never a
   *  human-authored page, and never an absolute/traversing path. Closes the arbitrary-path write. */
  private assertOwned(id: string): void {
    // RAI-313 Q3: one canonical spelling per page. An empty, `.` or `..` segment (so `a//b`, `a/./b`,
    // a leading or trailing `/`) would index as given, and one page would hold two rows after the
    // next reindex.
    if (!id.startsWith(`${this.memoryDir}/`) || id.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
      throw refusal("invalid", `funes: refusing to mutate "${id}" — only items under ${this.memoryDir}/ are mutable.`);
    }
  }

  /** Every canonical mutation: the serializer (at a folder, the star's write lock) → the vault's frame
   *  (ADR-0011). RAI-156 (PLAN-0.4.0 item 19): every mutation writes canonical markdown
   *  FIRST and the index second, so an index write that fails used to report failure after the vault
   *  had already changed. The frame puts every page the mutation swapped back if anything throws.
   *
   *  What it does not promise: the INDEX. A multi-input batch, or a supersede whose second index
   *  call fails, may leave a row the rollback cannot reach; the caller's error names it where known,
   *  and the next full reindex prunes it (ADR-0003: the index is derived). */
  private mutation<T>(fn: (tx: VaultTx) => Promise<T>): Promise<T> {
    return this.serialize(() => this.vault.atomically(fn));
  }

  /** One page, read through the port, with the version a write to it must expect. */
  private async readPage(id: string): Promise<ReadPage | null> {
    const f = await this.vault.read(pagePath(id));
    if (!f) return null;
    const text = decoder.decode(f.bytes);
    return { bytes: f.bytes, text, ...parseFrontmatter(text), version: f.version };
  }

  /** The one write: the OKF floor (`okfWrite`, unless the star's `memory.okf` is false), then
   *  `assertWritable` beside `assertOwned` (ADR-0011 "The guards"), then a swap on the version of
   *  `base` — no base is create-once. A page that moved since the read is a conflict (best effort at a
   *  folder), and the throw undoes the frame. Returns the bytes the page now holds — what the caller
   *  indexes — or null when it was removed, and the swap the index records the stat of (RAI-318;
   *  none for the byte-equal no-op). `floored`: the caller already ran okfWrite (put_page). */
  private async put(tx: VaultTx, id: string, base: ReadPage | null, text: string | null, floored = false): Promise<{ text: string | null; swaps: PageSwap[] }> {
    const path = pagePath(id);
    const expect = base?.version ?? null;
    if (text !== null && !floored && this.star().identity.capabilities.okf !== false) {
      const floored = okfWrite(path, text, base);
      if (floored === null) return { text: base!.text, swaps: [] }; // the byte-equal no-op: nothing to write
      text = floored;
    }
    const next = text === null ? null : encoder.encode(text);
    assertWritable(path, expect, next);
    const r = await tx.swap(path, expect, next);
    if (!r.ok) {
      throw new Error(`funes: conflict on "${path}" — it ${expect === null ? "appeared" : "changed"} outside funes since it was read; nothing was written`);
    }
    return { text, swaps: [{ id, version: r.version, hash: next && sha256Hex(next) }] };
  }

  async remember(inputs: RememberInput[]): Promise<RememberManyResult> {
    return (await this.mutation((tx) => this.rememberInner(inputs, tx))).result;
  }

  /** `tx` belongs to the caller's frame — supersede passes its own, so the successor page and the
   *  old page's patch go back together. Also reports which ids are tombstoned on disk and which
   *  pages it created, which supersede needs. */
  private async rememberInner(inputs: RememberInput[], tx: VaultTx): Promise<{ result: RememberManyResult; tombstoned: Set<string>; fresh: Set<string> }> {
    const items: MemoryItem[] = [];
    const ids: string[] = [];
    const tombstoned = new Set<string>();
    const fresh = new Set<string>();
    const swaps: PageSwap[] = [];
    for (const raw of inputs) {
      // S4 compact-at-ingest: distill BEFORE sanitize (the distiller sees the raw content;
      // its output still passes the deterministic normalizer like any other input).
      const distilled = this.compact ? await this.compact(raw.body) : raw.body;
      const input: RememberInput = { ...raw, title: this.sanitize(raw.title), body: this.sanitize(distilled) };
      // C1: an explicit id must be owned — closes the arbitrary-path write AND supersede()
      // smuggling a foreign `next.id` through (supersede delegates here).
      if (input.id) this.assertOwned(input.id);
      input.id = memoryId(input, this.memoryDir);
      let prior = await this.readPage(input.id);
      // A file already at this id is normally a PRIOR VERSION of this very item — the hash covers
      // title+body, so an id match means the payload matches and the write is an in-place update.
      // When the payload differs, it is a hash collision, and the code below would read the victim
      // as our own history and overwrite it: silent, permanent data loss. Widen the hash until the
      // name is free. Existing ids are untouched, because an identical payload still lands on its
      // original 6-char id.
      for (let width = 10; prior && (prior.data.title !== input.title || prior.body.trim() !== input.body.trim()); width += 4) {
        if (width > 64) throw new Error(`remember: could not find a free id for "${input.title}" — refusing to overwrite`);
        input.id = memoryId({ ...input, id: undefined }, this.memoryDir, width);
        prior = await this.readPage(input.id);
      }
      // RAI-155 (PLAN-0.4.0 item 18): a prior file at this id IS this page — same title, same body (the
      // loop above made sure). A re-remember re-asserts what the page already records, so it writes
      // NOTHING: the page keeps its bytes, its tombstone, its trust, its links and its date. Before, the
      // page was rebuilt from the call, which the served `remember` barely fills — a verbatim
      // re-remember revived a supersede or a forget, demoted an elevation and dropped every link. And
      // keeping only the lifecycle would let an untrusted caller re-date or re-tag a trusted page.
      // Changing what a page records is a successor's job (supersede).
      let written: string | undefined;
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
        // create-once: a page that appeared since the read conflicts
        const w = await this.put(tx, input.id, null, memoryPageText(input, meta));
        written = w.text!;
        swaps.push(...w.swaps);
        fresh.add(input.id);
      }
      // Index the page's bytes through the parser reindex uses: the incremental row and a rebuilt row
      // cannot disagree, a tombstoned page stays off the index exactly as reindex keeps it off
      // (isTombstoned), and a re-remember whose row went missing puts it back (an unchanged row
      // hash-skips). A fresh page indexes the bytes it wrote, never a read-back (0.5.0 item 14: at the
      // edge the write is only staged); a prior page indexes the bytes it was read as.
      const onDisk = textToItemWithMeta(written ?? prior!.text, pagePath(input.id));
      ids.push(input.id);
      if (isTombstoned(onDisk.meta)) tombstoned.add(input.id);
      else items.push(onDisk.item);
    }
    const r = await this.index.remember(items, swaps);
    if (tombstoned.size) await this.index.remove([...tombstoned]);
    return { result: { ...r, ids }, tombstoned, fresh };
  }

  async recall(q: RecallQuery): Promise<RecallResult[]> {
    return this.index.recall(q);
  }

  async supersede(oldId: string, next: RememberInput): Promise<{ id: string }> {
    return this.mutation((tx) => this.supersedeInner(oldId, next, tx));
  }

  private async supersedeInner(oldId: string, next: RememberInput, tx: VaultTx): Promise<{ id: string }> {
    this.assertOwned(oldId);
    if (this.itemPages && oldId.slice(this.memoryDir.length + 1).includes("/")) {
      throw refusal("invalid", `supersede: "${oldId}" is an item page — an item changes only by a put_page replace`);
    }
    // 0.4.0 item 11: patchFrontmatter refuses a page whose frontmatter does not parse. Refuse HERE,
    // before the successor is written and indexed — the undo frame puts pages back, never rows.
    const old = await this.readPage(oldId);
    if (old?.malformed !== undefined) {
      throw new Error(`supersede: the frontmatter of "${oldId}" does not parse (${old.malformed}) — fix the page's YAML first`);
    }
    // write + index the successor inside THIS undo frame (the lock frame is already held)
    const w = await this.rememberInner([next], tx);
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
    // `old` is still the page funes read: rememberInner never rewrites one that exists, and
    // newId !== oldId. An edit from outside funes since that read is a conflict, not overwritten.
    if (old) {
      try {
        const w = await this.put(tx, oldId, old, patchedPageText(old, oldId, { superseded_by: newId, updated: this.now() }));
        await this.index.remove([oldId], w.swaps); // canonical kept, dropped from recall
      } catch (e) {
        // A NEW successor is indexed and its page is about to go back to nothing: take its row out
        // too, whatever threw — the conflict, the patch (a full disk) or the index. A successor that
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

  /** ADR-0010 `put_page`: with no base a create-once, with one a compare-and-swap replace of the whole
   *  file. Over the port, in record 24 §6's order: the path (`isPagePath`, H3), the base, `sanitize` over
   *  the whole file, the writer's own fields (copied from the base; a create-once carries none and is
   *  stamped untrusted), normalization with the base's `type`, the byte-equal no-op, then the history
   *  object and the page in one frame. A refusal's reason rides as its `code`. */
  async putPage(path: string, content: string, opts: { base?: string } = {}): Promise<{ writtenHash: string }> {
    return this.mutation(async (tx) => {
      if (!isPagePath(path)) throw refusal("invalid", `put_page: "${path}" is not a page path`);
      const id = path.slice(0, -".md".length);
      this.assertOwned(id);
      if (this.itemPages && opts.base === undefined && !isItemPath(path, this.memoryDir)) {
        throw refusal("invalid", `put_page: "${path}" is not an item path (${this.memoryDir}/<domain>/<name>.md, lowercase ASCII, at most 900 bytes)`);
      }
      const cur = await this.readPage(id);
      const curHash = cur && sha256Hex(cur.bytes);
      if (opts.base !== undefined && !cur) throw refusal("not-found", `put_page: no page "${path}" to replace`);
      if (opts.base !== undefined && opts.base !== curHash) {
        throw refusal("stale-base", `put_page: "${path}" changed since its base was read`, { currentHash: curHash! });
      }
      const base = opts.base === undefined ? null : cur!;
      if (base?.malformed !== undefined) throw refusal("invalid", `put_page: the frontmatter of "${path}" does not parse (${base.malformed})`);
      const page = parseFrontmatter(this.sanitize(content));
      if (page.malformed !== undefined) throw refusal("invalid", `put_page: the payload's frontmatter does not parse (${page.malformed})`);
      const own: Record<string, unknown> = {};
      for (const k of PROTECTED) {
        if (!(k in page.data)) { if (base && k in base.data) own[k] = base.data[k]; continue; }
        if (!base || !(k in base.data) || !isDeepStrictEqual(page.data[k], base.data[k])) {
          throw refusal("protected-field", `put_page: "${k}" is the writer's own field — ${base ? "a replace keeps its base's" : "a create-once carries none"}`);
        }
      }
      if (!base && this.createTrust === "untrusted") own.trust = "untrusted"; // H4: default-untrusted at the write boundary
      let text = Object.keys(own).length ? patchedPageText(page, id, own) : this.sanitize(content);
      if (this.star().identity.capabilities.okf !== false) text = okfWrite(path, text, base) ?? base!.text;
      if (cur && sha256Hex(encoder.encode(text)) === curHash) return { writtenHash: curHash! }; // the byte-equal no-op
      if (!base && cur) throw refusal("stale-base", `put_page: "${path}" exists — a create-once refuses it`, { currentHash: curHash! });
      if (base) {
        // supersede, never delete: the overwritten bytes are kept, create-once (an existing one is success)
        const keep = historyPath(path, curHash!);
        assertWritable(keep, null, base.bytes);
        await tx.swap(keep, null, base.bytes);
      }
      const w = await this.put(tx, id, base, text, true); // floored above: normalize once
      const written = w.text!;
      const onDisk = textToItemWithMeta(written, path);
      if (isTombstoned(onDisk.meta)) await this.index.remove([id], w.swaps);
      else await this.index.remember([onDisk.item], w.swaps);
      return { writtenHash: sha256Hex(encoder.encode(written)) };
    });
  }

  /** ADR-0010 "Identity" and "Receipts", in the apply's own hold (record 24 §5): the id window (29
   *  days back, 1 ahead, on this writer's clock), then the receipt — a known id with the same payload
   *  hash answers `already-applied` with its stored `writtenHash`, with another hash `invalid` — then
   *  the apply. Only an applied proposal leaves a receipt. */
  async propose<T extends { writtenHash?: string }>(proposalId: string, payloadHash: string, apply: () => Promise<T>): Promise<T | { status: "already-applied"; writtenHash?: string }> {
    const receipts = this.receipts;
    if (!receipts) throw refusal("invalid", `proposal ${proposalId}: this host has no receipts port, so it takes no proposals`);
    return this.serialize(async () => {
      const now = Date.parse(this.now());
      const t = ulidTime(proposalId);
      if (now - t > 29 * DAY || t - now > DAY) {
        throw refusal("invalid", `proposal ${proposalId}: its time is outside the writer's window (29 days back, 1 day ahead)`);
      }
      const known = await receipts.get(proposalId);
      if (known) {
        if (known.payloadHash !== payloadHash) throw refusal("invalid", `proposal ${proposalId}: a known id with a different payload`);
        return { status: "already-applied" as const, ...(known.writtenHash ? { writtenHash: known.writtenHash } : {}) };
      }
      receipts.pending?.({ proposalId, payloadHash });
      const r = await apply();
      await receipts.put({ proposalId, payloadHash, ...(r.writtenHash ? { writtenHash: r.writtenHash } : {}), appliedAt: new Date(now).toISOString() });
      return r;
    });
  }

  async forget(id: string, opts?: { hard?: boolean }): Promise<void> {
    return this.mutation((tx) => this.forgetInner(id, tx, opts));
  }

  private async forgetInner(id: string, tx: VaultTx, opts?: { hard?: boolean }): Promise<void> {
    this.assertOwned(id);
    const f = await this.readPage(id);
    let swaps: PageSwap[] = [];
    if (f && opts?.hard) {
      swaps = (await this.put(tx, id, f, null)).swaps; // true removal (only Dropbox history retains it on A)
    } else if (f) {
      swaps = (await this.put(tx, id, f, patchedPageText(f, id, { forgotten: true, updated: this.now() }))).swaps;
    }
    await this.index.remove([id], swaps); // off-index either way
  }

  /** H4 explicit elevation: flip a funes-written item to trusted. A deliberate, separate act
   *  (CLI/human surface only — NOT exposed through the remote op-registry), recorded in the
   *  canonical frontmatter and trust-synced into the index. */
  async elevate(id: string): Promise<void> {
    return this.mutation((tx) => this.elevateInner(id, tx));
  }

  private async elevateInner(id: string, tx: VaultTx): Promise<void> {
    this.assertOwned(id);
    const f = await this.readPage(id);
    if (!f) throw new Error(`elevate: no memory file for id "${id}"`);
    const w = await this.put(tx, id, f, patchedPageText(f, id, { trust: "trusted", updated: this.now() }));
    await this.index.remember([textToItemWithMeta(w.text!, `${id}.md`).item], w.swaps); // never a read-back (item 14)
  }

  /** Close the underlying index handle. */
  async close(): Promise<void> {
    await this.index.close();
  }
}

/** The write-time OKF floor (PLAN-0.5.0 item 20; ADR-0012; record 20 Handed on): every canonical
 *  write at a folder writer passes it — after the protected-field check (ADR-0010; put_page's, item
 *  28), before the swap — so the page, the index row and any answer name one normalized page. A
 *  payload without `type` keeps its base's. Returns the bytes to store, or null when they equal the
 *  base's: the byte-equal no-op compares the NORMALIZED payload. Refuses `invalid` with the
 *  normalizer's reason, which for a malformed payload is the YAML error line. */
export function okfWrite(path: string, text: string, base: { text: string; data: Record<string, unknown> } | null): string | null {
  const t = base?.data.type;
  const n = normalizePage(text, { path, baseType: typeof t === "string" ? t : undefined });
  if ("invalid" in n) {
    throw Object.assign(new Error(`funes: refusing to write "${path}" — invalid (${n.invalid}): ${n.reason}`), { code: "invalid", reason: n.reason });
  }
  return base !== null && n.text === base.text ? null : n.text;
}

/** What the dispatcher reads of a star's `star.yaml` (ADR-0011 "Star configuration"): its identity
 *  (the grant check, the write designation) and its index scope (the check-retrieve-recheck). */
export interface StarConfig {
  identity: StarIdentity;
  scope: ScopeExcludesResult;
  /** ADR-0013: `memory.recall` — what a `where` may name, the served and the collapse keys. Read live
   *  like the scope, so an edit takes effect on the next call with no reindex. Absent ⇒ none declared. */
  recall?: RecallDeclarationRead;
  /** `memory.memory_dir` (the identity's), `memory.item_pages` (a boolean, else null) and
   *  `edge.mint.telegram_ids` (ids as decimal strings; absent is [], malformed is null). The edge
   *  requires the first two and refuses a null allowlist (ADR-0024). */
  memoryDir?: string | null;
  itemPages?: boolean | null;
  mintIds?: string[] | null;
}

/** A star's config from its `star.yaml` text, read once (ADR-0011 "Star configuration"): the edge
 *  DO loads its R2 copy once per instance (ADR-0024). */
export function starConfigFromText(text: string): StarConfig {
  const identity = starIdentityFromText(text);
  const { itemPages, mintIds } = edgeKeysFromText(text);
  return { identity, scope: scopeExcludesFromText(text), recall: recallDeclarationFromText(text), memoryDir: identity.memoryDir, itemPages, mintIds };
}
