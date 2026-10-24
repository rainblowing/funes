// RAI-294: onnxruntime must see ORT_DISABLE_TELEMETRY in the C environment, not only in process.env.
// Each case runs in a child with an explicit env, so the runner's own env cannot make it pass.
import { expect, test } from "bun:test";

const embedder = new URL("./embedder.ts", import.meta.url).pathname;
const libc = process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6";
const script = `
import { importTransformers } from ${JSON.stringify(embedder)};
import { dlopen, FFIType, CString } from "bun:ffi";
await importTransformers();
const lib = dlopen(${JSON.stringify(libc)}, { getenv: { args: [FFIType.cstring], returns: FFIType.ptr } });
const p = lib.symbols.getenv(Buffer.from("ORT_DISABLE_TELEMETRY\\0"));
console.log("VALUE=" + (p ? new CString(p).toString() : "<unset>"));
`;

function libcValue(extra: Record<string, string>): string {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...extra };
  const r = Bun.spawnSync([process.execPath, "-e", script], { env, cwd: import.meta.dir });
  const out = r.stdout.toString();
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return /VALUE=(.*)/.exec(out)![1]!;
}

const skip = process.platform === "win32";

test.skipIf(skip)("importTransformers sets ORT_DISABLE_TELEMETRY=1 in libc when the caller set nothing", () => {
  expect(libcValue({})).toBe("1");
}, 60_000);

test.skipIf(skip)("importTransformers never overwrites the caller's ORT_DISABLE_TELEMETRY", () => {
  expect(libcValue({ ORT_DISABLE_TELEMETRY: "0" })).toBe("0");
}, 60_000);
