/** env.AI's `run` in every funes-cf test: a deterministic fake, never Workers AI. One 1024-dim unit
 *  vector per text. vitest.config.ts serializes this function into its miniflare worker and
 *  test/local-endpoint.entry.ts calls it directly, so it must close over nothing. */
export function fakeAiRun(_model: string, inputs: { text: string | string[] }) {
  const texts = ([] as string[]).concat(inputs.text);
  return { shape: [texts.length, 1024], data: texts.map((t) => Array.from({ length: 1024 }, (_, i) => (i === t.length % 1024 ? 1 : 0))) };
}
