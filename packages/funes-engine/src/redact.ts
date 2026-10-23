// The deterministic secret detector — PURE (no LLM, no I/O). Ported from twinkling's
// `ts/src/redact.ts` with the OKF exporter (PLAN-0.2.1 step 26), unchanged except for this header.
//
// It is NOT in gitleaks-belt, which is where an implementer looks first and finds nothing: that
// module wraps the gitleaks BINARY and fails OPEN by design (`scanned: false` when gitleaks is
// missing). This file is the floor underneath it. The exporter runs it over every exported byte
// unconditionally and refuses on a nonzero count, because a bundle's whole purpose is to be shared
// and "I could not scan it" must never read as "it is clean".
//
// Two callers, two uses, and the difference matters: twinkling's distiller uses the returned TEXT
// (it neutralizes bytes before they reach a prompt), while the exporter uses only the COUNT (it
// refuses rather than silently shipping a redacted page the author never saw).
//
// Honest caveat (carried from the brief): regex/heuristic detection is BEST-EFFORT, not a
// guarantee. The design bias is fail-safe-for-USE (non-secret numbers — dates, amounts, phone
// numbers, telegram ids — must survive so the distilled summary stays useful) while still
// stripping the obvious secret classes. Each detector replaces only the SECRET span; identifying
// keywords (`password`, `api_key`) survive so the summary can say a credential was exchanged.
//
// Idempotence is structural: every detector either cannot match a `[REDACTED:...]` placeholder
// (too short / wrong shape) or explicitly skips a captured value that already is one — so
// redact(redact(x)).text === redact(x).text.

import { BIP39_EN } from "./bip39-english.ts";

export interface RedactResult {
  text: string;
  /** Total number of secret spans replaced. */
  count: number;
  /** Per-kind tally (only kinds that fired appear). */
  kinds: Record<string, number>;
}

/** A captured secret that is already a placeholder must never be re-redacted (idempotence). */
const IS_PLACEHOLDER = /^\[REDACTED:/;

/** Luhn checksum (mod-10). One of TWO gates a digit run must pass to be treated as a card. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48; // '0' === 48
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Major-brand card prefixes (IIN/BIN) + lengths. The SECOND card gate: ~1 in 10 random 16-digit
 *  numbers passes Luhn by chance, so long ids / coordinates / filenames were false-positiving (seen
 *  in the T5 first slice: a `2_…​.mp4` filename and a map-coordinate longitude). Requiring a real
 *  brand prefix + a brand-valid length, on top of Luhn, drops that to near zero. Covers Visa,
 *  Mastercard (incl. 2-series), Amex, Discover, Diners, JCB. */
const CARD_BRAND =
  /^(?:4\d{12}(?:\d{3})?(?:\d{3})?|5[1-5]\d{14}|2(?:2(?:2[1-9]|[3-9]\d)|[3-6]\d{2}|7(?:[01]\d|20))\d{12}|3[47]\d{13}|6(?:011|5\d{2}|4[4-9]\d)\d{10}|3(?:0[0-5]|[68]\d)\d{11}|35\d{14})$/;

/** Deterministic secret redaction. Returns the neutralized text plus an accurate count/tally.
 *  Detectors run most-specific-first so a span is labelled once; placeholders are inert to every
 *  later detector (idempotence). */
export function redact(input: string): RedactResult {
  const kinds: Record<string, number> = {};
  const bump = (k: string): void => {
    kinds[k] = (kinds[k] ?? 0) + 1;
  };
  let text = input;

  // 1. PEM private-key blocks — the whole BEGIN…END block is the secret.
  text = text.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    () => {
      bump("private-key");
      return "[REDACTED:private-key]";
    },
  );

  // 2. Hex private keys — 0x + exactly 64 hex chars (32 bytes); the lookahead keeps it from
  //    matching a 64-char prefix of a longer hex blob.
  text = text.replace(/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, () => {
    bump("private-key");
    return "[REDACTED:private-key]";
  });

  // 3. Bare 64-hex (no 0x) — a raw 32-byte key in its common export form. Gated on a key/seed
  //    keyword within ~40 chars before it so commit shas / content hashes with no such context
  //    survive (real keys contain 0s, so the 0x detector alone misses the keyless export). The
  //    offset-context check reads the in-progress string, consistent with replace()'s left-to-right.
  text = text.replace(/(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, (run: string, offset: number) => {
    const before = text.slice(Math.max(0, offset - 40), offset);
    if (!/(private|key|ключ|приватн|seed|mnemonic|wallet|кошел)/i.test(before)) return run;
    bump("private-key");
    return "[REDACTED:private-key]";
  });

  // 4. base58 WIF-ish long runs near key|ключ|private|приватн — keyword shortly before the run
  //    (≤20 non-base58 chars). 44+ base58 chars ≈ a raw/WIF key; ordinary words never reach it.
  text = text.replace(
    /(private|key|ключ|приватн[а-я]*)([^A-Za-z0-9]{1,20})([1-9A-HJ-NP-Za-km-z]{44,})/giu,
    (whole, kw: string, sep: string, tok: string) => {
      if (IS_PLACEHOLDER.test(tok)) return whole;
      bump("private-key");
      return `${kw}${sep}[REDACTED:private-key]`;
    },
  );

  // 5. Self-identifying API tokens (the prefix IS the signal — ~zero false-positive rate).
  const apiToken = (re: RegExp): void => {
    text = text.replace(re, () => {
      bump("api-token");
      return "[REDACTED:api-token]";
    });
  };
  apiToken(/\bsk-[A-Za-z0-9]{20,}/g); // OpenAI
  apiToken(/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g); // Stripe live/test/restricted
  apiToken(/\bgh[pousr]_[A-Za-z0-9]{20,}/g); // GitHub
  apiToken(/\bAKIA[0-9A-Z]{16}\b/g); // AWS access-key id
  apiToken(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g); // Slack
  apiToken(/\bAIza[0-9A-Za-z_-]{35}\b/g); // Google API key

  // 6. Generic high-entropy-shaped token (32+ of [A-Za-z0-9_-]) — ONLY when a token keyword is
  //    shortly before it. The keyword gate is what keeps long hashes / base64 / commit shas from
  //    being false-positived. The keyword + separator survive; only the token is replaced.
  text = text.replace(
    /(token|api[_-]?key|secret|bearer)([^A-Za-z0-9]{1,20})([A-Za-z0-9_-]{32,})/gi,
    (whole, kw: string, sep: string, tok: string) => {
      if (IS_PLACEHOLDER.test(tok) || tok.startsWith("REDACTED")) return whole;
      bump("api-token");
      return `${kw}${sep}[REDACTED:api-token]`;
    },
  );

  // 7. Seed phrases / mnemonics — ≥12 consecutive BIP39-shaped lowercase [a-z]{3,8} tokens
  //    (tolerating per-token numbering `1.`/`2)` and space / newline / comma separators — the forms
  //    wallet exports and hand-transcribed seeds use), VALIDATED against the BIP39 English wordlist.
  //    The wordlist gate is what separates a real mnemonic (≈all words are BIP39) from a run of
  //    ordinary short English words (chat prose), which the shape alone false-positived. A couple
  //    of off-list tokens are tolerated (transcription typos). Placeholders carry uppercase
  //    "REDACTED" so they never form part of a run (idempotence).
  text = text.replace(
    /(?:\d{1,2}[.)]\s*)?[a-z]{3,8}(?:[\s,]+(?:\d{1,2}[.)]\s*)?[a-z]{3,8}){11,}/g,
    (run: string) => {
      const toks = run.match(/[a-z]{3,8}/g) ?? [];
      const members = toks.filter((t) => BIP39_EN.has(t)).length;
      if (members < 11 || members / toks.length < 0.85) return run; // prose, not a mnemonic
      bump("seed");
      return "[REDACTED:seed]";
    },
  );

  // 8. Card numbers — 13–19 digits, optionally grouped by single spaces/dashes (the dominant human
  //    rendering), that pass Luhn. Joining-then-Luhn lets dates/amounts/ids/phone fragments (too
  //    short, or failing the checksum) survive untouched. Runs BEFORE passwords so a card on a
  //    "password: …" line is labelled `card`, not swallowed into the password redaction.
  text = text.replace(/(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g, (run: string) => {
    const digits = run.replace(/[ -]/g, "");
    if (!luhnValid(digits) || !CARD_BRAND.test(digits)) return run; // both gates: random Luhn-pass ≠ card
    bump("card");
    return "[REDACTED:card]";
  });

  // 9a. Passwords with an explicit connector (`:`/`=`/`-`) — the secret is the rest of the line.
  //     "password: hunter 2" (multi-word value) goes entirely. Keyword + connector survive.
  text = text.replace(
    /(password|passwd|pwd|пароль|пасс)(\s*[:=-]\s*)(\S.*)$/gim,
    (whole, kw: string, sep: string, secret: string) => {
      if (IS_PLACEHOLDER.test(secret.trim())) return whole;
      bump("password");
      return `${kw}${sep}[REDACTED:password]`;
    },
  );
  // 9b. Space-separated passwords ("password is hunter2", "пароль вайфая 12345678") — after the
  //     keyword, allow up to 3 descriptor words, then redact the first SECRET-SHAPED token (contains
  //     a digit, or 12+ alnum). The required `[ \t]+` after the keyword is the boundary (no `\b` —
  //     it is ASCII-only and would never fire after a Cyrillic keyword like "пароль"). Precise
  //     enough to spare prose like "password manager is great" (no secret-shaped token follows).
  text = text.replace(
    /(password|passwd|pwd|пароль|пасс)((?:[ \t]+\S+){0,3}?[ \t]+)(\S*\d\S*|[A-Za-z0-9]{12,})/giu,
    (whole, kw: string, sep: string, tok: string) => {
      if (IS_PLACEHOLDER.test(tok) || tok.startsWith("REDACTED")) return whole;
      bump("password");
      return `${kw}${sep}[REDACTED:password]`;
    },
  );

  const count = Object.values(kinds).reduce((a, b) => a + b, 0);
  return { text, count, kinds };
}
