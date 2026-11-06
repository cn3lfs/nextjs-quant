import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import {
  readFileSync,
  openSync,
  closeSync,
  writeSync,
  readSync,
  fsyncSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tdxImportTargets } from "./lib/tdx-import-paths";
import {
  estimateChartVolume,
  estimateCalibratedVolume,
  visualEstimateFromPlan,
  lc5TimeKey,
} from "./lib/tdx-estimated-volume";

const { values } = parseArgs({
  options: {
    "tdx-root": { type: "string" },
    "remaining-report": { type: "string" },
    "calculation-plan": { type: "string" },
    "visual-plan": { type: "string" },
    out: { type: "string" },
  },
});
const calibrated = Boolean(values["calculation-plan"]);
const visual = Boolean(values["visual-plan"]);
if (
  !values["tdx-root"] ||
  !values.out ||
  [
    values["remaining-report"],
    values["calculation-plan"],
    values["visual-plan"],
  ].filter(Boolean).length !== 1
)
  throw new Error(
    "--tdx-root --out and exactly one of --remaining-report / --calculation-plan / --visual-plan are required",
  );
const { root, targets } = await tdxImportTargets(values["tdx-root"]);
const source = resolve(
    (values["visual-plan"] ??
      values["calculation-plan"] ??
      values["remaining-report"])!,
  ),
  out = resolve(values.out);
const lines = readFileSync(source, "utf8")
  .replace(/^\uFEFF/, "")
  .trim()
  .split(/\r?\n/);
const header = lines.shift()?.split(",") ?? [];
const columns = visual
  ? [
      "symbol",
      "time",
      "status",
      "estimate",
      "oldHex",
      "method",
      "kind",
      "samples",
      "windowDays",
      "ratio",
    ]
  : calibrated
    ? [
        "symbol",
        "time",
        "kind",
        "status",
        "estimate",
        "factor",
        "previousSamples",
        "followingSamples",
        "agreement",
        "snapshotAmount",
        "snapshotPrice",
      ]
    : ["symbol", "time", "category", "amount", "low", "high"];
if (columns.some((c) => !header.includes(c)))
  throw new Error("Invalid remaining report header");
type Candidate = { time: string; amount: number } & (
  | {
      mode: "visual";
      oldHex: string;
      estimate: number;
      method: string;
      kind: string;
      samples: number;
      windowDays: number;
      ratio: number;
    }
  | { mode: "hlc3"; low: number; high: number }
  | {
      mode: "calibrated";
      kind: string;
      factor: number;
      estimate: number;
      price: number;
    }
);
const groups = new Map<string, Candidate[]>();
const summary = {
  method: visual
    ? "chart-estimate-visual-relaxed-v1"
    : calibrated
      ? "chart-estimate-local-units-v1"
      : "chart-estimate-hlc3-v1",
  approximate: true,
  root,
  source,
  input: 0,
  excludedCategory: 0,
  eligible: 0,
  repaired: 0,
  alreadyNonzero: 0,
  missing: 0,
  changedSnapshot: 0,
  unestimable: 0,
  filesVerified: 0,
  errors: 0,
  seconds: 0,
};
for (const line of lines) {
  if (!line.trim()) continue;
  const cells = line.split(",");
  if (cells.length !== header.length)
    throw new Error("Invalid remaining report row");
  const field = (name: string) => cells[header.indexOf(name)]!;
  const symbol = field("symbol").toLowerCase(),
    time = field("time");
  summary.input++;
  if (
    visual
      ? field("status") !== "candidate-visual-estimate"
      : calibrated
        ? field("status") !== "candidate-chart-estimate"
        : field("category") !== "security-estimate"
  ) {
    summary.excludedCategory++;
    continue;
  }
  if (
    !(visual ? /^(sh|sz)[a-z0-9]{1,10}$/ : /^(sh|sz)\d{6}$/).test(symbol) ||
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00$/.test(time)
  )
    throw new Error("Invalid symbol or time");
  const oldHex = visual ? field("oldHex") : "";
  if (visual && !/^[a-f0-9]{64}$/.test(oldHex))
    throw new Error("Invalid visual snapshot");
  const row: Candidate = visual
    ? {
        mode: "visual",
        time,
        amount: Buffer.from(oldHex, "hex").readFloatLE(20),
        oldHex,
        estimate: Number(field("estimate")),
        method: field("method"),
        kind: field("kind"),
        samples: Number(field("samples")),
        windowDays: Number(field("windowDays")),
        ratio: Number(field("ratio")),
      }
    : calibrated
      ? {
          mode: "calibrated",
          time,
          amount: Number(field("snapshotAmount")),
          kind: field("kind"),
          factor: Number(field("factor")),
          estimate: Number(field("estimate")),
          price: Number(field("snapshotPrice")),
        }
      : {
          mode: "hlc3",
          time,
          amount: Number(field("amount")),
          low: Number(field("low")),
          high: Number(field("high")),
        };
  if (
    row.mode === "visual" &&
    (visualEstimateFromPlan(
      symbol,
      Buffer.from(row.oldHex, "hex"),
      row.oldHex,
      row.estimate,
      row.method,
      row.samples,
    ) === null ||
      !Number.isFinite(row.ratio) ||
      !Number.isInteger(row.windowDays) ||
      row.windowDays < 0 ||
      row.windowDays > 365)
  )
    throw new Error("Invalid visual estimate evidence");
  if (
    row.mode === "calibrated" &&
    (![row.factor, row.estimate, row.price].every(Number.isFinite) ||
      !Number.isInteger(row.estimate) ||
      row.estimate < 1 ||
      row.estimate > 0xffffffff ||
      Number(field("previousSamples")) < 20 ||
      Number(field("followingSamples")) < 20 ||
      !["previousSamples", "followingSamples", "agreement"].every(
        (k) => field(k) !== "" && Number.isFinite(Number(field(k))),
      ) ||
      Number(field("agreement")) < 0.95 ||
      Number(field("agreement")) > 1)
  )
    throw new Error("Invalid calibration evidence");
  if (
    !(
      row.mode === "hlc3" ? [row.amount, row.low, row.high] : [row.amount]
    ).every(Number.isFinite)
  )
    throw new Error("Invalid snapshot values");
  const group = groups.get(symbol) ?? [];
  group.push(row);
  groups.set(symbol, group);
  summary.eligible++;
}
mkdirSync(out, { recursive: true });
// An external journal identifies every estimate: LC5 has no provenance field.
const journal = openSync(join(out, "estimates.jsonl"), "wx");
const started = performance.now(),
  maxYear = new Date().getFullYear() + 1;
try {
  for (const [symbol, rows] of groups) {
    const path = join(targets[symbol.slice(0, 2)]!, symbol + ".lc5");
    const data = readFileSync(path);
    if (data.length % 32) throw new Error(`Invalid LC5 length: ${path}`);
    const patches: {
      offset: number;
      volume: number;
      time: string;
      oldHex: string;
      evidence: Candidate;
    }[] = [];
    const seen = new Set<number>();
    for (const row of rows) {
      const key =
        Number(row.time.slice(0, 10).replaceAll("-", "")) * 1440 +
        Number(row.time.slice(11, 13)) * 60 +
        Number(row.time.slice(14, 16));
      let lo = 0,
        hi = data.length / 32;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (lc5TimeKey(data, mid * 32, maxYear) < key) lo = mid + 1;
        else hi = mid;
      }
      const offset = lo * 32;
      if (offset === data.length || lc5TimeKey(data, offset, maxYear) !== key) {
        summary.missing++;
        continue;
      }
      if (seen.has(offset))
        throw new Error(`Duplicate snapshot record: ${symbol} ${row.time}`);
      seen.add(offset);
      const bar = data.subarray(offset, offset + 32);
      if (bar.readUInt32LE(24)) {
        summary.alreadyNonzero++;
        continue;
      }
      if (
        bar.readFloatLE(20) !== row.amount ||
        (row.mode === "visual"
          ? bar.toString("hex") !== row.oldHex
          : row.mode === "hlc3"
            ? bar.readFloatLE(12) !== row.low || bar.readFloatLE(8) !== row.high
            : (bar.readFloatLE(8) + bar.readFloatLE(12) + bar.readFloatLE(16)) /
                3 !==
              row.price)
      ) {
        summary.changedSnapshot++;
        continue;
      }
      const volume =
        row.mode === "visual"
          ? visualEstimateFromPlan(
              symbol,
              bar,
              row.oldHex,
              row.estimate,
              row.method,
              row.samples,
            )
          : row.mode === "calibrated"
            ? estimateCalibratedVolume(symbol, bar, row.kind, row.factor)
            : estimateChartVolume(symbol, bar);
      if (row.mode === "calibrated" && volume !== row.estimate) {
        summary.changedSnapshot++;
        continue;
      }
      if (volume === null) {
        summary.unestimable++;
        continue;
      }
      patches.push({
        offset,
        volume,
        time: row.time,
        oldHex: bar.toString("hex"),
        evidence: row,
      });
    }
    if (!patches.length) continue;
    writeSync(
      journal,
      JSON.stringify({
        state: "planned",
        symbol,
        method: summary.method,
        patches,
      }) + "\n",
    );
    fsyncSync(journal);
    const file = openSync(path, "r+");
    try {
      const current = Buffer.alloc(32),
        volume = Buffer.alloc(4);
      for (const patch of patches) {
        if (
          readSync(file, current, 0, 32, patch.offset) !== 32 ||
          !current.equals(data.subarray(patch.offset, patch.offset + 32))
        )
          throw new Error(
            `File changed during estimate: ${symbol} ${patch.time}`,
          );
        volume.writeUInt32LE(patch.volume);
        if (writeSync(file, volume, 0, 4, patch.offset + 24) !== 4)
          throw new Error("Incomplete volume write");
        data.writeUInt32LE(patch.volume, patch.offset + 24);
        summary.repaired++;
      }
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    if (!readFileSync(path).equals(data))
      throw new Error(`Readback differs: ${symbol}`);
    summary.filesVerified++;
    writeSync(
      journal,
      JSON.stringify({ state: "verified", symbol, repaired: patches.length }) +
        "\n",
    );
    if (summary.filesVerified % 100 === 0)
      console.log(
        `${summary.filesVerified} files, ${summary.repaired} estimates`,
      );
  }
} catch (error) {
  summary.errors++;
  writeSync(
    journal,
    JSON.stringify({ state: "error", error: String(error) }) + "\n",
  );
  process.exitCode = 1;
} finally {
  fsyncSync(journal);
  closeSync(journal);
  summary.seconds = (performance.now() - started) / 1000;
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
}
console.log(JSON.stringify(summary));
