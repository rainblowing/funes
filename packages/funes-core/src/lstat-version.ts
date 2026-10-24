// ADR-0015: a page stat is {id, version}, an opaque string compared for equality. At a folder the
// version is the lstat triple ADR-0007 compares field by field; this is its one encoding, shared by
// the walk that takes it and the libSQL store that keeps it in its three columns (no schema change).
// `String(n)` is the shortest round-trip form of a double, so two versions are equal exactly when
// all three fields are.

export interface LstatTriple { mtimeMs: number; ctimeMs: number; size: number }

export const lstatVersion = (st: LstatTriple): string => `${st.mtimeMs}:${st.ctimeMs}:${st.size}`;

/** The triple back, or null for a version that is not one (an R2 etag is a version too). */
export function parseLstatVersion(version: string): LstatTriple | null {
  const parts = version.split(":");
  if (parts.length !== 3 || parts.some((p) => p === "")) return null;
  const [mtimeMs, ctimeMs, size] = parts.map(Number) as [number, number, number];
  return [mtimeMs, ctimeMs, size].every(Number.isFinite) ? { mtimeMs, ctimeMs, size } : null;
}
