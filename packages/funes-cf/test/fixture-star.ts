// The neutral fixture star every funes-cf test serves (RAI-316: no test names the taste star). Its
// star.yaml is what the deploy login puts at R2 `<key>/_/star.yaml` (ADR-0024): written by FUNES_LOCUS
// funes-taste (wrangler.test.jsonc), memory_dir and item_pages declared, two Telegram ids allowed.
export const FIXTURE_KEY = "example.org/fixture";
export const FIXTURE_ID = `mcp://${FIXTURE_KEY}`;

/** A star.yaml for `key`; `extra` lines go at the end of the `memory` block. */
export const starYaml = (key: string, o: { writeLocus?: string; extra?: string; mintIds?: string } = {}) => `version: 3
meta:
  id: mcp://${key}
  name: fixture
  write_locus: ${o.writeLocus ?? "funes-taste"}
memory:
  okf: "0.2"
  memory_dir: items
  item_pages: true
  recall:
    keys: [domain, type, status, suggested, score, score_proxy, year, title]
    values:
      domain: [books, movies]
    serve: [domain, status, suggested, score, score_proxy, type, creator, year]
    collapse: [type, creator]
${o.extra ?? ""}
edge:
  mint:
    telegram_ids: ${o.mintIds ?? "[4242, 77]"}
`;

export const FIXTURE_YAML = starYaml(FIXTURE_KEY);

/** Put a star's config where its object loads it (the deploy login's act, ADR-0024). */
export async function seedStar(bucket: R2Bucket, key = FIXTURE_KEY, yaml = starYaml(key)): Promise<void> {
  await bucket.put(`${key}/_/star.yaml`, yaml);
}
