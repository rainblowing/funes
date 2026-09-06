// Chunking (H1) — pure, portable, and shared by BOTH backends + the embedder, so it lives in the
// edge-portable core (P3.14: funes-libsql used to import this from funes-engine, which is half of
// the package cycle that blocked publishing). The E5 embedder itself stays in funes-engine — it
// needs @huggingface/transformers, which the core's H7 purity lint forbids.
//
// Pages embed as MULTIPLE chunk rows (multi-row chosen over max-pooling for needle recall: a
// distinctive phrase mid-file must be findable, not averaged away). Char-based windows snapped
// to word boundaries; the overlap guarantees any phrase shorter than CHUNK_OVERLAP survives
// intact in at least one chunk. 1800 chars stays under the embedder's MAX_CHARS=2000 so the
// per-chunk truncation there never fires.
export const CHUNK_SIZE = 1800;
export const MAX_CHUNKS_PER_PAGE = 256;
export const CHUNK_OVERLAP = 200;
/** Chunking suffix of the persisted embedding signature: `<model>:<dim>:chunk1800o200`.
 *  Changing chunk params (like changing the model) is an index-breaking change — the H1 drift
 *  guard hard-stops on open and tells the user to delete the index + reindex. That is the
 *  intended one-time migration UX for existing pre-chunking indexes. */
export const CHUNK_SIG = `chunk${CHUNK_SIZE}o${CHUNK_OVERLAP}`;

/** Split text into overlapping, word-boundary-snapped windows (H1). Deterministic, char-based.
 *  Text at or under `size` returns a single chunk — identical to the old whole-text embed. */
export function chunkText(text: string, opts: { size?: number; overlap?: number; maxChunks?: number } = {}): string[] {
  const size = opts.size ?? CHUNK_SIZE;
  const overlap = opts.overlap ?? CHUNK_OVERLAP;
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      // snap the cut back to the last whitespace in the window so words stay intact; skip the
      // snap if it would more than halve the chunk (one giant unbroken token — hard-cut it)
      const win = text.slice(start, end);
      const ws = Math.max(win.lastIndexOf(" "), win.lastIndexOf("\n"), win.lastIndexOf("\t"));
      if (ws > size / 2) end = start + ws;
    }
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    let next = end - overlap;
    // snap the next start forward past a partial word (the cut above was on a boundary, but
    // `end - overlap` may land mid-word)
    if (next > 0 && !/\s/.test(text[next - 1]!)) {
      const m = text.slice(next, end).search(/\s/);
      if (m >= 0) next += m + 1;
    }
    start = next; // progress guaranteed: end >= start + size/2 and overlap < size/2
  }
  // Multi-MB export dumps would otherwise yield thousands of chunks for one low-value file
  // (the vault has 8MB md artifacts). 256 chunks ≈ 410k chars — fully covers chat-export-class
  // pages (the H1 motivating case was ~400KB) while bounding pathological inputs. FTS still
  // indexes the first 250k chars regardless.
  const maxChunks = opts.maxChunks ?? MAX_CHUNKS_PER_PAGE;
  return chunks.length > maxChunks ? chunks.slice(0, maxChunks) : chunks;
}
