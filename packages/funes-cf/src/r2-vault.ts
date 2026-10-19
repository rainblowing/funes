// R2Vault — the R2 adapter of the Vault port (PLAN-0.5.0 item 34; ADR-0011 §The decision, record 24
// §4). It binds only a real R2 bucket: no S3-compatible stand-in (Garage ignores If-None-Match
// silently). The DO constructs it with its bucket binding and its hooks; this module names no
// binding (test/config.node.ts). The version is the R2 etag, opaque above this file.
import { isPagePath } from "funes-core";
import type { SwapResult, Vault, VaultEntry, VaultFile, VaultPath, VaultTx } from "funes-core";

/** One write the frame committed to: what the apply journal holds per write (record 24 S1). */
export interface StagedWrite {
  path: VaultPath;
  /** The etag the frame read, or null for create-once. */
  expect: string | null;
  bytes: Uint8Array;
  /** Lowercase hex sha256 of `bytes`: the put's integrity option, and how a refused put is
   *  recognised as already done. */
  sha256: string;
}

export interface R2VaultHooks {
  /** The commit point: make `writes` durable in DO storage before the first put. Once it resolves
   *  the change is never undone; a restart finishes it with `rollForward`. `out` is what the frame's
   *  `fn` returned (a `put_page`'s `writtenHash`), for the journal's receipt fields. */
  journal(writes: readonly StagedWrite[], out: unknown): Promise<void>;
  /** The fence (GLOSSARY): a durable write to DO storage immediately before put `step`. It throws
   *  when the instance is no longer current or the journal was abandoned, and the frame stops. */
  fence(step: number): Promise<void>;
  /** The 429 backoff's clock. Default: a real timer. */
  sleep?(ms: number): Promise<void>;
}

/** A put refused over bytes that are not its target: another writer touched canon (record 24
 *  "Conflict"). Nothing is undone; the caller keeps the journal as a conflict. */
export class R2Conflict extends Error {
  constructor(readonly path: VaultPath) {
    super(`funes: conflict on "${path}" — R2 holds bytes this journal did not write; the rest of the apply is abandoned`);
  }
}

const MAX_KEY_BYTES = 1024; // R2 "Object key length"
const BACKOFF_MS = [1000, 2000, 4000, 8000]; // record 24 §5: then the journal stays pending
const RETRYABLE = /\((10058|10001|10043)\)$/; // 429 TooManyRequests, and the two R2 says to retry

const toHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const digest = async (algo: string, b: Uint8Array) => toHex(await crypto.subtle.digest(algo, b));

export class R2Vault implements Vault {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly bucket: R2Bucket, private readonly hooks: R2VaultHooks) {
    this.sleep = hooks.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async read(path: VaultPath): Promise<VaultFile | null> {
    const o = await this.bucket.get(path);
    // An R2 get pairs the bytes with their etag, which is what a build records (ADR-0011).
    return o && { bytes: new Uint8Array(await o.arrayBuffer()), version: o.etag };
  }

  async *list(opts: { exclude?: (rel: string) => boolean } = {}): AsyncIterable<VaultEntry> {
    const dirs = new Map<string, boolean>(); // "<dir>/" -> excluded, asked once per listing
    const excludedDir = (path: string): boolean => {
      const segs = path.split("/");
      for (let i = 1; i < segs.length; i++) {
        const dir = segs.slice(0, i).join("/") + "/";
        if (!dirs.has(dir)) dirs.set(dir, opts.exclude?.(dir) ?? false);
        if (dirs.get(dir)) return true;
      }
      return false;
    };
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ cursor, limit: 1000 });
      for (const o of page.objects) {
        if (!isPagePath(o.key) || excludedDir(o.key) || opts.exclude?.(o.key)) continue;
        yield { path: o.key, version: o.etag };
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  /** Phase 0, then the commit. `tx.swap` only stages: it checks `expect` against R2 now, refuses
   *  what R2 or 0.5.0 would refuse, and records the write, so a throw from `fn` writes nothing. When
   *  `fn` returns, the journal is made durable, then each write goes out in staged order behind its
   *  fence. The receipt and index commit are the caller's, after this returns. */
  async atomically<T>(fn: (tx: VaultTx) => Promise<T>): Promise<T> {
    const staged: StagedWrite[] = [];
    const touched = new Set<VaultPath>();
    const tx: VaultTx = {
      swap: async (path, expect, next): Promise<SwapResult> => {
        if (touched.has(path)) throw new Error(`funes: a frame swaps "${path}" at most once`);
        touched.add(path);
        if (next === null) throw new Error(`funes: refusing to remove "${path}" — R2Vault never deletes in 0.5.0 (ADR-0011)`);
        if (new TextEncoder().encode(path).length > MAX_KEY_BYTES) {
          // `code` is the ADR-0010 reason the dispatcher answers with: phase 0's refusal, before any journal
          throw Object.assign(new Error(`funes: invalid — the key "${path.slice(0, 64)}…" is over R2's ${MAX_KEY_BYTES.toLocaleString("en")} bytes`), { code: "invalid" });
        }
        const cur = await this.bucket.head(path);
        if (expect === null ? cur !== null : cur?.etag !== expect) return { ok: false };
        staged.push({ path, expect, bytes: next, sha256: await digest("SHA-256", next) });
        // A single-part R2 etag is the MD5 of the bytes, so this is the version R2 will report.
        return { ok: true, version: await digest("MD5", next) };
      },
    };
    const out = await fn(tx);
    if (staged.length) {
      await this.hooks.journal(staged, out);
      await this.rollForward(staged);
    }
    return out;
  }

  /** Make each journaled write, in order, behind a fresh fence per attempt. A refused put over its
   *  target bytes is done (a restart re-driving a write that landed); over other bytes it is an
   *  `R2Conflict`. A 429 (or 10001/10043) retries after 1, 2, 4 and 8 s, then throws, leaving the
   *  journal pending for the next hold or the alarm. Recovery calls this with a pending journal. */
  async rollForward(writes: readonly StagedWrite[]): Promise<void> {
    for (const [step, w] of writes.entries()) {
      const onlyIf = w.expect === null ? new Headers({ "If-None-Match": "*" }) : { etagMatches: w.expect };
      let put: R2Object | null;
      for (let attempt = 0; ; attempt++) {
        await this.hooks.fence(step);
        try {
          put = await this.bucket.put(w.path, w.bytes, { onlyIf, sha256: w.sha256 });
          break;
        } catch (e) {
          const wait = BACKOFF_MS[attempt];
          if (wait === undefined || !RETRYABLE.test((e as Error).message)) throw e;
          await this.sleep(wait);
        }
      }
      if (put === null) {
        const now = await this.bucket.get(w.path);
        if (!now || (await digest("SHA-256", new Uint8Array(await now.arrayBuffer()))) !== w.sha256) throw new R2Conflict(w.path);
      }
    }
  }
}
