import { resolve } from "node:path";
import { methodPoolInventory, runTheoryStudy } from "./theory-study";
import { writeResearchJsonAtomic } from "../src/server/research/research-run";

const [
  directory = ".test-data/method-pool-ten/signal-study",
  market = "default",
] = process.argv.slice(2);
const inventory = await methodPoolInventory();
const eligible = inventory.candidates.filter(
  (id) => id.startsWith("entry5-") || id === "research-growth",
);
const requested = process.argv[4]?.split(",");
if (
  requested?.some((id) => !eligible.includes(id as (typeof eligible)[number]))
)
  throw new Error("Selected IDs must be registered entry studies");
const candidates = requested
  ? eligible.filter((id) => requested.includes(id))
  : eligible;
const result = await runTheoryStudy([
  "--output",
  directory,
  "--stage",
  "first-pass",
  "--without-baseline",
  "--strategies",
  candidates.join(","),
  "--market",
  market,
]);
const rows = result.results as {
  strategyId: string;
  market: string;
  status: string;
  buys?: number;
  sells?: number;
  rejections?: number;
  reason?: string;
}[];
await writeResearchJsonAtomic(resolve(directory, "signal-study.json"), {
  identity: result.identity,
  candidates,
  kind: "entry-event-study",
  rows: rows.map(
    ({ strategyId, market, status, buys, sells, rejections, reason }) => ({
      strategyId,
      market,
      status,
      entriesFilled: buys,
      exitsFilled: sells,
      rejections,
      reason,
    }),
  ),
});
