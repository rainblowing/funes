#!/usr/bin/env bun
// Lists every index home under the libSQL base with the evidence needed to decide whether it is
// test litter — and DELETES NOTHING. Not a sweep, not a `doctor` finding, not a cron job: it prints.
//
// RAI-148 ("Litter"), and the shape is the outcome of the review rather than a preference. An
// automated sweep was designed, reviewed and REMOVED at round 5: excluding new openers needed a
// rename-to-tombstone, and a rename could split the vault fence's lock from its holder. So the
// exclusion that remains is the only one that covers fence holders and home openers alike without a
// shared lock — a human, on a quiet machine, with no funes process running. This script is that
// human's evidence, and the deletion is their keystroke.
//
// Two rules govern the output:
//
//   1. Evidence that could not be gathered prints as `unknown` WITH ITS REASON, never as absent.
//      An unreadable owner marker is not a missing vault, and an lsof that could not complete is
//      not "no open files". A listing that silently downgrades "I could not look" to "there is
//      nothing there" is how a script talks someone into deleting a live home.
//   2. One home's failure never ends the walk. Every field is gathered inside its own try, so a
//      home with a permission problem costs its own line and nothing else.
//
// A home is a TEST-LITTER CANDIDATE only when BOTH hold: the owner marker's vault path lies under
// the system temp directory (aliases resolved — /tmp -> /private/tmp, /var/folders -> /private/var/
// folders), AND its last path segment starts with `funes-cli-` or `funes-mcpproxy-vault-`, the two
// prefixes the test suites use. Everything else stays, scratchpad paths included: the marker's
// vault path is INFORMATIONAL (identity is the star id, ADR-0002), so a vault that merely moved is
// not an abandoned home.
//
//   bun scripts/list-orphan-homes.ts            # the default base, or $FUNES_LIBSQL_DIR
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { canonicalizeExisting } from "../packages/funes-engine/src/sync-root.ts";
import { funesDbDir } from "../packages/funes-engine/src/factory.ts";

/** The index base, derived from the ONE function that decides it rather than restated here — a
 *  second copy of `~/.twinkling/libsql` would list a different directory than funes writes to the
 *  first time the default moves (it is scheduled to become `~/.funes/`). `funesDbDir` returns
 *  `<base>/<vault-name>/index.db`, so two dirnames is the base, and it honours FUNES_LIBSQL_DIR. */
const BASE = dirname(dirname(funesDbDir("_", "libsql")));

const TEST_PREFIXES = ["funes-cli-", "funes-mcpproxy-vault-"];

/** The canonical system-temp roots. Canonicalized because the recorded vault path is not: a marker
 *  holds `/var/folders/…/T/funes-cli-XXXX` while the real directory is under `/private/var/folders`
 *  on macOS, so a raw prefix test answers "not temp" for every home the tests made. */
const TEMP_ROOTS = [...new Set([tmpdir(), process.env.TMPDIR ?? "", "/tmp", "/var/folders"].filter(Boolean).map(canonicalizeExisting))];

/** Evidence, or the reason there is none. `null` is never "absent" — absence is a `boolean`. */
type Known<T> = { ok: true; value: T } | { ok: false; why: string };
const yes = <T>(value: T): Known<T> => ({ ok: true, value });
const no = <T>(why: string): Known<T> => ({ ok: false, why });
const show = <T>(k: Known<T>, render: (v: T) => string): string => (k.ok ? render(k.value) : `unknown — ${k.why}`);

interface Marker { id: string | null; vault: string; star?: string | null; constellation?: string | null }

/** Reads `owner-vault` exactly as `factory.ts readMarker` does — JSON when it starts with `{`, a
 *  bare path otherwise — because the point of this listing is what FUNES believes about the home,
 *  not what a second, kinder parser could make of the bytes. The one addition is the note on the
 *  fall-through: factory silently treats a malformed JSON marker as a literal path, which would
 *  print here as a vault named `{"id":…}` and read as a missing vault. Naming it keeps rule 1. */
function readMarker(home: string): Known<Marker> {
  const path = join(home, "owner-vault");
  if (!existsSync(path)) return no("no owner-vault marker in this home (never opened by a writer, or the marker was removed)");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch (e) {
    return no(`owner-vault is unreadable (${(e as Error).message}) — this is NOT evidence that the vault is gone`);
  }
  if (raw.length === 0) return no("owner-vault is empty");
  if (raw.startsWith("{")) {
    try {
      return yes(JSON.parse(raw) as Marker);
    } catch {
      return no("owner-vault begins with '{' but is not valid JSON; factory.ts would fall through and read the literal text as a bare vault path");
    }
  }
  return yes({ id: null, vault: raw }); // legacy bare-path marker (pre-identity)
}

/** Does any process hold a file under `home` open?
 *
 *  ponytail: `lsof +D` is the whole implementation. Its ceiling is real — it is slow on a large
 *  tree, it only sees what this uid may see, and it is a sample taken at one instant, so "none"
 *  means "none while I looked" and never "none while you delete". That ceiling is acceptable here
 *  precisely because nothing is deleted: the operator's own quiet machine is the real exclusion.
 *  The upgrade path, if a machine ever needs a proven-idle home, is the estate walk of RAI-154 —
 *  which stops the writers first and therefore does not need to detect them. */
function openFiles(home: string): Known<number> {
  const r = spawnSync("lsof", ["+D", home], { encoding: "utf8" });
  if (r.error) return no(`lsof could not be run (${r.error.message}) — the scan did not happen, so "no open files" is not a finding`);
  const lines = (r.stdout ?? "").split("\n").filter((l) => l.trim().length > 0);
  const count = lines.length > 0 ? lines.length - 1 : 0; // drop the COMMAND/PID header row
  const stderr = (r.stderr ?? "").split("\n").find((l) => l.trim().length > 0);
  // lsof exits 1 for "found nothing", which is a normal answer, so the status alone cannot separate
  // a clean empty scan from a broken one. stderr can: a permission warning means the scan was
  // PARTIAL, and a partial scan that found nothing has not established that nothing is open.
  if (stderr && count === 0) return no(`lsof reported "${stderr.trim()}" and listed nothing — an incomplete scan is not "no open files"`);
  if (stderr) return yes(count); // partial, but a positive finding stands on its own
  return yes(count);
}

function listRetainPins(home: string): Known<string[]> {
  try {
    return yes(readdirSync(home).filter((f) => f.endsWith(".retain")));
  } catch (e) {
    return no(`the home is unreadable (${(e as Error).message})`);
  }
}

let homes: string[];
try {
  homes = readdirSync(BASE, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
} catch (e) {
  process.stderr.write(`list-orphan-homes: cannot read the index base ${BASE} (${(e as Error).message})\n`);
  process.exit(1);
}

process.stdout.write(`index base: ${BASE}\n${homes.length} home(s). THIS SCRIPT DELETES NOTHING — it prints evidence for a human.\n\n`);

let candidates = 0, unknowns = 0, busy = 0, published = 0;
for (const name of homes) {
  const home = join(BASE, name);
  const marker = readMarker(home);
  const vaultExists: Known<boolean> = marker.ok ? yes(existsSync(marker.value.vault)) : no(marker.why);
  const canonical: Known<string> = marker.ok ? yes(canonicalizeExisting(marker.value.vault)) : no(marker.why);
  const inTemp: Known<boolean> = canonical.ok ? yes(TEMP_ROOTS.some((r) => canonical.value === r || canonical.value.startsWith(r + sep))) : no(canonical.why);
  const testPrefix: Known<boolean> = marker.ok ? yes(TEST_PREFIXES.some((p) => basename(marker.value.vault).startsWith(p))) : no(marker.why);
  const pins = listRetainPins(home);
  const hasManifest = existsSync(join(home, "generation.json"));
  const open = openFiles(home);

  const isCandidate = inTemp.ok && inTemp.value && testPrefix.ok && testPrefix.value;
  if (isCandidate) candidates += 1;
  if (!marker.ok || !open.ok || !pins.ok) unknowns += 1;
  if (open.ok && open.value > 0) busy += 1;
  if (hasManifest || (pins.ok && pins.value.length > 0)) published += 1;

  process.stdout.write(`${home}\n`);
  process.stdout.write(`  owner vault   ${show(marker, (m) => m.vault)}\n`);
  process.stdout.write(`  vault exists  ${show(vaultExists, (v) => (v ? "yes" : "NO — the marker names a path that is gone"))}\n`);
  process.stdout.write(`  under temp    ${show(inTemp, (v) => (v ? `yes (${canonical.ok ? canonical.value : ""})` : "no"))}\n`);
  process.stdout.write(`  test prefix   ${show(testPrefix, (v) => (v ? "yes" : "no"))}\n`);
  process.stdout.write(`  artefacts     generation.json ${hasManifest ? "present" : "absent"}; retain pins ${show(pins, (p) => (p.length ? p.join(", ") : "none"))}\n`);
  process.stdout.write(`  star identity ${show(marker, (m) => (m.id ? `${m.id}${m.star ? ` (star ${m.star}${m.constellation ? `, ${m.constellation}` : ""})` : ""}` : "none — legacy path-only marker"))}\n`);
  process.stdout.write(`  open files    ${show(open, (n) => (n === 0 ? "none found" : `${n} — A PROCESS IS USING THIS HOME`))}\n`);
  process.stdout.write(`  verdict       ${isCandidate ? "TEST-LITTER CANDIDATE (temp vault + test prefix)" : "keep — not both temp and test-prefixed"}\n\n`);
}

process.stdout.write(
  `${homes.length} home(s) scanned · ${candidates} test-litter candidate(s) · ${busy} with an open file · ` +
  `${published} carrying a manifest or a retain pin · ${unknowns} with at least one piece of evidence unavailable\n` +
  "Nothing was deleted. Delete the candidates by hand, on a quiet machine, with no funes process running.\n",
);
