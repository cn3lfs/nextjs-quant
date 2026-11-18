import { resolve } from "node:path";
import { methodPoolInventory, runTheoryStudy } from "./theory-study";
import { writeResearchJsonAtomic } from "../src/server/research/research-run";
import { entryStudyStrategyIds } from "../src/lib/research/method-pool-bindings";

const [
  directory = ".test-data/method-pool-ten/signal-study",
  market = "default",
] = process.argv.slice(2);
const inventory = await methodPoolInventory();
const runnable = new Set<string>(inventory.candidates);
const eligible = entryStudyStrategyIds().filter((id) => runnable.has(id));
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
const rows = result.results as unknown as {
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
