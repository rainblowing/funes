// PLAN-0.5.0 item 48: `funes seed` (record 25 §6 step 4 and "A map that changed after the seed";
// record 29 §4b; ADR-0010 §Revision "The seed"). The one enqueuer beside the replica watcher: it
// sends the converter's approved bytes to the taste star's edge writer, and nothing else.
//
// It refuses unless the converter's `out/` lies outside every synced or versioned tree (outHome()'s
// guard: a cloud-synced folder, or under a directory holding `.git`, `star.yaml` or `.stfolder`), the
// pages in `out/` hash to the digest Vlad approved, and every input still has its manifest sha256.
// Then it enqueues one `put_page` per page into the replica's outbox and drains its own enqueues
// inline through item 30's drain until no proposal is pending: it runs before the resident
// `funes replica` exists. Two drainers do no harm: a second delivery answers `already-applied`.
//
// What the writer applied is kept in `seed.json` beside the outbox (machine state, path -> sha256),
// so a re-run sends nothing already applied, and after a changed map (the converter re-ran and Vlad
// approved a new digest) a changed page goes as a replace whose base is the writer's `writtenHash` for
// the applied page (the sent bytes' sha256 unless the writer changed a byte), a new page as a
// create-once, and a page whose item left the map is listed for Vlad: `put_page` cannot delete.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { assertWritable, historyPath, sameStar, type VaultFile } from "funes-core/internal";
import { withScopedWriteLock } from "../../funes-engine/src/write-lock.ts";
import { stateDirFor } from "../../funes-engine/src/funes-home.ts";
import { funesDbDir, readStarIdentity } from "../../funes-engine/src/factory.ts";
import { FolderVault } from "../../funes-engine/src/folder-vault.ts";
import { sha256Hex as sha256 } from "funes-core/internal";
import { parseFrontmatter } from "funes-core";
import { assertWriteAllowed } from "funes-core/internal";
import { resolveWriteDesignation } from "../../funes-engine/src/process-locus.ts";
import { readOwnerOnly } from "../../funes-engine/src/actor.ts";
import { endpointFor } from "./endpoints.ts";
import { backoff, drain, enqueue, listOutbox, mcpWriter, type WriterFactory } from "./outbox.ts";
import { probeRefusal } from "../src/proposal-protocol.ts";
import { assertReplicaLocation } from "./location.ts";
import { atomicWriteFile } from "../../funes-engine/src/write.ts";
import { render } from "funes-core";
import { pagesDigest } from "funes-core";


/** Every file under `out/`, by its `/`-separated relative path, as UTF-8 (fatal: the writer would
 *  refuse a page that is not). */
function readOut(outDir: string): Map<string, string> {
  if (!existsSync(outDir)) throw new Error(`seed: ${outDir} does not exist — run the converter first (fail-closed)`);
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const pages = new Map<string, string>();
  for (const e of readdirSync(outDir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const abs = join(e.parentPath, e.name);
    const rel = relative(outDir, abs).split(sep).join("/");
    // a dotfile (a Finder .DS_Store) or anything under a dot directory is no converter page
    if (rel.split("/").some((s) => s.startsWith("."))) continue;
    pages.set(rel, utf8.decode(readFileSync(abs)));
  }
  return pages;
}

/** The converter's manifest: the personal star the inputs were read from, and each input's path and
 *  sha256; a map also names its domain (an import names none). */
function readManifest(outHome: string): { vault: string; inputs: Array<{ rel: string; sha256: string; domain?: string }> } {
  const path = join(outHome, "manifest.json");
  if (!existsSync(path)) throw new Error(`seed: no ${path} — the converter writes it beside out/ (fail-closed)`);
  const m = JSON.parse(readFileSync(path, "utf8")) as { vault?: unknown; inputs?: unknown };
  if (typeof m.vault !== "string" || !Array.isArray(m.inputs) || m.inputs.length === 0) throw new Error(`seed: ${path} names no vault and inputs (fail-closed)`);
  return m as ReturnType<typeof readManifest>;
}

/** The inputs (the maps and the imports) whose bytes are no longer the sha256 the converter's
 *  manifest recorded. */
function changedInputs(outHome: string): string[] {
  const { vault, inputs } = readManifest(outHome);
  return inputs
    .filter((i) => { const abs = join(vault, String(i.rel)); return !existsSync(abs) || sha256(readFileSync(abs)) !== i.sha256; })
    .map((i) => String(i.rel));
}

/** `pages`: path -> the sha256 of the bytes sent and applied (what a re-run compares out/ against).
 *  `written`: path -> the writer's `writtenHash` where it is not that sha256 (the writer changed a
 *  byte): the base of the next replace, which must be the canonical page's hash. */
interface Ledger { v: 1; pages: Record<string, string>; written?: Record<string, string> }

export interface SeedResult {
  created: number;
  replaced: number;
  /** Pages the writer already holds as they are now: nothing sent. */
  unchanged: number;
  applied: number;
  refused: Array<{ path: string; reason: string }>;
  expired: string[];
  /** Applied pages whose item left the converter's output: listed for Vlad, never deleted. */
  removed: string[];
}

export async function seed(o: {
  star: string;
  digest: string;
  /** The replica folder (`~/taste`): its star.yaml names the star and the write locus; its outbox is the seed's. */
  vault: string;
  /** $TASTE_OUT: out/ and manifest.json. */
  outHome: string;
  stateDir?: string;
  endpointsPath?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  writer?: WriterFactory;
}): Promise<SeedResult> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const outDir = join(o.outHome, "out");
  assertReplicaLocation(outDir);
  const identity = readStarIdentity(o.vault);
  if (!identity.id || !sameStar(identity.id, o.star)) {
    throw new Error(`seed: ${o.vault}/star.yaml names ${JSON.stringify(identity.id)}, not ${o.star} (refused)`);
  }
  const pages = readOut(outDir);
  const got = pagesDigest(pages);
  if (got !== o.digest) throw new Error(`seed: the pages in ${outDir} hash to ${got}, not the approved ${o.digest} (refused)`);
  const changed = changedInputs(o.outHome);
  if (changed.length) throw new Error(`seed: the input ${changed[0]} changed since the converter ran — re-run the converter and approve its new digest (refused)`);

  const stateDir = o.stateDir ?? stateDirFor(o.vault);
  const dir = join(stateDir, "outbox");
  const ledgerPath = join(stateDir, "seed.json");
  const ledger: Ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : { v: 1, pages: {} };
  const res: SeedResult = { created: 0, replaced: 0, unchanged: 0, applied: 0, refused: [], expired: [], removed: [] };

  // a record still in the outbox for the same bytes (in flight, refused or expired) is not sent again
  const live = new Set(listOutbox(dir).records.filter((r) => r.op === "put_page").map((r) => `${r.args.path}\0${sha256(String(r.args.content))}`));
  for (const path of [...pages.keys()].sort()) {
    const content = pages.get(path)!;
    const h = sha256(content);
    const applied = ledger.pages[path];
    if (applied === h) { res.unchanged++; continue; }
    if (live.has(`${path}\0${h}`)) continue;
    const base = ledger.written?.[path] ?? applied;
    enqueue(dir, { starId: identity.id, op: "put_page", args: base ? { path, content, base } : { path, content } }, now());
    if (applied) res.replaced++; else res.created++;
  }
  res.removed = Object.keys(ledger.pages).filter((p) => !pages.has(p)).sort();

  for (let offline = 0; ;) {
    const records = listOutbox(dir).records;
    if (!records.some((r) => r.status === "pending")) break;
    const byId = new Map(records.map((r) => [r.proposalId, r]));
    const r = await drain({ vault: o.vault, dir, endpointsPath: o.endpointsPath, now, writer: o.writer });
    const written = new Map(r.answers.map((a) => [a.answer.proposalId, a.answer.writtenHash]));
    for (const id of r.applied) {
      const rec = byId.get(id);
      if (rec?.op !== "put_page") continue;
      const path = String(rec.args.path);
      const sent = sha256(String(rec.args.content));
      ledger.pages[path] = sent;
      // an already-applied answer may name no writtenHash: then the sent bytes' hash is the best known
      const w = written.get(id);
      if (w && w !== sent) (ledger.written ??= {})[path] = w;
      else if (ledger.written) delete ledger.written[path];
    }
    if (r.applied.length) atomicWriteFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    res.applied += r.applied.length;
    res.expired.push(...r.expired);
    for (const id of r.refused) {
      const a = listOutbox(dir).records.find((x) => x.proposalId === id);
      res.refused.push({ path: String(byId.get(id)?.args.path), reason: a?.answer?.reason ?? "refused" });
    }
    if (r.probe === "halted") throw new Error(`seed: the writer halted the endpoint (HTTP ${r.halt?.status}) — the outbox token is refused; funes outbox lists what is left`);
    if (r.probe.startsWith("refused")) throw new Error(`seed: ${r.probe}`);
    offline = r.probe === "unreachable" ? offline + 1 : 0;
    const left = listOutbox(dir).records.filter((x) => x.status === "pending");
    if (left.length === 0) break;
    await sleep(Math.max(offline ? backoff(offline) : 0, Math.min(...left.map((x) => x.nextAttemptAt)) - now()));
  }
  return res;
}

/** PLAN-0.5.0 item 49: the done gate (`funes seed --check`), run after `funes replica --once`. Every
 *  failing condition, one line each; empty when the seed is done:
 *  - the applied count (pages whose seed-ledger sha256 is the page's) equals the page count, and no
 *    proposal in the outbox is refused;
 *  - the edge's node count (its `health`, item 40) equals the page count;
 *  - the canon mirror equals `out/` byte for byte (its star.yaml and `.history/` aside);
 *  - every map (every manifest input) still has its manifest sha256: the stub step (item 50)
 *    replaces a map only on that sha256. */
export async function seedCheck(o: {
  vault: string;
  outHome: string;
  stateDir?: string;
  endpointsPath?: string;
  writer?: WriterFactory;
  /** Maps the stub step already replaced (their pre-image is kept): not a changed input. */
  stubbed?: ReadonlySet<string>;
}): Promise<string[]> {
  const outDir = join(o.outHome, "out");
  assertReplicaLocation(outDir);
  const identity = readStarIdentity(o.vault);
  if (!identity.id) throw new Error(`seed: ${o.vault}/star.yaml names no meta.id (fail-closed)`);
  const pages = readOut(outDir);
  const stateDir = o.stateDir ?? stateDirFor(o.vault);
  const fail: string[] = [];

  const ledgerPath = join(stateDir, "seed.json");
  const ledger: Ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : { v: 1, pages: {} };
  const unapplied = [...pages.keys()].sort().filter((p) => ledger.pages[p] !== sha256(pages.get(p)!));
  if (unapplied.length) fail.push(`applied ${pages.size - unapplied.length} of ${pages.size} pages — not applied: ${unapplied.join(", ")}`);
  const refused = listOutbox(join(stateDir, "outbox")).records.filter((r) => r.status === "refused");
  if (refused.length) fail.push(`${refused.length} proposal(s) refused — funes outbox lists them: ${refused.map((r) => `${String(r.args.path)} (${r.answer?.reason ?? "refused"})`).join(", ")}`);

  const edge = await edgeNodes(identity.id, identity.writeLocus, o.endpointsPath, o.writer ?? mcpWriter);
  if (typeof edge === "string") fail.push(`the edge: ${edge}`);
  else if (edge !== pages.size) fail.push(`the edge holds ${edge} nodes, not the ${pages.size} pages`);

  const mirror = join(stateDir, "canon");
  if (!existsSync(mirror)) fail.push(`no canon mirror at ${mirror} — run funes replica --once first`);
  else {
    const held = new Map<string, Buffer>();
    for (const e of readdirSync(mirror, { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue;
      const rel = relative(mirror, join(e.parentPath, e.name)).split(sep).join("/");
      if (rel !== "star.yaml" && !rel.startsWith(".history/")) held.set(rel, readFileSync(join(mirror, rel)));
    }
    const diff = [...new Set([...pages.keys(), ...held.keys()])].sort().flatMap((p) => {
      const m = held.get(p);
      if (!m) return [`${p} missing`];
      if (!pages.has(p)) return [`${p} extra`];
      return m.equals(Buffer.from(pages.get(p)!, "utf8")) ? [] : [`${p} differs`];
    });
    if (diff.length) fail.push(`the mirror differs from out/: ${diff.join(", ")}`);
  }

  for (const rel of changedInputs(o.outHome)) if (!o.stubbed?.has(rel)) fail.push(`the input ${rel} is not the manifest's sha256 — it changed since the converter ran`);
  return fail;
}

/** The edge's node count from its `health`, after the proposal-protocol handshake; or why not. */
async function edgeNodes(starId: string, writeLocus: unknown, endpointsPath: string | undefined, factory: WriterFactory): Promise<number | string> {
  const entry = endpointFor(starId, endpointsPath);
  if (!entry) return `this machine has no writer endpoint for ${starId}`;
  const w = factory({ url: entry.url, token: readOwnerOnly(entry.tokenFile, "token_file").trim() });
  try {
    const h = await w.call("health", {});
    if (!("answer" in h)) return `health unanswered (${"http" in h ? `HTTP ${h.http}` : h.error})`;
    return probeRefusal(h.answer, starId, writeLocus) ?? (typeof h.answer.nodes === "number" ? h.answer.nodes : "health names no node count");
  } finally {
    await w.close();
  }
}

export interface StubResult {
  /** Maps replaced by a link page now, each pre-image kept at `.history/<map path>/<sha256>`. */
  stubbed: string[];
  /** Maps a run before already replaced: their manifest pre-image is a history object. */
  already: string[];
}

/** PLAN-0.5.0 item 50: the stub step (record 25 §6 step 6; runbook R17). The operator's own act at
 *  the personal star's write locus (the write rule, RAI-324), the second named exception to H3 in
 *  ADR-0012's conversion frame: no proposal id, no receipt. Under the star's write lock, on
 *  `FolderVault.atomically`, per map the pre-image as a history object, then a link page replacing
 *  the map, conditional on the manifest's sha256 (best effort: a folder has no compare-and-swap). All
 *  maps swap in one frame, so a refused replace undoes every one. It refuses while the done gate
 *  (item 49) fails. A re-run finds the stubs (each map's pre-image already kept) and does nothing,
 *  the gate included. The incremental reindex of the personal star follows, as after
 *  `okf normalize --apply`. */
export async function stubMaps(o: {
  /** The taste replica (`~/taste`): its star.yaml names the star the stubs point at. */
  vault: string;
  /** $TASTE_OUT: out/ and manifest.json, whose `vault` is the personal star holding the maps. */
  outHome: string;
  stateDir?: string;
  endpointsPath?: string;
  writer?: WriterFactory;
  locus?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<StubResult> {
  const refuse = (msg: string) => Object.assign(new Error(`seed --stub: ${msg} (refused)`), { refused: true });
  const { vault: personal, inputs } = readManifest(o.outHome);
  const maps = inputs.filter((i): i is typeof i & { domain: string } => typeof i.domain === "string");
  if (!maps.length) throw new Error("seed --stub: the manifest names no map (no input carries a domain) — re-run the converter (fail-closed)");
  // RAI-324: the write rule, as every mutation — an undeclared personal star proceeds.
  assertWriteAllowed(resolveWriteDesignation(personal, { locus: o.locus, env: o.env }), "seed --stub"); // a refused name is an error, not a refusal
  const star = readStarIdentity(o.vault).id;
  if (!star) throw new Error(`seed --stub: ${o.vault}/star.yaml names no meta.id (fail-closed)`);
  const pages = readOut(join(o.outHome, "out"));
  const v = new FolderVault(personal);

  const classify = async () => {
    const todo: Array<(typeof maps)[number] & VaultFile> = [];
    const already: string[] = [];
    for (const m of maps) {
      const f = await v.read(m.rel);
      if (f && sha256(f.bytes) === m.sha256) todo.push({ ...m, ...f });
      else if (await v.read(historyPath(m.rel, m.sha256))) already.push(m.rel);
      else throw refuse(`${m.rel} is neither the manifest's sha256 nor a stub — it changed since the converter ran: re-run the converter, approve its digest and seed again`);
    }
    return { todo, already };
  };
  const first = await classify();
  if (!first.todo.length) return { stubbed: [], already: first.already };
  const fail = await seedCheck({ vault: o.vault, outHome: o.outHome, stateDir: o.stateDir, endpointsPath: o.endpointsPath, writer: o.writer, stubbed: new Set(first.already) });
  if (fail.length) throw refuse(`the done gate fails — ${fail.join("; ")}`);

  return withScopedWriteLock(funesDbDir(personal), async () => { // the personal star's write lock (RAI-309)
    const { todo, already } = await classify();
    await v.atomically(async (tx) => {
      for (const m of todo) {
        const hist = historyPath(m.rel, m.sha256);
        const dir = `items/${m.domain}/`;
        const count = [...pages.keys()].filter((p) => p.startsWith(dir)).length;
        const prior = parseFrontmatter(m.bytes).data.title;
        const title = typeof prior === "string" && prior ? prior : basename(m.rel, ".md");
        const next = new TextEncoder().encode(render({ title, type: "note" },
          `Moved to the taste star ${star}: ${count} pages under ${dir}. The map as it was is kept at ${hist}. Open it in Obsidian: obsidian://open?vault=taste\n`));
        assertWritable(hist, null, m.bytes);
        await tx.swap(hist, null, m.bytes); // { ok: false } = already there, which the name certifies
        assertWritable(m.rel, m.version, next);
        if (!(await tx.swap(m.rel, m.version, next)).ok) throw refuse(`${m.rel} changed between the read and the replace — no map stubbed`);
      }
    });
    return { stubbed: todo.map((m) => m.rel), already };
  });
}
