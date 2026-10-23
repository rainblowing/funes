// The one port-level composition (RAI-313, RAI-315 Q8/Q11): a dispatcher context over ports — a
// FunesStore over the vault and the index, the star config, the tier and the write designation the
// host resolved. The edge writer (funes-cf) composes its frame with it, the engine's folderContext
// wraps it with the folder ports, and a harness fake calls it. A harness export: the ports still move
// until 1.0.0, so it is not frozen.
import type { ServingIndex } from "./index-store.ts";
import type { Grant } from "./actor.ts";
import { FunesStore, starConfigFromText, type FunesStoreOpts, type StarConfig } from "./funes-store.ts";
import type { OperationContext, Tier } from "./ops.ts";
import type { WriteDesignation } from "./write-designation.ts";

/** The star config as a live thunk (a folder re-reads `star.yaml`), or as `star.yaml` text read once
 *  (the edge's bundled star, a harness fake). */
type StarPort = { star: () => StarConfig } | { starText: string };

export function portContext(o: Omit<FunesStoreOpts, "star"> & StarPort & {
  index: ServingIndex;
  tier: Tier;
  designation: WriteDesignation;
  grant?: Grant;
  actor?: string;
}): OperationContext {
  const { index, tier, designation, grant, actor, ...rest } = o;
  let star: () => StarConfig;
  if ("starText" in rest) {
    const config = starConfigFromText(rest.starText);
    star = () => config;
  } else star = rest.star;
  const { starText: _t, star: _s, ...ports } = rest as typeof rest & { starText?: string; star?: unknown };
  return {
    vault: o.vault, star, store: index, funes: new FunesStore(index, { ...ports, star }),
    tier, designation, ...(grant ? { grant } : {}), ...(actor ? { actor } : {}),
  };
}
