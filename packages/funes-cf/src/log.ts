// funes-cf's one allowlisted logger (PLAN-0.5.0 item 43; record 34 "Console output" and "Errors").
// Besides funes' ADR-0005 audit line (`funes write-designation …`), this is the only console line the
// Worker and its DO write: `{event, name, code}` — never a message, cause, stack or stringified
// error, which can carry a query string, a header, page text or a token (record 35 L9/L10).

/** What a name or a code may be to reach a log line: an identifier, never free text. */
const IDENT = /^[A-Za-z0-9_.:-]{1,64}$/;
const ident = (v: unknown): string | null => (typeof v === "string" && IDENT.test(v) ? v : typeof v === "number" ? String(v) : null);

/** Log a caught error as `{event, name, code}` only. */
export function logError(event: string, e: unknown): void {
  const err = e as { name?: unknown; code?: unknown } | null | undefined;
  console.error(JSON.stringify({ event, name: ident(err?.name) ?? "unknown", code: ident(err?.code) }));
}
