import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { assertIndexNotInSyncRoot, canonicalizeExisting, findSyncRoot, syncRootOverrides, type SyncRootFinding } from "./sync-root.ts";

// 0.3.0 item 23. The two failures this guard exists for are opposite mistakes, and both are here:
// refusing an index that a sync provider would tear, and NOT refusing the estate's normal shape —
// a vault under Syncthing whose index lives on true-local disk.

const tmp = (p: string) => mkdtempSync(join(realpathSync(tmpdir()), p)); // realpath: /var -> /private/var on macOS

test("sync-root: a Syncthing root is the directory CONTAINING .stfolder, never a directory named it", () => {
  const root = tmp("funes-sync-");
  writeFileSync(join(root, ".stfolder"), ""); // the marker as Syncthing writes it — inside the root
  const index = join(root, "nested", "libsql", "index.db"); // does not exist yet: a first run
  const found = findSyncRoot(index);
  expect(found?.root).toBe(root);
  expect(found?.provider).toBe("Syncthing");
  expect(found?.evidence).toContain(".stfolder");
  // the pre-item-23 shape of this check looked for an ancestor NAMED .stfolder, which finds nothing
  expect(index.split("/").includes(".stfolder")).toBe(false);
});

test("sync-root: provider mount directory NAMES are roots too (macOS FileProvider, Dropbox)", () => {
  const home = tmp("funes-sync-home-");
  const cloud = join(home, "Library", "CloudStorage", "Dropbox-Personal", "star");
  mkdirSync(cloud, { recursive: true });
  expect(findSyncRoot(join(cloud, "index.db"))?.provider).toContain("FileProvider");
  const dbx = join(home, "Dropbox", "notes");
  mkdirSync(dbx, { recursive: true });
  expect(findSyncRoot(join(dbx, "index.db"))?.provider).toBe("Dropbox");
});

test("sync-root: a SYMLINKED root is still found — a lexical resolve() walks past it", () => {
  const real = tmp("funes-sync-real-");
  writeFileSync(join(real, ".stfolder"), "");
  mkdirSync(join(real, "index"));
  const link = join(tmp("funes-sync-link-"), "synced");
  symlinkSync(real, link);
  const viaLink = join(link, "index", "index.db");
  expect(canonicalizeExisting(viaLink).startsWith(real)).toBe(true);
  expect(findSyncRoot(viaLink)?.root).toBe(real);
});

test("sync-root: canonicalizeExisting keeps the not-yet-existing tail — a first run has no index file", () => {
  const root = tmp("funes-sync-tail-");
  const p = join(root, "a", "b", "index.db");
  expect(canonicalizeExisting(p)).toBe(join(root, "a", "b", "index.db"));
});

// THE ESTATE ARRANGEMENT, and it must keep working: the funes repo itself is a Syncthing folder
// (it carries a .stfolder), while its index lives at ~/.twinkling/libsql/funes. The guard takes the
// INDEX path only, so this opens — a vault under a sync root is expected and permitted.
test("sync-root: a vault inside a Syncthing root whose INDEX is elsewhere opens — the guard is index-only", () => {
  const vault = tmp("funes-sync-vault-");
  writeFileSync(join(vault, ".stfolder"), "");
  writeFileSync(join(vault, "star.yaml"), "meta:\n  name: funes\n");
  const index = join(tmp("funes-sync-twinkling-"), "libsql", "funes", "index.db");
  expect(findSyncRoot(vault)).not.toBeNull();   // the VAULT is synced, and that is fine
  expect(findSyncRoot(index)).toBeNull();       // the INDEX is not
  expect(() => assertIndexNotInSyncRoot(index, {})).not.toThrow();
});

test("sync-root: an index INSIDE a sync root refuses, and the refusal names the provider and the repair", () => {
  const root = tmp("funes-sync-refuse-");
  writeFileSync(join(root, ".stfolder"), "");
  const index = join(root, "libsql", "index.db");
  expect(() => assertIndexNotInSyncRoot(index, {})).toThrow(/refusing to open an index inside a Syncthing root/);
  expect(() => assertIndexNotInSyncRoot(index, {})).toThrow(/FUNES_LIBSQL_DIR/);
});

test("sync-root: the override is EXACT-PATH — a sibling index under the same root is still refused", () => {
  const root = tmp("funes-sync-override-");
  writeFileSync(join(root, ".stfolder"), "");
  const mine = join(root, "a", "index.db");
  const sibling = join(root, "b", "index.db");
  const env = { FUNES_SYNC_ROOT_OK: mine };
  expect(() => assertIndexNotInSyncRoot(mine, env)).not.toThrow();
  // a global "yes I know" would exempt every star on the machine; this exempts one path
  expect(() => assertIndexNotInSyncRoot(sibling, env)).toThrow(/refusing to open an index/);
  expect(() => assertIndexNotInSyncRoot(mine, { FUNES_SYNC_ROOT_OK: root })).toThrow(/refusing to open an index/); // not a prefix match
  expect(() => assertIndexNotInSyncRoot(mine, { FUNES_SYNC_ROOT_OK: "1" })).toThrow(/refusing to open an index/); // not a boolean
});

// The trap this cost a full test run to find: `~/.dropbox` is Dropbox's CONFIG directory, present
// on every machine that ever ran the client, and `~/.sync` is Resilio's. Marker evidence in the
// home directory itself therefore declared ALL of $HOME a sync root — which refuses
// ~/.twinkling/libsql/<star>/index.db, the DEFAULT index path this repo ships.
test("sync-root: the HOME directory is exempt from MARKER evidence — ~/.dropbox is a config dir", () => {
  const home = realpathSync(homedir());
  expect(findSyncRoot(join(home, ".twinkling", "libsql", "funes", "index.db"))).toBeNull();
});

test("sync-root: every active override is reportable — doctor turns this list red", () => {
  expect(syncRootOverrides({})).toEqual([]);
  expect(syncRootOverrides({ FUNES_SYNC_ROOT_OK: " /a/index.db , /b/index.db ,, " })).toEqual(["/a/index.db", "/b/index.db"]);
});

/** `findSyncRoot` under a CHOSEN $HOME. `homedir()` is resolved once per process (setting
 *  process.env.HOME mid-run does not move it), so the only honest way to exercise the home
 *  exemption is a fresh process — and no test may point HOME at the real estate. */
async function findSyncRootUnderHome(home: string, path: string): Promise<SyncRootFinding | null> {
  const src = join(import.meta.dir, "sync-root.ts");
  const proc = Bun.spawn(
    ["bun", "-e", `const m = await import(${JSON.stringify(src)}); console.log(JSON.stringify(m.findSyncRoot(${JSON.stringify(path)}) ?? null));`],
    { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return JSON.parse(out.trim()) as SyncRootFinding | null;
}

// The exemption above, narrowed: it used to suppress ALL marker evidence at $HOME, and that failed
// OPEN. A home directory that is itself a Syncthing folder carries `~/.stfolder` — the very hazard
// — and the blanket exemption swallowed it, so findSyncRoot returned null for the default index
// path AND for everything else under that home. One synced home switched the whole guard off.
test("sync-root: a HOME that is ITSELF a Syncthing folder is NOT exempt — only the config NAMES are", async () => {
  const synced = tmp("funes-sync-synced-home-");
  writeFileSync(join(synced, ".stfolder"), "");
  expect(await findSyncRootUnderHome(synced, join(synced, ".twinkling", "libsql", "star", "index.db")))
    .toMatchObject({ root: synced, provider: "Syncthing" });
  expect(await findSyncRootUnderHome(synced, join(synced, "sub", "index.db"))).not.toBeNull();
  // and the collision the exemption exists for is untouched: ~/.dropbox / ~/.sync are CONFIG dirs
  const config = tmp("funes-sync-config-home-");
  for (const entry of [".dropbox", ".dropbox.cache", ".sync"]) writeFileSync(join(config, entry), "");
  expect(await findSyncRootUnderHome(config, join(config, ".twinkling", "libsql", "star", "index.db"))).toBeNull();
  // a CHILD named after a provider is still name evidence — the exemption was never about names
  mkdirSync(join(config, "Dropbox"), { recursive: true });
  expect(await findSyncRootUnderHome(config, join(config, "Dropbox", "index.db"))).not.toBeNull();
}, 30_000);
