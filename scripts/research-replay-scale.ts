import "./lib/research-scale-isolation";
/** Re-execute one frozen candidate, including every training/stress/holdout
 * window; compare all numeric fields. Never saves a new qualification. */
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { researchCandidates } from "trading-strategies";
import type { ValidationDataset } from "../src/server/research/validation-capture";
import {
  projectCandidate,
  numericNeighbors,
} from "../src/server/research/validation-replay";
import { readCachedResearchCryptoWindow } from "../src/server/research/validation-crypto-history";
import { runCandidateCheckpoint } from "../src/server/research/validation-scale";
import { loadEquity } from "./research-equity-scale";
import { studySourceIdentity } from "./lib/research-scale-sources";
import {
  digest,
  build,
  readArtifact,
  readGroups,
  frozen,
} from "./research-scale";

const id = process.argv[2];
if (!id) throw new Error("Pass exactly one frozen candidate ID");
const sourceIdentity = await studySourceIdentity();
const sourceExpected =
  await readArtifact<Awaited<ReturnType<typeof studySourceIdentity>>>(
    "source-identity",
  );
if (!sourceExpected || sourceExpected.hash !== sourceIdentity.hash)
  throw new Error("Frozen study reader/adapter code changed; refuse replay");
const stage = id.startsWith("r2a-crypto-")
  ? "crypto"
  : id.includes("historical-low")
    ? "cnLowZone"
    : id.includes("chan-third-buy")
      ? "chan"
      : "cnSwing";
const group = (await readGroups(stage)).find((g) =>
  g.checkpoints.some((c) => c.row.id === id),
);
if (!group) throw new Error("Frozen candidate checkpoint missing");
let dataset: ValidationDataset, base: ReturnType<typeof frozen>;
if (stage === "crypto") {
  const input = (await readArtifact<{
    coverage: {
      rows: {
        pair: string;
        period: string;
        cacheFile: string;
        cacheSha256: string;
        hash: string;
        bars: number;
      }[];
    };
  }>("crypto-input"))!;
  process.env.QUANT_RESEARCH_BAR_STORE_DIR = resolve(
    ".test-data/r2a2/data/bar-store",
  );
  const instruments: ValidationDataset["instruments"] = [],
    sources: ValidationDataset["sources"] = [];
  for (const row of input.coverage.rows.filter(
    (r) => r.period === group.period,
  )) {
    if (digest(await readFile(row.cacheFile)) !== row.cacheSha256)
      throw new Error("Frozen public-price cache drift");
    const view = await readCachedResearchCryptoWindow({
      instrument: { market: "crypto", symbol: `cx${row.pair}` },
      period: group.period as ValidationDataset["period"],
      adjustment: "none",
      cryptoSource: "binance",
      from: "1970-01-01",
      to: "2026-11-13",
      limit: 2000000,
    });
    if (
      !view ||
      view.snapshot.hash !== row.hash ||
      view.snapshot.bars.length !== row.bars
    )
      throw new Error("Frozen crypto projection drift");
    const bars = view.snapshot.bars;
    instruments.push({
      symbol: `cx${row.pair}`,
      market: "crypto",
      bars,
      signalBars: bars,
      execution: {
        evidence: "Frozen unverified research quantity-grid scenario",
        minimum: 0.000001,
        step: 0.000001,
        maximum: 1e9,
        tradable: true,
        limitUp: null,
        limitDown: null,
      },
    });
    sources.push({
      symbol: `cx${row.pair}`,
      hash: row.hash,
      adjustmentReference: null,
    });
  }
  const benchmark = instruments.find((i) => i.symbol === "cxBTCUSDT")!.bars;
  dataset = {
    period: group.period as ValidationDataset["period"],
    instruments,
    benchmark: [...benchmark],
    dates: [
      ...new Set(
        benchmark
          .map((b) => b.date.slice(0, 10))
          .filter((d) => d >= "2020-01-02" && d <= "2026-11-13"),
      ),
    ],
    sources,
    benchmarkName: "Frozen BTC buy-and-hold",
  };
  base = frozen(
    "crypto",
    [dataset],
    researchCandidates(
      instruments.map((i) => i.symbol),
      "crypto",
    ).filter((c) => c.strategy.period === group.period),
  );
} else {
  const native =
    stage === "chan"
      ? (await readArtifact<ReturnType<typeof frozen>["native"]>(
          "native-input",
        ))!
      : [];
  ({ dataset, base } = await loadEquity(
    group.family,
    stage === "chan" ? native.map((n) => n.symbol) : undefined,
  ));
  base.native = native;
  if (stage === "chan")
    dataset.sources = dataset.sources.map((source) => ({
      ...source,
      hash: digest(
        JSON.stringify([
          source.hash,
          native.find((n) => n.symbol === source.symbol)!.capture,
        ]),
      ),
    }));
}
const replayInputHash = digest(
  JSON.stringify({
    build,
    sources: dataset.sources,
    symbols: dataset.instruments.map((i) => i.symbol),
    dates: dataset.dates,
    menu: base.candidateMenu,
    native: base.native.map((n) => n.capture.identity),
  }),
);
if (replayInputHash !== group.inputHash)
  throw new Error("Frozen candidate projection/input identity mismatch");
const declared = base.candidateMenu
  .flatMap((c) => [c, ...numericNeighbors(c)])
  .find((c) => c.strategy.id === id);
if (!declared) throw new Error("Candidate declaration absent");
const candidate = projectCandidate(declared, dataset, base, new Map());
if (!candidate) throw new Error("Required frozen candidate input unavailable");
const actual = runCandidateCheckpoint(candidate, dataset, {
  ...base.input.policy,
  trainBars: Math.max(20, Math.floor(dataset.dates.length * 0.4)),
  testBars: Math.max(5, Math.floor(dataset.dates.length * 0.1)),
});
const expected = group.checkpoints.find((c) => c.row.id === id)!;
const body = ({ elapsedMs: _elapsed, ...value }: typeof actual) =>
  JSON.stringify(value);
if (body(expected) !== body(actual))
  throw new Error("Frozen candidate numeric replay mismatch");
console.log(
  JSON.stringify({
    verified: true,
    build,
    replayCodeHash: digest(await readFile(new URL(import.meta.url))),
    id,
    symbols: dataset.instruments.length,
    period: dataset.period,
    beforeHash: digest(body(expected)),
    afterHash: digest(body(actual)),
    elapsedMs: actual.elapsedMs,
    scope:
      "All training windows, independent OOS base/cost/delay, holdout, neighborhood input and full-period score; zero qualification/notification/order writes",
  }),
);
process.exit(0);
