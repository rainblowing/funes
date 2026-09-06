// The four-layer star-identity verifier (PLAN-0.2.1 step 12), extracted from the hub so `doctor`
// (step 24) audits through the SAME check rather than forming a second opinion about identity.
//
// The layers, and why there are four rather than one:
//   1. the caller's id ↔ the star's own `star.yaml`   — catches a stale catalogue
//   2. a published generation exists at all           — the hub and doctor read published only
//   3. the caller's id ↔ the generation MANIFEST      — catches a manifest paired with a foreign db
//   4. the caller's id ↔ the id INSIDE the db bytes   — the only layer that TRAVELS
//
// Layers 1-3 all stay behind when a generation file is copied somewhere else; only the stamp in
// the database bytes moves with the file, which is why layer 4 is re-checked on every open (and,
// in the hub, on every generation swap) instead of once at startup. The `owner-vault` marker does
// not cover this: it authenticates the DIRECTORY, so substituting another star's index.db under
// this path leaves the marker intact and lying.
//
// A basename collision is the concrete failure this prevents for doctor: two stars named `notes`
// resolve to publication homes under `~/.twinkling/libsql/notes/`, and an audit that skipped the
// check would report one star's dangling edges under the other star's name.
import { join } from "node:path";
import { refKey } from "funes-core";
import type { FunesIndexStore } from "funes-core";
import { readStarIdentity } from "./factory.ts";
import { readGenerationManifest, type GenerationManifest } from "./publication.ts";

/** Same star? Compare CANONICAL KEYS when both sides parse, else exact strings. A star re-declared
 *  under another access method (`dropbox://example.org/x` → `git://example.org/x`) is the same
 *  star; a different workname is not, whatever it is spelled with. ABSENCE never matches — a
 *  missing id is refused, never read as equal, because "we could not tell" and "they are the same"
 *  are the two answers an identity check must never conflate. */
export function sameId(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ka = refKey(a);
  const kb = refKey(b);
  return ka !== null && kb !== null ? ka === kb : a === b;
}

export interface StarIdentityCheck {
  /** The star's vault directory — the `star.yaml` side of the comparison. */
  path: string;
  /** The id the CALLER intends to serve or audit this star as. */
  id: string;
  /** The star's display name, as it should appear in a refusal. */
  name: string;
  /** The publication home holding `generation.json`. */
  home: string;
  /** How a refusal brands itself: `funes hub`, `funes doctor`. */
  who: string;
  /** What the caller's id came FROM, named in the refusal. */
  serves?: string;
  /** Appended to the no-publication refusal, where the caller's own instruction differs. */
  noPublicationHint?: string;
  /** Appended to the layer-1 refusal. The remedy genuinely differs by caller: a stale CATALOGUE is
   *  regenerated, a stale star.yaml is edited — so the advice cannot be one sentence for both. */
  staleHint?: string;
}

/** Layers 1-3. Returns the verified manifest, so the caller opens exactly what was checked rather
 *  than re-reading it and opening something else. Throws on every failure: a star whose identity
 *  does not line up is not degraded to a warning, because both callers would then answer in
 *  another star's name while printing a note about it. */
export function verifyPublishedStarIdentity(c: StarIdentityCheck): GenerationManifest {
  const serves = c.serves ?? "the catalogue";
  const declared = readStarIdentity(c.path);
  if (!sameId(declared.id, c.id)) {
    throw new Error(
      `${c.who}: identity mismatch for "${c.name}" — ${serves} says "${c.id}", ` +
      `${join(c.path, "star.yaml")} says "${declared.id ?? "(none)"}".${c.staleHint ? ` ${c.staleHint}` : ""}`,
    );
  }
  const manifest = readGenerationManifest(c.home);
  if (!manifest) {
    throw new Error(
      `${c.who}: "${c.name}" has no published generation in ${c.home} — ` +
      `run \`funes publish --vault ${c.path}\`${c.noPublicationHint ? ` ${c.noPublicationHint}` : ""}`,
    );
  }
  if (!manifest.starId) {
    throw new Error(
      `${c.who}: "${c.name}" published a generation with NO star identity (${join(c.home, "generation.json")}) — ` +
      "re-publish so the identity travels with the bytes. Absence is refused, never assumed to match.",
    );
  }
  if (!sameId(manifest.starId, c.id)) {
    throw new Error(`${c.who}: identity mismatch for "${c.name}" — ${serves} says "${c.id}", its published manifest says "${manifest.starId}"`);
  }
  return manifest;
}

/** Layer 4 — the stamp inside the database bytes, checked on the OPEN handle. Closes the store
 *  before throwing: the caller's error path is a refusal, not a place to remember cleanup. */
export async function assertStampedStarIdentity(
  store: FunesIndexStore,
  opts: { expectedId: string; dbPath: string; who: string; serves?: string },
): Promise<void> {
  const stamped = (await store.getOwnerStarId?.()) ?? null;
  if (sameId(stamped, opts.expectedId)) return;
  await store.close().catch(() => {});
  throw new Error(
    `${opts.who}: the generation at ${opts.dbPath} carries star identity "${stamped ?? "(none)"}", ` +
    `but ${opts.serves ?? "the catalogue"} serves it as "${opts.expectedId}" — refusing to answer in another star's name`,
  );
}
