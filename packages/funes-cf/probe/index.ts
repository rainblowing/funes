// funes-probe: record 35 E7, the gate before the seed (PLAN-0.5.0 item 36; record 31). One call
// with the per-session bearer runs both halves and answers the report:
//   the real-R2 spike — put A then B: the etags differ; put A twice: the etag is equal and the
//     version differs; a second create-once with `If-None-Match: *` and a stale `etagMatches` both
//     return null (ADR-0011 "R2 preconditions"). Its keys are deleted, so the bucket can be.
//   the determinism probe — every text, one per call, through the AI binding with no options (no
//     gateway, so no gateway cache), 5 rounds; a text's repeats are a full round apart. Each repeat
//     is compared with the text's first answer as float32, the form the edge store keeps.
// It reports byte-equality, max |Δ| and min cosine per length class, `pooling`, the shapes, and the
// latency of each call. About 280 calls in one invocation: inside Workers Paid's subrequest limit
// (runbook step 1). Never `wrangler dev --remote`: this deployed throwaway is the only AI path.
import { PROBE_TEXTS } from "./texts.ts";

export interface ProbeEnv {
  SPIKE: R2Bucket;
  AI: Ai;
  /** The per-session random bearer cf-session.sh pipes in. Unset, every request is refused. */
  PROBE_BEARER?: string;
}

const MODEL = "@cf/baai/bge-m3";
const REPEATS = 5;
/** Below this many UTF-8 bytes a text is `short` (sentences, queries); else `passage`. */
const SHORT_BELOW = 128;

const utf8 = (s: string) => new TextEncoder().encode(s);

function authorized(req: Request, env: ProbeEnv): boolean {
  if (!env.PROBE_BEARER) return false;
  const want = utf8(`Bearer ${env.PROBE_BEARER}`);
  const got = utf8(req.headers.get("authorization") ?? "");
  return want.byteLength === got.byteLength && crypto.subtle.timingSafeEqual(want, got);
}

async function spike(bucket: R2Bucket) {
  const key = `spike/${crypto.randomUUID()}`;
  const once = `${key}.once`;
  const put = async (body: string) => {
    const o = await bucket.put(key, body);
    if (!o) throw new Error("an unconditional put returned null");
    return o;
  };
  try {
    const a1 = await put("A");
    const b = await put("B");
    const a2 = await put("A");
    const a3 = await put("A");
    const first = await bucket.put(once, "A", { onlyIf: new Headers({ "If-None-Match": "*" }) });
    const second = await bucket.put(once, "A", { onlyIf: new Headers({ "If-None-Match": "*" }) });
    const stale = await bucket.put(key, "C", { onlyIf: { etagMatches: b.etag } });
    const r = {
      abEtagsDiffer: a1.etag !== b.etag,
      aaEtagEqual: a2.etag === a3.etag,
      aaVersionDiffers: a2.version !== a3.version,
      createOnceNull: first !== null && second === null,
      staleEtagMatchesNull: stale === null,
    };
    return { ...r, pass: Object.values(r).every(Boolean) };
  } finally {
    await bucket.delete([key, once]);
  }
}

type Embedding = { data?: number[][]; shape?: number[]; pooling?: string };
type Stats = { texts: number; byteEqual: boolean; maxAbsDelta: number; minCosine: number };

function compare(c: Stats, a: Float32Array, b: Float32Array) {
  const ab = new Uint8Array(a.buffer);
  const bb = new Uint8Array(b.buffer);
  if (ab.length === bb.length && ab.every((x, i) => x === bb[i])) return;
  c.byteEqual = false;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    c.maxAbsDelta = Math.max(c.maxAbsDelta, Math.abs(x - y));
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  c.minCosine = Math.min(c.minCosine, dot / Math.sqrt(na * nb));
}

async function probe(ai: Ai) {
  const answers: Float32Array[][] = PROBE_TEXTS.map(() => []);
  const perCall: number[] = [];
  const pooling = new Set<string>();
  const shapes = new Set<string>();
  let poolingPresent = false;
  for (let round = 0; round < REPEATS; round++) {
    for (const [i, text] of PROBE_TEXTS.entries()) {
      const t0 = Date.now();
      const out = (await ai.run(MODEL, { text: [text] })) as Embedding;
      perCall.push(Date.now() - t0);
      if (out.data?.length !== 1) throw new Error(`text ${i}: expected one vector, got ${out.data?.length ?? "none"}`);
      poolingPresent ||= out.pooling !== undefined;
      pooling.add(out.pooling ?? "none");
      shapes.add(JSON.stringify(out.shape ?? null));
      answers[i]!.push(Float32Array.from(out.data[0]!));
    }
  }
  const blank = (): Stats => ({ texts: 0, byteEqual: true, maxAbsDelta: 0, minCosine: 1 });
  const classes = { short: blank(), passage: blank() };
  for (const [i, text] of PROBE_TEXTS.entries()) {
    const c = utf8(text).byteLength < SHORT_BELOW ? classes.short : classes.passage;
    c.texts++;
    const [first, ...rest] = answers[i]!;
    for (const v of rest) compare(c, first!, v);
  }
  const sorted = [...perCall].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return {
    model: MODEL,
    repeats: REPEATS,
    texts: PROBE_TEXTS.length,
    calls: perCall.length,
    shortBelowBytes: SHORT_BELOW,
    byteEqual: classes.short.byteEqual && classes.passage.byteEqual,
    classes,
    pooling: { present: poolingPresent, values: [...pooling].sort() },
    shapes: [...shapes].map((s) => JSON.parse(s)),
    latencyMs: { p50: at(0.5), p95: at(0.95), max: sorted.at(-1)!, perCall },
  };
}

export default {
  async fetch(req: Request, env: ProbeEnv): Promise<Response> {
    if (!authorized(req, env)) return new Response(null, { status: 401 });
    return Response.json({ worker: "funes-probe", spike: await spike(env.SPIKE), probe: await probe(env.AI) });
  },
} satisfies ExportedHandler<ProbeEnv>;
