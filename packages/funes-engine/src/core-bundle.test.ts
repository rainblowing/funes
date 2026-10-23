// RAI-310 probe 8, RAI-313: the taste bot imports its codec from `funes-core`, and the HTTP MCP handler
// is on `funes-core/mcp-http`. A bundle of the codec must not carry the MCP SDK (no `funes-core/codec`
// subpath is needed while this holds).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a bundle that imports only the codec from funes-core carries no MCP SDK", async () => {
  const dir = mkdtempSync(join(tmpdir(), "funes-core-bundle-"));
  try {
    const entry = join(dir, "entry.ts");
    writeFileSync(entry, `import { parseFrontmatter, render } from ${JSON.stringify(join(import.meta.dir, "..", "..", "funes-core", "src", "index.ts"))};\nexport const roundTrip = (t: string) => { const p = parseFrontmatter(t); return render(p.data, p.body); };\n`);
    const out = await Bun.build({ entrypoints: [entry], target: "node", format: "esm", metafile: true });
    expect(out.success, out.logs.join("\n")).toBe(true);
    const inputs = Object.keys(out.metafile!.inputs);
    expect(inputs.some((i) => i.endsWith("funes-core/src/index.ts"))).toBe(true);
    expect(inputs.filter((i) => i.includes("@modelcontextprotocol") || i.endsWith("mcp-http.ts"))).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
