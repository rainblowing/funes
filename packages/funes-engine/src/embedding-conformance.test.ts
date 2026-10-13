// PLAN-0.3.0 P0.2 — the embedding conformance gate.
//
// The property under test is NOT "macOS and Linux agree" — no signature extension can make that
// true. It is: **equal effective embedding signatures imply byte-identical vectors.**
//
// Until PLAN-0.4.0 `embeddingSignature()` encoded model id, dim, revision, dtype, pooling and
// truncation — and NOTHING about the ONNX Runtime version, the native build, the execution provider
// or the CPU. So two machines could hold the SAME signature and produce DIFFERENT vectors, and
// GLOSSARY.md's "rebuilds are identical only between machines whose effective embedding signatures
// are equal" was a false promise. RAI-152 measured exactly that hazard (linux/x64 against the
// darwin/arm64 golden: one signature, two vectors), so PLAN-0.4.0 item 3 took the EXTEND branch:
// the signature now carries the platform, the arch and the onnxruntime version (and, item 8, the
// forward width), and each platform keeps its OWN golden, recorded from the code it gates (item 13).
//
// The two possible failures still name different causes, so the report says which one it is:
//   different signature → honestly distinct; an axis the signature names moved — re-record.
//   same signature, different vector → the hazard again, on an axis still unsigned (CPU, native
//   build, provider): extend further, or make the quantization deterministic.
//
// NO TOLERANCE. The plan says byte-identical, and a tolerance-based assertion would assert the
// opposite of the property: a 1-ulp drift under one signature is exactly the divergence that lets
// two loci publish "the same" content generation over different rows. The comparison is over the
// raw float32 bytes; the per-element diff exists only to make a failure readable.
//
//   re-record THIS platform's golden:  REGEN_GOLDEN=1 bun test packages/funes-engine/src/embedding-conformance.test.ts
//   write the observation anywhere:    FUNES_CONFORMANCE_OUT=/tmp/x.json bun test .../embedding-conformance.test.ts
//   (a platform with no golden fails by name, and its FUNES_CONFORMANCE_OUT record IS the golden to commit)
import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { embeddingSignature } from "funes-core";
import { E5Embedder, EMBED_FORWARD_BATCH, onnxRuntimeVersion } from "./embedder.ts";

/** One golden per platform (PLAN-0.4.0 item 3, extend branch): the platform is in the signature, so
 *  one fixture could gate one platform only. Selected from the RUNNING process, never configured —
 *  a platform with no golden fails by this name instead of borrowing another's. */
const FIXTURE_NAME = `embedding-conformance.${process.platform}-${process.arch}.json`;
const FIXTURE = fileURLToPath(new URL(`./__fixtures__/${FIXTURE_NAME}`, import.meta.url));

/** FROZEN. Short (one forward, no chunking), mixed-script (the multilingual tokenizer is the point
 *  of this model), and with a digit run — quantized attention is where platforms drift. Changing
 *  this string invalidates the golden and every comparison ever made against it. */
const FIXTURE_TEXT = "funes conformance fixture: цели по фитнесу, protein, 42.";

/** The context of a recording. Platform and onnxruntime are also signed now (plat/arch/ort); `cpu`,
 *  `bun` and which onnxruntime build (node vs web) are not. Recorded so an operator reading a
 *  SAME-SIGNATURE failure can see whether an unsigned axis moved — a different CPU model (MLAS picks
 *  kernels by instruction set, and a CI pool mixes SKUs) — or nothing did, and the quantization is not
 *  deterministic. */
interface Runtime {
  platform: string;
  cpu: string | null;
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
    recordedOn: { platform: `${process.platform}/${process.arch}`, cpu: cpus()[0]?.model ?? null, bun: Bun.version, onnxruntime: ort },
  };
}

/** [] when it conforms; otherwise the operator's report, with the branch-choosing line FIRST. */
function compare(want: Conformance, got: Conformance): string[] {
  const sameSig = got.signature === want.signature;
  if (sameSig && got.vector === want.vector) return [];

  const lines = [
    sameSig
      ? "SAME SIGNATURE, DIFFERENT VECTOR — the hazard. Two loci would claim one content generation over different rows. An axis the signature still omits moved (CPU, native build, provider): extend it further, or make the quantization deterministic."
      : "DIFFERENT SIGNATURE — honestly distinct, not silent. Nothing falsely shares a content generation; re-record every platform's golden from the code that moved it (PLAN-0.4.0 item 13).",
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
  // absent golden fails by name instead — CI's first run on a new platform goes red naming the file
  // and uploads the record to commit under it (PLAN-0.4.0 item 13).
  if (process.env.REGEN_GOLDEN === "1") writeFileSync(FIXTURE, JSON.stringify(got, null, 2) + "\n");
  expect(existsSync(FIXTURE) || `the golden __fixtures__/${FIXTURE_NAME} is missing — commit this platform's FUNES_CONFORMANCE_OUT record under that name, or run REGEN_GOLDEN=1 on it`).toBe(true);
  const want = JSON.parse(readFileSync(FIXTURE, "utf8")) as Conformance;
  expect(want.text).toBe(FIXTURE_TEXT); // the golden is evidence about THIS input and no other
  // The signed `ort=` is read from a package.json at open (embedder.ts onnxRuntimeVersion); this is
  // the one place the runtime is actually loaded, so it checks that the read names the onnxruntime-node
  // transformers imported. `versions.node` is that package's own JS constant, not the native lib's.
  expect(got.signature).toEndWith(`:ort=${got.recordedOn.onnxruntime?.node}`);

  const report = compare(want, got);
  if (report.length) console.error(`\n${report.join("\n")}\n`);
  // The assertion message itself names the branch, so a CI failure is readable without scrollback.
  expect(report[0] ?? "conforms").toBe("conforms");
}, 300_000);

// PLAN-0.4.0 item 8 (RAI-138): the same property on ONE machine — equal text, equal bytes, whatever
// else shares the call. The golden above cannot see a batch: it embeds one passage, one forward, so
// its vector is the same at any forward width. At EMBED_FORWARD_BATCH=32 a 32-text caller batch was
// ONE forward and q8 dynamic quantization scaled it per forward (a text alone versus inside such a
// forward differed in 128 of 128 tries, RAI-138; this test failed at 32 when it was written); at 1
// the batch is 32 forwards and the fixture's bytes cannot depend on its batch-mates. It lives
// HERE, not in embedder.test.ts: `bun run test` drops every `E5 embedder` name and the conformance
// job runs this file alone, so anywhere else a real-model test runs nowhere. (embedder.test.ts
// holds the stub-extractor half that the default suite can run.)
test("E5 embedder: a text embeds byte-identically alone and inside a 32-text batch (RAI-138)", async () => {
  const e = new E5Embedder();
  const alone = Buffer.from(toBytes(await e.embedPassage(FIXTURE_TEXT))).toString("base64");
  // Batch-mates of varied lengths and scripts, so a shared forward would pad and scale differently.
  const mates = Array.from({ length: 31 }, (_, i) => `batch-mate ${i}: ${"ранжирование recall fusion 7. ".repeat(1 + (i % 9))}`);
  const batch = [...mates.slice(0, 13), FIXTURE_TEXT, ...mates.slice(13)];
  const inside = Buffer.from(toBytes((await e.embedPassages(batch))[13]!)).toString("base64");
  expect(inside).toBe(alone);
}, 300_000);

// The premise, asserted where it is cheap: no network, no weights, runs in the normal suite. It
// asserted the OPPOSITE until PLAN-0.4.0 item 3 took the extend branch (RAI-152), and inverted in
// the wave commit (item 13) — the one that re-records every platform's golden above. Dropping any of
// these re-opens the hazard; the golden cannot see that, since it compares one platform with itself.
test("the embedding signature names the forward width, platform, arch and onnxruntime version — the extend branch of P0.2", () => {
  const sig = embeddingSignature(new E5Embedder());
  expect(sig).toContain("rev=");                       // it pins the weights
  expect(sig).toEndWith(`:fwd=${EMBED_FORWARD_BATCH}:plat=${process.platform}:arch=${process.arch}:ort=${onnxRuntimeVersion()}`);
});
