// B5 (RAI-337; RAI-310 D6): `funes token mint`, one verb and two sinks.
//   local  --access <file> --actor <name> --role <role> --star <ref|*>… --out <token file>
//          writes the token to --out, and adds or replaces the actor in the operator's v2 access file
//          (temp + rename, 0600). The whole result validates before the rename: a bad result refuses
//          the mint, never the file. The role must already exist: this is no role editor.
//   edge   --edge <star key> --role <outbox|bot|agent> --label <label> --star <ref>… [--days <n>] --out <token file>
//          writes the token to --out and prints the revoke-and-insert transaction for the deploy login
//          to run in that star key's Durable Object. No --actor: the preset derives it from the label.
//          It opens no network path that writes grants (ADR-0014). Probe with the new token after it.
// The token is `funes_` + 32 random bytes base64url. It goes to --out only (0600, by link(2), never
// over a file that holds one) and is never printed.
import { randomBytes } from "node:crypto";
import { linkSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { isCanonicalKey, sameStar } from "funes-core/internal";
import { assertActorName } from "funes-core";
import { readOwnerOnly } from "./actor.ts";
import { validateAccessPolicy } from "funes-core/internal";
import { grantRow } from "funes-core/internal";
import { sha256Hex } from "funes-core/internal";
import { publicOpNames } from "funes-core";
import type { Values } from "./cli-parse.ts";

const USAGE = "usage: funes token mint --access <file> --actor <name> --role <role> --star <ref|*>… --out <token file>\n" +
  "       funes token mint --edge <star key> --role <outbox|bot|agent> --label <label> --star <ref>… [--days <n>] --out <token file>";

/** Write the token to `out`, 0600, by link(2): an existing non-empty file refuses. */
function writeToken(out: string, token: string): void {
  const tmp = `${out}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, token, { mode: 0o600, flag: "wx" });
  try {
    try { if (statSync(out).size === 0) unlinkSync(out); } catch { /* absent: the link creates it */ }
    linkSync(tmp, out);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`--out ${out} already holds a token — refusing to overwrite it`);
    throw e;
  } finally {
    unlinkSync(tmp);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function mintLocal(v: { access: string; actor: string; role: string; star: string[]; out: string }): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readOwnerOnly(v.access, "--access"));
  } catch (e) {
    if ((e as Error).message.startsWith("--access")) throw e;
    throw new Error(`--access ${v.access}: malformed JSON — the parser's message is withheld because it can quote a token`);
  }
  if (!isObject(parsed) || parsed.version !== 2) throw new Error(`--access ${v.access}: not a version-2 access file`);
  if (!isObject(parsed.roles) || !Object.hasOwn(parsed.roles, v.role)) {
    throw new Error(`--access ${v.access}: role "${v.role}" is not defined — token mint adds actors, never roles`);
  }
  const actor = assertActorName(v.actor, "--actor");
  const token = `funes_${randomBytes(32).toString("base64url")}`;
  const next = { ...parsed, actors: { ...(isObject(parsed.actors) ? parsed.actors : {}), [actor]: { token_sha256: sha256Hex(token), role: v.role, stars: v.star } } };
  validateAccessPolicy(next, publicOpNames(), `--access ${v.access}`); // a bad result refuses the mint, never the file
  writeToken(v.out, token);
  const tmp = `${v.access}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tmp, v.access);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* never written */ }
    unlinkSync(v.out); // the token names no actor: take it back
    throw e;
  }
  return `minted actor "${actor}" (role ${v.role}): token ${v.out}, access file ${v.access}\n`;
}

function mintEdge(v: { edge: string; role: string; label: string; star: string[]; days?: string; out: string }): string {
  const days = v.days === undefined ? undefined : Number(v.days);
  const { row, token, sql } = grantRow({ role: v.role, label: v.label, stars: v.star, days });
  writeToken(v.out, token);
  return [
    `-- funes token mint --edge: run in the Durable Object of star key ${v.edge}, in the deploy login, as one transaction.`,
    `-- actor ${row.actor}, role ${row.role}, expires ${row.expires_at ?? "never"}; the token is in ${v.out}. Probe with it after the insert.`,
    "BEGIN TRANSACTION;",
    ...sql.map((s) => `${s};`),
    "COMMIT;",
    "",
  ].join("\n");
}

/** Run `funes token mint`, its flags as the CLI parsed them: 0 minted, 2 a usage error. A refusal
 *  throws (exit 1 in the CLI). */
export function runTokenMint(v: Values): number {
  const usage = (why: string) => (writeSync(2, `funes token mint: ${why}\n${USAGE}\n`), 2);
  const missing = (names: string[]) => names.filter((n) => v[n] === undefined || (Array.isArray(v[n]) && v[n].length === 0)).map((n) => `--${n}`);
  if (v.edge !== undefined) {
    if (v.access !== undefined || v.actor !== undefined) return usage("--edge takes no --access and no --actor: the preset derives the actor from --label");
    if (!isCanonicalKey(v.edge as string)) return usage(`--edge ${JSON.stringify(v.edge)} is not a canonical star key (<domain>/<workname>)`);
    const m = missing(["role", "label", "star", "out"]);
    if (m.length) return usage(`missing ${m.join(", ")}`);
    // the object at --edge serves that one star: a grant for another is refused there forever ("*" covers it)
    const off = (v.star as string[]).filter((s) => s !== "*" && !sameStar(s, v.edge as string));
    if (off.length) return usage(`--star ${off.map((s) => JSON.stringify(s)).join(", ")} is not the star at --edge ${v.edge}`);
    writeSync(1, mintEdge(v as Parameters<typeof mintEdge>[0]));
    return 0;
  }
  if (v.label !== undefined || v.days !== undefined) return usage("--label and --days belong to the --edge sink");
  const m = missing(["access", "actor", "role", "star", "out"]);
  if (m.length) return usage(`missing ${m.join(", ")}`);
  writeSync(1, mintLocal(v as Parameters<typeof mintLocal>[0]));
  return 0;
}
