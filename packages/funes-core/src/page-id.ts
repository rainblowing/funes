// The page-id rule's slug (record 25 §3; PLAN-0.5.0 item 31). One implementation, shared by the taste
// converter (taste-bot scripts/taste/convert.ts, item 46) and the replica watcher's new-file check
// (record 29). Moved byte for byte from the converter: a change here moves every taste page id.
// Not write.ts's `slugify`, which names `remember` notes by a different, older rule.
import { createHash } from "node:crypto";

const clean = (s: string) => s.replace(/[​-‍﻿]/g, "").replace(/\s+/g, " ").trim();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k",
  л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts",
  ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya", і: "i", ї: "yi", є: "ye",
  ґ: "g", ł: "l", ø: "o", æ: "ae", œ: "oe", ß: "ss", ð: "d", þ: "th", đ: "d", ı: "i", "&": "-and-",
};

/** ASCII slug. ASCII keeps one byte sequence per path on every machine: a Cyrillic or accented
 *  path can fork into NFC and NFD forms between APFS, Dropbox, Obsidian and an R2 key. */
export function slug(s: string, cap = 80): string {
  let t = clean(s).toLowerCase().replace(/['’‘`]/g, "");
  t = [...t].map((c) => TRANSLIT[c] ?? c).join("");
  t = t.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!t) return `x${sha(clean(s)).slice(0, 10)}`; // no letter or digit survives (emoji-only)
  if (t.length <= cap) return t;
  return `${t.slice(0, cap - 8).replace(/-+$/, "")}-${sha(t).slice(0, 7)}`;
}

/** The converter's digest (`convert.ts --digest`): one sha256 over every (path, bytes) pair in path
 *  order. The one definition: the taste converter (taste-bot) and the seed (funes-cf/replica) import
 *  it from the kernel entry `funes-core`. */
export function pagesDigest(pages: Map<string, string | Uint8Array>): string {
  const h = createHash("sha256");
  for (const p of [...pages.keys()].sort()) h.update(p).update("\0").update(pages.get(p)!).update("\0");
  return h.digest("hex");
}

const LATIN = /\p{Script=Latin}/u;

/** The page-id rule's paths for an item's frontmatter (record 25 §3): `items/<domain>/<base>.md`,
 *  `<base>` the slug of the first Latin-script title (else the first), `--<creator|year>`, `-item` on a
 *  reserved base (index, log), then — with a `type` — its `--<type>` collision variant. Empty with no
 *  title. One composition: the replica's new-file check and the taste bot's `/new` both name by it. */
export function itemPaths(data: Record<string, unknown>, domain: string): string[] {
  const titles = [data.title, data.title_ru].filter((x): x is string => typeof x === "string" && x.trim() !== "");
  const title = titles.find((x) => LATIN.test(x)) ?? titles[0];
  if (!title) return [];
  const qual = typeof data.creator === "string" && data.creator ? `--${slug(data.creator, 60)}` : data.year != null && data.year !== "" ? `--${data.year}` : "";
  const reserved = (b: string) => (b === "index" || b === "log" ? `${b}-item` : b);
  const base = slug(title) + qual;
  return [reserved(base), ...(typeof data.type === "string" && data.type ? [reserved(`${base}--${slug(data.type, 20)}`)] : [])]
    .map((b) => `items/${domain}/${b}.md`);
}

/** The page-id rule as a writer check (record 24 §6 step 5; ADR-0011 Consequences): an item page is
 *  `<memoryDir>/<domain>/<name>.md`, `<domain>` runs of [a-z0-9] joined by single hyphens, `<name>`
 *  such runs joined by `-` or `--` (the qualifier joint), the whole path at most 900 UTF-8 bytes — so
 *  `.history/` plus a 64-hex name still fits R2's 1,024-byte key. */
export function isItemPath(path: string, memoryDir: string): boolean {
  const run = "[a-z0-9]+";
  const m = new RegExp(`^${memoryDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/${run}(?:-${run})*/${run}(?:--?${run})*\\.md$`);
  return m.test(path) && new TextEncoder().encode(path).length <= 900;
}
