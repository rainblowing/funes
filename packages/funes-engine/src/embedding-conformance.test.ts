// PLAN-0.3.0 P0.2 — the embedding conformance gate.
//
// The property under test is NOT "macOS and Linux agree" — no signature extension can make that
// true. It is: **equal effective embedding signatures imply byte-identical vectors.**
//
// `embeddingSignature()` (funes-core/src/types.ts:116) encodes model id, dim, revision, dtype,
// pooling and truncation — and NOTHING about the ONNX Runtime version, the native build, the
// execution provider or the CPU. So two machines can hold the SAME signature and produce DIFFERENT
// vectors, and CONTEXT.md's "rebuilds are identical only between machines whose effective embedding
// signatures are equal" would be a false promise. That is the hazard.
//
// This file records one vector, exactly, on a reference machine and re-runs it elsewhere. The two
// possible failures choose DIFFERENT branches of the plan, so the report must name which one it is:
//   different signature → honestly distinct; the platforms partition and nothing is silently shared.
//   same signature, different vector → the hazard; P0.2 must extend the signature or make the
//   quantization deterministic.
//
// NO TOLERANCE. The plan says byte-identical, and a tolerance-based assertion would assert the
// opposite of the property: a 1-ulp drift under one signature is exactly the divergence that lets
// two loci publish "the same" content generation over different rows. The comparison is over the
// raw float32 bytes; the per-element diff exists only to make a failure readable.
//
//   re-record on the reference machine:  REGEN_GOLDEN=1 bun test packages/funes-engine/src/embedding-conformance.test.ts
//   record elsewhere without asserting:  FUNES_CONFORMANCE_OUT=/tmp/x.json bun test .../embedding-conformance.test.ts
import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { embeddingSignature } from "funes-core";
import { E5Embedder } from "./embedder.ts";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/embedding-conformance.json", import.meta.url));

/** FROZEN. Short (one forward, no chunking), mixed-script (the multilingual tokenizer is the point
 *  of this model), and with a digit run — quantized attention is where platforms drift. Changing
 *  this string invalidates the golden and every comparison ever made against it. */
const FIXTURE_TEXT = "funes conformance fixture: цели по фитнесу, protein, 42.";

/** Exactly what `embeddingSignature()` leaves out. Recorded so an operator reading a failure can
 *  see WHICH omitted axis moved — that is the difference between "extend the signature" and
 *  "the quantization is not deterministic". */
interface Runtime {
  platform: string;
  bun: string;
  /** onnxruntime's own `{common, node|web}` — the version AND which build (node = native). */
  onnxruntime: Record<string, string> | null;
}

interface Conformance {
  text: string;
  signature: string;
  dim: number;
  sha256: string;
  /** base64 of the vector's float32 bytes, little-endian by construction. */
  vector: string;
  recordedOn: Runtime;
}

// Explicit little-endian, so the golden is a statement about float32 bits rather than about the
// recording machine's byte order.
function toBytes(v: Float32Array): Uint8Array {
  const b = new Uint8Array(v.length * 4);
  const d = new DataView(b.buffer);
  for (let i = 0; i < v.length; i++) d.setFloat32(i * 4, v[i]!, true);
  return b;
}
function toFloats(b64: string): Float32Array {
  const b = Buffer.from(b64, "base64");
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return Float32Array.from({ length: b.byteLength >> 2 }, (_, i) => d.getFloat32(i * 4, true));
}

async function observe(): Promise<Conformance> {
  const e = new E5Embedder();
  const v = await e.embedPassage(FIXTURE_TEXT);
  const bytes = toBytes(v);
  // transformers.js re-exports onnxruntime's env; `.versions` is populated at import.
  const { env } = await import("@huggingface/transformers");
  const ort = (env as unknown as { backends?: { onnx?: { versions?: Record<string, string> } } })
    .backends?.onnx?.versions ?? null;
  return {
    text: FIXTURE_TEXT,
    signature: embeddingSignature(e),
    dim: v.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    vector: Buffer.from(bytes).toString("base64"),
    recordedOn: { platform: `${process.platform}/${process.arch}`, bun: Bun.version, onnxruntime: ort },
  };
}

/** [] when it conforms; otherwise the operator's report, with the branch-choosing line FIRST. */
function compare(want: Conformance, got: Conformance): string[] {
  const sameSig = got.signature === want.signature;
  if (sameSig && got.vector === want.vector) return [];

  const lines = [
    sameSig
      ? "SAME SIGNATURE, DIFFERENT VECTOR — the hazard. Two loci would claim one content generation over different rows. PLAN-0.3.0 P0.2: extend the signature with runtime/provider/arch, or make the quantization deterministic."
      : "DIFFERENT SIGNATURE — honestly distinct, not silent. Nothing falsely shares a content generation; re-record the golden if the new signature is the intended one.",
    `  signature  want ${want.signature}`,
    `  signature  got  ${got.signature}`,
    `  sha256     want ${want.sha256}`,
    `  sha256     got  ${got.sha256}`,
    `  recorded on ${JSON.stringify(want.recordedOn)}`,
    `  observed on ${JSON.stringify(got.recordedOn)}`,
  ];

  const a = toFloats(want.vector);
  const b = toFloats(got.vector);
  if (a.length !== b.length) {
    lines.push(`  dim        want ${a.length} got ${b.length}`);
    return lines;
  }
  let first = -1;
  let differing = 0;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) { differing++; if (first < 0) first = i; }
  lines.push(
    first < 0
      ? "  bytes differ but no float value does — a NaN payload, not a numeric divergence"
      : `  first differing element [${first}]: want ${a[first]} got ${b[first]} (Δ ${Math.abs(a[first]! - b[first]!).toExponential(3)}; ${differing}/${a.length} elements differ)`,
  );
  return lines;
}

// Excluded from `bun run test` by the root script's `E5 embedder` name filter (it downloads 135MB
// of pinned weights); CI runs it as its own job. Long timeout for a cold model cache.
test("E5 embedder conformance: equal effective signatures imply byte-identical vectors", async () => {
  const got = await observe();
  // One grep-able line, so the comparison is legible in a plain CI log without the artifact.
  console.log(`embedding-conformance sig=${got.signature} sha256=${got.sha256} on=${JSON.stringify(got.recordedOn)}`);
  const out = process.env.FUNES_CONFORMANCE_OUT;
  if (out) writeFileSync(out, JSON.stringify(got, null, 2) + "\n");

  // Regenerating is a deliberate act on the REFERENCE machine — it overwrites the only evidence
  // the gate has. There is NO auto-bootstrap: `|| !existsSync(FIXTURE)` used to live here, and it
  // made a missing golden self-record and then compare against itself — green, with zero
  // measurement performed. That is the exact silent pass this gate exists to eliminate, so an
  // absent golden fails by name instead.
  if (process.env.REGEN_GOLDEN === "1") writeFileSync(FIXTURE, JSON.stringify(got, null, 2) + "\n");
  expect(existsSync(FIXTURE) || "the golden is missing — record it with REGEN_GOLDEN=1 on the reference machine").toBe(true);
  const want = JSON.parse(readFileSync(FIXTURE, "utf8")) as Conformance;
  expect(want.text).toBe(FIXTURE_TEXT); // the golden is evidence about THIS input and no other

  const report = compare(want, got);
  if (report.length) console.error(`\n${report.join("\n")}\n`);
  // The assertion message itself names the branch, so a CI failure is readable without scrollback.
  expect(report[0] ?? "conforms").toBe("conforms");
}, 300_000);

// The premise, asserted where it is cheap: no network, no weights, runs in the normal suite. If
// P0.2 takes the "extend the signature" branch this test must be inverted — and it failing is the
// reminder that the golden above has to be re-recorded on both platforms.
test("the embedding signature omits the runtime, native build, provider and CPU — the hazard this gate measures", () => {
  const sig = embeddingSignature(new E5Embedder());
  expect(sig).toContain("rev=");                       // it DOES pin the weights
  for (const omitted of [process.platform, process.arch, "onnx", "ort", "cpu", "provider"]) {
    expect(sig.toLowerCase()).not.toContain(omitted.toLowerCase());
  }
});
