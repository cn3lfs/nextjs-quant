import { mkdir } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import {
  maBaselineBuildHash,
  runPortfolio,
  type PortfolioInstrument,
} from "quant-backtest";
import { strategyBuildHash } from "trading-strategies";
import {
  researchCostScenarios,
  researchExecutionCosts,
  type ResearchCostScenario,
} from "trading-strategy-core/costs";
import {
  researchTechnicalMethodSeries,
  type TechnicalMethodId,
} from "trading-strategies/research/technical/research-technical-methods";
import {
  readInputs,
  summarizeTheoryResult,
  theoryStudyWindows,
} from "./theory-study";
import {
  assertBindingMarket,
  portfolioBindingsForPreset,
  sourceExitPresets,
} from "../src/lib/research/method-pool-bindings";
import {
  assertResearchExecutionIdentity,
  createResearchRunGuard,
  ensureResearchRegistration,
  researchExecutionIdentity,
  researchJsonHash,
  runResearchMatrix,
  withResearchRunLock,
  writeResearchJsonAtomic,
  type ResearchMatrixRow,
} from "../src/server/research/research-run";

// The preset/strategy/market table owns this list; entry-only divergences,
// fractional sizing and minute-dependent methods cannot enter it.
const presets = sourceExitPresets();

type SourceExitKey = {
  market: "cn-equity" | "crypto";
  strategyId: string;
  window: string;
  scenario: ResearchCostScenario;
};
type SourceExitRow = ResearchMatrixRow<SourceExitKey, Record<string, unknown>>;

function withSourceEvents(
  preset: TechnicalMethodId,
  instruments: readonly PortfolioInstrument[],
) {
  return instruments.map((instrument) => {
    const bars = instrument.signalBars;
    const points = researchTechnicalMethodSeries(preset, bars);
    if (points.length !== bars.length)
      throw new Error("Technical series length differs from its source");
    const signals = points.flatMap((point, index) => {
      const date = bars[index]!.date;
      if (date !== point.date)
        throw new Error("Technical signal date differs from its source");
      return point.entry || point.exit
        ? [
            {
              id: preset,
              date,
              availableAt: date,
              entry: point.entry,
              exit: point.exit,
            },
          ]
        : [];
    });
    return { ...instrument, external: { ...instrument.external, signals } };
  });
}

const [marketArgument, suppliedDirectory, sourcePath, costScenarioArg] =
  process.argv.slice(2);
if (
  (marketArgument !== "crypto" && marketArgument !== "cn-equity") ||
  !suppliedDirectory ||
  !sourcePath
)
  throw new Error(
    "Expected market, output directory and frozen source manifest",
  );
const market: SourceExitKey["market"] = marketArgument;
const costScenario = (costScenarioArg ?? "base") as ResearchCostScenario;
if (!researchCostScenarios.includes(costScenario))
  throw new Error("cost scenario must be fixed, base or double-cost");
const output = resolve(suppliedDirectory);
const local = relative(resolve(".test-data"), output);
if (!local || local.startsWith("..") || isAbsolute(local))
  throw new Error("The output must be a task directory beneath .test-data");
for (const preset of presets)
  for (const binding of portfolioBindingsForPreset(preset))
    if (binding.kind === "source-exit") assertBindingMarket(binding, market);
process.env.QUANT_DATA_DIR = join(output, "data");
await mkdir(output, { recursive: true });

await withResearchRunLock(join(output, ".run.lock"), async () => {
  const budget = { maxRssMiB: 4096 };
  const inputs = await readInputs(
    sourcePath,
    market === "crypto" ? 1 : 799,
    budget,
  );
  const instruments = market === "crypto" ? inputs.crypto : inputs.cn;
  const symbols = instruments.map((instrument) => instrument.symbol);
  const calendar = [
    ...new Set(
      instruments.flatMap((instrument) =>
        instrument.bars.map((bar) => bar.date),
      ),
    ),
  ].sort();
  const window = theoryStudyWindows[0];
  const definitionSource =
    "packages/trading-strategies/dist/research/technical/research-technical-methods.js";
  const execution = await researchExecutionIdentity({
    runner: new URL(import.meta.url),
    // The runner reuses theory-study's input/summary functions and the shared
    // binding table; all three are outside the package build hash.
    definitions: [
      new URL("./theory-study.ts", import.meta.url),
      new URL("../src/lib/research/method-pool-bindings.ts", import.meta.url),
      new URL("./lib/research/method-pool-low-volatility.ts", import.meta.url),
      new URL(
        "./lib/research/method-pool-relative-strength.ts",
        import.meta.url,
      ),
      definitionSource,
    ],
  });
  const registration = {
    version: "theory-study-ten-3",
    execution,
    strategyBuildHash,
    engineBuildHash: maBaselineBuildHash,
    account: { maxPositions: 10, targetWeight: 0.1 },
    markets: [market],
    windows: [window],
    scenarios: [costScenario],
    includeBaseline: false,
    candidates: presets.map((preset) => "source-" + preset),
    inputEvidence: inputs.evidence,
    biasTags: inputs.biasTags,
    definition:
      "Explicit original daily entry and exit events; next available open",
  };
  const identity = researchJsonHash(registration);
  const registrationPath = join(output, "registration-" + identity + ".json");
  await ensureResearchRegistration(registrationPath, registration, identity);
  const assertIdentity = async () =>
    assertResearchExecutionIdentity(
      execution,
      "Research execution dependencies changed during execution",
    );
  const cells = presets.map((preset) => {
    const strategyId = "source-" + preset;
    // Explicitly typed so the key keeps its recorded shape instead of being
    // widened by the surrounding object literal inference.
    const key: SourceExitKey = {
      market,
      strategyId,
      window: window.label,
      scenario: costScenario,
    };
    return {
      key,
      checkpointPath: join(
        output,
        `${identity}-${market}-${strategyId}-${window.label}-${costScenario}.json`,
      ),
    };
  });
  const rows = await runResearchMatrix<SourceExitKey, SourceExitRow>({
    identity,
    journalPath: join(output, `attempts-${identity}.jsonl`),
    cells,
    beforeResume: assertIdentity,
    beforeCommit: assertIdentity,
    blockedRow: ({ key }, error) => ({
      ...key,
      status: "blocked",
      reason: error instanceof Error ? error.message : String(error),
    }),
    onRow: (row, _cell, origin) => {
      if (origin === "computed") console.log(JSON.stringify(row));
    },
    execute: async ({ key }) => {
      const preset = key.strategyId.slice(
        "source-".length,
      ) as TechnicalMethodId;
      const result = runPortfolio(
        {
          market,
          start: window.start,
          end: window.end,
          calendar,
          initial: 1_000_000,
          instruments: withSourceEvents(preset, instruments),
          strategies: [
            {
              id: key.strategyId,
              version: 1,
              market,
              period: "day",
              universe: { kind: "symbols", symbols },
              entry: { kind: "external", id: preset, side: "entry" },
              exit: { rule: { kind: "external", id: preset, side: "exit" } },
              sizing: { kind: "weight", weight: 0.1 },
              sleeve: "swing",
            },
          ],
          sleeves: [
            { id: "swing", share: 1, maxPositions: 10, riskPerTrade: 0.01 },
          ],
          costs: researchExecutionCosts(market, costScenario),
          observationDetail: "counts",
        },
        createResearchRunGuard(budget),
      );
      return {
        ...key,
        status: "completed",
        ...summarizeTheoryResult(result, 1_000_000),
      };
    },
  });
  await writeResearchJsonAtomic(
    join(output, "results-" + identity + "-source-exit.json"),
    { identity, registrationPath, rows },
    { beforeCommit: assertIdentity },
  );
});
