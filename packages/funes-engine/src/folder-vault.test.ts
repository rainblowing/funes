// FolderVault — the folder adapter of the Vault port (PLAN-0.5.0 item 12, ADR-0011 §The decision).
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historyPath } from "funes-core";
import { FolderVault } from "./folder-vault.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const SHA = "a".repeat(64);

function vault(files: Record<string, string> = {}): { root: string; v: FolderVault; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), "funes-folder-vault-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return { root, v: new FolderVault(root), done: () => rmSync(root, { recursive: true, force: true }) };
}

test("read: the exact bytes and their version; absent and symlinked paths are null", async () => {
  const { root, v, done } = vault({ "wiki/a.md": "﻿alpha\r\n" });
  try {
    const f = await v.read("wiki/a.md");
    expect([...f!.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // no BOM or newline change
    expect(dec(f!.bytes.slice(3))).toBe("alpha\r\n");
    expect(typeof f!.version).toBe("string");
    expect(await v.read("wiki/missing.md")).toBeNull();
    symlinkSync(join(root, "wiki/a.md"), join(root, "wiki/link.md"));
    expect(await v.read("wiki/link.md")).toBeNull();
  } finally { done(); }
});

test("list: pages only, with the version read() reports; exclude sees dirs then files", async () => {
  const { v, done } = vault({
    "wiki/a.md": "a", "wiki/b.md": "b", "star.yaml": "meta: {}\n", "index.md": "i", "wiki/log.md": "l",
    "wiki/a.summary.md": "s", ".obsidian/x.md": "x", [`.history/wiki/a.md/${SHA}`]: "old", "drafts/d.md": "d",
  });
  try {
    const seen: string[] = [];
    const out: Record<string, string> = {};
    for await (const e of v.list({ exclude: (rel) => { seen.push(rel); return rel === "drafts/"; } })) out[e.path] = e.version;
    expect(Object.keys(out).sort()).toEqual(["wiki/a.md", "wiki/b.md"]);
    expect(out["wiki/a.md"]).toBe((await v.read("wiki/a.md"))!.version);
    expect(seen).toContain("drafts/");
    expect(seen).toContain("wiki/");
    expect(seen).toContain("wiki/a.md");
  } finally { done(); }
});

test("swap: create-once makes the page and refuses when it exists", async () => {
  const { root, v, done } = vault();
  try {
    const r = await v.atomically((tx) => tx.swap("out_memory/n.md", null, enc("new")));
    expect(r.ok).toBe(true);
    expect(readFileSync(join(root, "out_memory/n.md"), "utf8")).toBe("new");
    expect(await v.atomically((tx) => tx.swap("out_memory/n.md", null, enc("again")))).toEqual({ ok: false });
    expect(readFileSync(join(root, "out_memory/n.md"), "utf8")).toBe("new");
  } finally { done(); }
});

test("swap: a replace after an outside edit returns a conflict and leaves the edit", async () => {
  const { root, v, done } = vault({ "wiki/a.md": "funes read this" });
  try {
    const { version } = (await v.read("wiki/a.md"))!;
    writeFileSync(join(root, "wiki/a.md"), "an editor wrote this — and is longer"); // outside funes
    expect(await v.atomically((tx) => tx.swap("wiki/a.md", version, enc("funes' rewrite")))).toEqual({ ok: false });
    expect(readFileSync(join(root, "wiki/a.md"), "utf8")).toBe("an editor wrote this — and is longer");
  } finally { done(); }
});

test("swap: a replace and a remove on the version read; the result carries the new version", async () => {
  const { root, v, done } = vault({ "wiki/a.md": "one", "wiki/b.md": "two" });
  try {
    const a = (await v.read("wiki/a.md"))!.version;
    const b = (await v.read("wiki/b.md"))!.version;
    const out = await v.atomically(async (tx) => [await tx.swap("wiki/a.md", a, enc("ONE")), await tx.swap("wiki/b.md", b, null)]);
    expect(out[0]).toEqual({ ok: true, version: (await v.read("wiki/a.md"))!.version });
    expect(out[1]).toEqual({ ok: true, version: null });
    expect(readFileSync(join(root, "wiki/a.md"), "utf8")).toBe("ONE");
    expect(existsSync(join(root, "wiki/b.md"))).toBe(false);
    expect(readdirSync(join(root, "wiki"))).toEqual(["a.md"]); // no undo copy or temp left behind
  } finally { done(); }
});

test("atomically: a throw undoes the frame — created removed, replaced and removed put back, history kept", async () => {
  const { root, v, done } = vault({ "wiki/a.md": "one", "wiki/b.md": "two" });
  try {
    const a = (await v.read("wiki/a.md"))!.version;
    const b = (await v.read("wiki/b.md"))!.version;
    const h = historyPath("wiki/a.md", SHA);
    await expect(v.atomically(async (tx) => {
      await tx.swap(h, null, enc("one"));
      await tx.swap("wiki/a.md", a, enc("ONE"));
      await tx.swap("wiki/b.md", b, null);
      await tx.swap("wiki/c.md", null, enc("three"));
      throw new Error("index write failed");
    })).rejects.toThrow("index write failed");
    expect(readFileSync(join(root, "wiki/a.md"), "utf8")).toBe("one");
    expect(readFileSync(join(root, "wiki/b.md"), "utf8")).toBe("two");
    expect(existsSync(join(root, "wiki/c.md"))).toBe(false);
    expect(readFileSync(join(root, h), "utf8")).toBe("one");
    expect(readdirSync(join(root, "wiki")).sort()).toEqual(["a.md", "b.md"]);
  } finally { done(); }
});

test("atomically: a frame swaps each path at most once", async () => {
  const { v, done } = vault();
  try {
    await expect(v.atomically(async (tx) => {
      const r = await tx.swap("wiki/a.md", null, enc("a"));
      await tx.swap("wiki/a.md", r.ok ? r.version : null, enc("b"));
    })).rejects.toThrow(/at most once/);
  } finally { done(); }
});
