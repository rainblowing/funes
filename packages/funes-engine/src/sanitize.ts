// H4 (S3): the real sanitize step behind D11/§3d — every remember() input passes through this
// before persistence. Deterministic normalization ONLY: this is the lone-local INGEST posture
// ("trust-tag only" per the trifecta table); the LLM guardrail-agent layer is the user-facing
// preset and lands with S4+. What this guarantees:
//   - no NUL / C0 control characters reach canonical markdown or Postgres text columns
//     (Postgres rejects NUL outright; control chars break frontmatter round-trips)
//   - no ANSI/OSC escape sequences (terminal-injection via recalled text)
//   - inputs are size-capped so one runaway remember can't write a multi-MB memory item
//   - line endings normalized so content hashes are stable across OS/agents

const MAX_CHARS = 100_000;

// ESC [ ... cmd  |  ESC ] ... BEL/ST  |  bare ESC  — assembled from char codes so no literal
// control characters live in this source file.
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;?]*[ -/]*[@-~]|" + ESC + "\\][^\\u0007]*(\\u0007|" + ESC + "\\\\)|" + ESC, "g");
// C0 controls minus \t \n \r, plus DEL
const CONTROL = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(8) + String.fromCharCode(11) + String.fromCharCode(12) + String.fromCharCode(14) + "-" + String.fromCharCode(31) + String.fromCharCode(127) + "]", "g");

/** Deterministic input normalization for memory writes. Idempotent. */
export function sanitizeText(text: string): string {
  return text
    .replace(ANSI, "")
    .replace(CONTROL, "")
    .replace(/\r\n?/g, "\n")
    .slice(0, MAX_CHARS);
}
