import {
  task,
  prior,
  artifact,
  delivery,
  type EquityManifest,
  digest,
} from "./lib/research-r2a4";
import { readTdxLocalBlocks } from "tstdx/local";
import { readBars } from "../src/server/market/bar-store/read-bars";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const block = await readTdxLocalBlocks("E:/new_tdx64");
const pool = block.blocks.find((b) => b.name === "中证800");
if (!pool || pool.members.length !== 800)
  throw new Error("Existing TDX CSI800 pool must have 800 members");
const manifest = await prior<EquityManifest>("equity-input");
const symbols = pool.members
  .filter((s) => manifest.eligible.includes(s))
  .sort();
delete process.env.QUANT_RESEARCH_BAR_STORE_DIR;
const index = await readBars({
  root: "E:/new_tdx64",
  instrument: { market: "cn-equity", symbol: "sh000906" },
  period: "day",
  adjustment: "none",
  to: "2026-11-13",
});
const plan = await prior<{ order: string[]; orderHash: string }>("native-plan");
const intersect = plan.order.filter((s) => pool.members.includes(s));
// This is the dispatch's pre-outcome supplemental rule, declared in delivery at intake.
const native = [...intersect];
if (native.length < 30)
  for (const s of symbols)
    if (!native.includes(s) && native.length < 30) native.push(s);
const source = join("E:/new_tdx64/T0002/hq_cache", "infoharbor_block.dat");
const csi = {
  source,
  sourceSha256: digest(await readFile(source)),
  observedAt: new Date().toISOString(),
  officialSnapshotDate: null,
  sourceHeaderDate: pool.sourceDate,
  sourceDateMeaning:
    "TDX header is not certified as constituent snapshot effective date",
  constituents: pool.members,
  rosterSha256: digest(JSON.stringify([...pool.members].sort())),
  count: 800,
  executableCount: symbols.length,
  symbols,
  excluded: pool.members
    .filter((s) => !symbols.includes(s))
    .map((symbol) => ({
      symbol,
      reason:
        manifest.audit.find((a) => a.symbol === symbol)?.reason ??
        "Outside R2a2 cash-action eligible pool; unsupported/unverified non-cash action",
    })),
  benchmark: {
    name: "CSI800 000906 raw price index, no dividends",
    hash: index.hash,
    bars: index.bars,
  },
  native: {
    fixed420OrderHash: plan.orderHash,
    intersection: intersect,
    mainOrder: native,
    supplementRule:
      "If intersection below30, add executable constituents by symbol order up to30 before outcomes",
    supplemented: native.filter((s) => !intersect.includes(s)),
  },
  biasTags: [
    {
      code: "current-constituents-lookahead",
      severity: "high",
      detail:
        "Current constituents selected after R2a3 outcomes by user instruction; 2025-06 onward holdout is the least affected reference; earlier windows more biased",
    },
  ],
};
await artifact("csi800-input", csi);
await writeFile(
  join(task, "csi800.json"),
  JSON.stringify(
    {
      ...csi,
      benchmark: {
        ...csi.benchmark,
        bars: csi.benchmark.bars.length,
        start: csi.benchmark.bars[0]?.date,
        end: csi.benchmark.bars.at(-1)?.date,
      },
    },
    null,
    2,
  ),
);
await delivery({
  csi800: {
    ...csi,
    benchmark: {
      ...csi.benchmark,
      bars: csi.benchmark.bars.length,
      start: csi.benchmark.bars[0]?.date,
      end: csi.benchmark.bars.at(-1)?.date,
    },
  },
  nextStart:
    "Finish engine audit; native parity3 then fixed-order capture; CSI800 pool frozen before its outcomes",
});
console.log(
  JSON.stringify({
    count: 800,
    executable: symbols.length,
    nativeIntersection: intersect.length,
    supplemented: csi.native.supplemented.length,
    benchmarkBars: index.bars.length,
  }),
);
process.exit(0);
