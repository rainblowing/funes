// The proposal protocol's handshake (record 24 §1; PLAN-0.5.0 items 30 and 40): the writer's `health`
// names the protocol, the star it serves and its locus, and the outbox sends nothing unless all three
// are this star's. Both sides import this module inside funes-cf (RAI-303) — the outbox and the seed
// (replica/, Bun) and the edge writer (workerd) — so the protocol number and the check are one definition.
import { sameStar } from "funes-core/internal";
import { normalizeDesignation } from "funes-core/internal";

/** The proposal protocol the outbox speaks and the edge writer's `health` names. */
export const PROPOSAL_PROTOCOL = 1;

/** Why a writer's `health` answer does not admit a send, or null when it names the protocol, this
 *  star (`sameStar`) and its write locus (after normalization). */
export function probeRefusal(h: Record<string, unknown>, starId: string, writeLocus: unknown): string | null {
  if (h.proposalProtocol !== PROPOSAL_PROTOCOL) return `refused: the writer speaks no proposal protocol ${PROPOSAL_PROTOCOL} (${JSON.stringify(h.proposalProtocol ?? null)})`;
  if (typeof h.starId !== "string" || !sameStar(h.starId, starId)) return `refused: the writer serves ${JSON.stringify(h.starId ?? null)}, not ${starId}`;
  const want = typeof writeLocus === "string" ? normalizeDesignation(writeLocus) : null;
  if (want === null || typeof h.locus !== "string" || normalizeDesignation(h.locus) !== want) {
    return `refused: the writer's locus ${JSON.stringify(h.locus ?? null)} is not this star's write_locus ${JSON.stringify(writeLocus ?? null)}`;
  }
  return null;
}
