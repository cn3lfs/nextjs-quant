import { readdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  readResearchCheckpoint,
  researchJsonHash,
} from "../src/server/research/research-run";
import {
  bindingForStrategy,
  isEntryStudyStrategy,
  isMethodPoolRegistrationVersion,
} from "../src/lib/research/method-pool-bindings";

type Row = {
  status: string;
  strategyId: string;
  market: string;
  window: string;
  scenario: string;
  netReturn?: number;
  returnToDrawdown?: number | null;
  sells?: number;
  rejections?: number;
  buys?: number;
  reason?: string;
};
const [directory, identity] = process.argv.slice(2);
if (!directory || !identity || !/^[a-f0-9]{64}$/.test(identity))
  throw new Error("Expected result directory and exact registration hash");
const root = resolve(directory);
const registration = JSON.parse(
  await readFile(join(root, `registration-${identity}.json`), "utf8"),
);
if (
  !isMethodPoolRegistrationVersion(registration.version) ||
  researchJsonHash(registration) !== identity
)
  throw new Error("Registration is not the frozen ten-position study");
const rows: Row[] = [];
for (const name of await readdir(root)) {
  if (!name.startsWith(identity + "-") || !name.endsWith(".json")) continue;
  const path = join(root, name);
  const { key } = JSON.parse(await readFile(path, "utf8"));
  if (
    name !==
    `${identity}-${key.market}-${key.strategyId}-${key.window}-${key.scenario}.json`
  )
    throw new Error("Checkpoint name differs from scenario");
  const checkpoint = await readResearchCheckpoint<Row>(path, { identity, key });
  if (checkpoint) rows.push(checkpoint.row);
}
const isEntryStudy = isEntryStudyStrategy;
const decisions = [];
const pending = [];
for (const market of registration.markets ?? ["cn-equity", "crypto"]) {
  const marketRows = rows.filter((r) => r.market === market);
  const strategyIds =
    registration.includeBaseline === false
      ? registration.candidates
      : ["baseline-hold", ...registration.candidates];
  for (const strategyId of strategyIds) {
    const own = marketRows.filter((r) => r.strategyId === strategyId);
    for (const window of registration.windows)
      for (const scenario of registration.scenarios) {
        if (
          !own.some((r) => r.window === window.label && r.scenario === scenario)
        )
          pending.push({ market, strategyId, window: window.label, scenario });
      }
    const completed = own.filter((row) => row.status === "completed");
    const later = completed.filter(
      (row) => row.window === "reused-history-validation",
    );
    const base = later.find((row) => row.scenario === "base");
    const pressure = later.find((row) => row.scenario === "double-cost");
    let status: string;
    if (!completed.length) status = own.length ? "blocked" : "pending";
    else if (isEntryStudy(strategyId)) status = "signal-study";
    else if (strategyId === "baseline-hold") status = "symbol-order-reference";
    else if (completed.every((row) => row.buys === 0)) status = "zero-buys";
    else if (base?.buys && pressure?.buys && base.netReturn! > 0)
      status =
        pressure.netReturn! > 0
          ? "positive-under-tested-costs"
          : "cost-sensitive";
    else status = "observed";
    decisions.push({
      market,
      strategyId,
      kind: isEntryStudy(strategyId) ? "entry-study" : "portfolio",
      bindingKind:
        bindingForStrategy(strategyId)?.kind ??
        (isEntryStudy(strategyId)
          ? "entry-experiment"
          : strategyId.startsWith("source-")
            ? "source-exit"
            : "portfolio"),
      status,
    });
  }
}
const reports = rows.map((row) => {
  if (!isEntryStudy(row.strategyId)) return row;
  const {
    strategyId,
    market,
    window,
    scenario,
    status,
    buys,
    sells,
    rejections,
    reason,
  } = row;
  return {
    strategyId,
    market,
    window,
    scenario,
    status,
    entriesFilled: buys,
    exitsFilled: sells,
    rejections,
    reason,
  };
});
console.log(
  JSON.stringify(
    { identity, decisions, unobservedRegisteredCases: pending, rows: reports },
    null,
    2,
  ),
);
