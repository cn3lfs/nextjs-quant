import { readFile, mkdir } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import {
  maBaselineBuildHash,
  runPortfolio,
  type PortfolioInstrument,
} from "quant-backtest";
import { strategyBuildHash } from "trading-strategies";
import { executionCostsSchema } from "trading-strategy-core/costs";
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
  createResearchRunGuard,
  ensureResearchRegistration,
  readResearchCheckpoint,
  researchDigest,
  researchJsonHash,
  withResearchRunLock,
  writeResearchCheckpoint,
  writeResearchJsonAtomic,
} from "../src/server/research/research-run";

// Explicit source exits; entry-only divergences, fractional sizing, and
// minute-dependent methods have separate evidence and cannot enter this list.
const presets = [
  "sw-macd-negative",
  "sw-macd-red",
  "sw-macd-green",
  "sw-macd-top",
  "sw-macd-double-top",
  "sw-kdj-zone",
  "sw-kdj-range",
  "sw-rsi-state",
  "sw-rsi-neutral",
  "sw-rsi-top",
  "sw-boll-squeeze",
  "sw-boll-expand",
  "sw-boll-upper",
  "sw-boll-lower",
  "sw-support-20",
  "sw-support-60",
  "sw-support-120",
  "sw-support-250",
  "sw-volume-up-up",
  "sw-volume-up-down",
  "sw-volume-down-up",
  "sw-volume-down-down",
  "sw-volume-top",
  "sw-volume-bottom",
  "sw-volume-breakout",
  "sw-direction",
  "sw-bear-order",
  "sw-tangle",
] as const satisfies readonly TechnicalMethodId[];

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

const [market, suppliedDirectory, sourcePath] = process.argv.slice(2);
if (
  (market !== "crypto" && market !== "cn-equity") ||
  !suppliedDirectory ||
  !sourcePath
)
  throw new Error(
    "Expected market, output directory and frozen source manifest",
  );
const output = resolve(suppliedDirectory);
const local = relative(resolve(".test-data"), output);
if (!local || local.startsWith("..") || isAbsolute(local))
  throw new Error("The output must be a task directory beneath .test-data");
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
  const runnerHash = researchDigest(await readFile(new URL(import.meta.url)));
  const definitionSource =
    "packages/trading-strategies/dist/research/technical/research-technical-methods.js";
  const definitionHash = researchDigest(await readFile(definitionSource));
  const registration = {
    version: "theory-study-ten-2",
    runnerHash,
    definitionHash,
    strategyBuildHash,
    engineBuildHash: maBaselineBuildHash,
    account: { maxPositions: 10, targetWeight: 0.1 },
    markets: [market],
    windows: [window],
    scenarios: ["base"],
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
  const rows = [];
  for (const preset of presets) {
    const strategyId = "source-" + preset;
    const key = { market, strategyId, window: window.label, scenario: "base" };
    const path = join(
      output,
      `${identity}-${market}-${strategyId}-${window.label}-base.json`,
    );
    const saved = await readResearchCheckpoint(path, { identity, key });
    if (saved) {
      rows.push(saved.row);
      continue;
    }
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
            id: strategyId,
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
        costs: executionCostsSchema.parse(
          market === "crypto"
            ? {
                commissionBps: 10,
                minimumCommission: 0,
                sellTaxBps: 0,
                slippageBps: 5,
              }
            : {
                commissionBps: 3,
                minimumCommission: 5,
                sellTaxBps: 5,
                slippageBps: 5,
                sellTaxSchedule: {
                  kind: "cn-equity-historical",
                  multiplier: 1,
                },
              },
        ),
        observationDetail: "counts",
      },
      createResearchRunGuard(budget),
    );
    const row = {
      ...key,
      status: "completed",
      ...summarizeTheoryResult(result, 1_000_000),
    };
    await writeResearchCheckpoint(
      path,
      { identity, key, row },
      {
        beforeCommit: async () => {
          if (
            researchDigest(await readFile(definitionSource)) !==
              definitionHash ||
            researchDigest(await readFile(new URL(import.meta.url))) !==
              runnerHash
          )
            throw new Error("Research source changed during execution");
        },
      },
    );
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  await writeResearchJsonAtomic(
    join(output, "results-" + identity + "-source-exit.json"),
    { identity, registrationPath, rows },
  );
});
