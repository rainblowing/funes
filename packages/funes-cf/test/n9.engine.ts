// Record 35 N9's engine half, run by test/n9.node.ts under Bun, each phase in a fresh process whose
// HOME is a scratch directory (never a real funes home):
//   bun n9.engine.ts before <endpoint url>   a legacy (~/.twinkling) home, built with FUNES_HOME: the endpoint file, the outbox
//                                            token, one pending create, replica.json, the canon mirror
//                                            and its index (owner-vault naming the old canon path)
//   bun n9.engine.ts move                    `funes home move` through moveHome
//   bun n9.engine.ts after                   drain the outbox at the endpoint; reopen the canon's index
// Each prints one JSON line. Synthetic pages, a fake embedder, a fake token.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Embedder } from "funes-core";
import { funesHome, stateDirFor } from "../../funes-engine/src/funes-home.ts";
import { makeStore, funesDbDir } from "../../funes-engine/src/factory.ts";
import { drain, enqueue, listOutbox, mcpWriter, outboxDirFor } from "../replica/outbox.ts";
import { moveHome } from "../../funes-engine/src/home-move.ts";
import { FIXTURE_ID, FIXTURE_KEY, FIXTURE_YAML } from "./fixture-star.ts";

const TOKEN = `funes_${"n".repeat(43)}`;
const STAR_ID = FIXTURE_ID;
const STAR_YAML = FIXTURE_YAML;
const PAGE = "---\ntitle: N9 Test\ntype: Film\ndomain: movies\n---\n\n**N9 Test** · Film\n";

class FakeEmbedder implements Embedder {
  readonly dim = 8;
  async embedQuery() { return new Float32Array(8); }
  async embedPassage() { return new Float32Array(8); }
  async embedPassages(ts: string[]) { return ts.map(() => new Float32Array(8)); }
}

const taste = join(homedir(), "taste");
const canon = () => join(stateDirFor(taste), "canon");
const ownerVault = () => JSON.parse(readFileSync(join(dirname(funesDbDir(canon())), "owner-vault"), "utf8")).vault as string;
const openCanon = async () => (await makeStore({ vault: canon(), embedder: new FakeEmbedder() })).close();
const out = (o: unknown) => console.log(JSON.stringify(o));

const [phase, url] = process.argv.slice(2);
if (phase === "before") {
  const legacy = join(homedir(), ".twinkling");
  // 0.6.0 refuses a legacy home (RAI-311), so the legacy state an older funes left is built by
  // pointing FUNES_HOME at it: the same layout under ~/.twinkling.
  process.env.FUNES_HOME = legacy;
  mkdirSync(join(legacy, "locks"), { recursive: true });
  mkdirSync(taste, { recursive: true });
  writeFileSync(join(taste, "star.yaml"), STAR_YAML);
  const tokenFile = join(homedir(), ".config", "funes-outbox-token");
  mkdirSync(join(homedir(), ".config"), { recursive: true });
  writeFileSync(tokenFile, TOKEN + "\n", { mode: 0o600 });
  writeFileSync(join(legacy, "endpoints.json"), JSON.stringify({ [STAR_ID]: { url, token_file: tokenFile } }), { mode: 0o600 });
  chmodSync(join(legacy, "endpoints.json"), 0o600);
  const dir = outboxDirFor(taste);
  const rec = enqueue(dir, { starId: STAR_ID, op: "put_page", args: { path: "items/movies/n9-test.md", content: PAGE } });
  mkdirSync(join(dir, "dismissed"), { recursive: true });
  writeFileSync(join(dir, "dismissed", "01JOLDDISMISSED0000000000.json"), "{}\n");
  writeFileSync(join(stateDirFor(taste), "replica.json"), JSON.stringify({ keys: {} }) + "\n");
  mkdirSync(join(canon(), "items", "movies"), { recursive: true });
  writeFileSync(join(canon(), "star.yaml"), STAR_YAML);
  writeFileSync(join(canon(), "items", "movies", "heat.md"), "---\ntitle: Heat\ntype: Film\ndomain: movies\n---\n\nA crime film.\n");
  await openCanon();
  // The test outbox grant, in the star key's object (test/local-endpoint.entry.ts).
  const sha = new Bun.CryptoHasher("sha256").update(TOKEN).digest("hex");
  const provisioned = (await fetch(`${new URL(url!).origin}/__provision/${FIXTURE_KEY}?sha=${sha}`)).status;
  out({ provisioned, home: funesHome(), proposalId: rec.proposalId, outbox: dir, canon: canon(), ownerVault: ownerVault() });
} else if (phase === "move") {
  out({ log: moveHome() });
} else if (phase === "after") {
  const dir = outboxDirFor(taste);
  const survived = {
    outbox: listOutbox(dir).records.map((r) => [r.proposalId, r.status]),
    dismissed: existsSync(join(dir, "dismissed", "01JOLDDISMISSED0000000000.json")),
    replica: existsSync(join(stateDirFor(taste), "replica.json")),
    canon: existsSync(join(canon(), "items", "movies", "heat.md")),
  };
  await openCanon();
  const ownerVaultAfter = ownerVault();
  const pending = listOutbox(dir).records[0]!;
  const drained = await drain({ vault: taste });
  // A redelivery of the same proposal (a lost reply): the writer's receipt answers it.
  const w = mcpWriter({ url: url!, token: TOKEN });
  const again = await w.call(pending.op, { ...pending.args, proposalId: pending.proposalId });
  await w.close();
  out({ home: funesHome(), survived, canon: canon(), ownerVault: ownerVaultAfter, drained, again, left: listOutbox(dir).records.length });
} else {
  throw new Error(`usage: n9.engine.ts before <url> | move | after <url>`);
}
