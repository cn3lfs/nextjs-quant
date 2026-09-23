import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Bar } from "../../src/lib/domain";
import { boll, ema, kdj, ma, macd, rsi } from "../../src/lib/indicators";
import { readLocalDailySnapshot } from "../../src/server/market/local-daily-snapshot";
import {
  adjustmentFactors,
  applyAdjustment,
  readGbbq,
} from "../../src/server/data-sources/tdx/tdx-gbbq";

/**
 * Local half of the SuperMind indicator cross-check.
 *
 * The comparison asks one bounded question: for the same security and trading
 * day, do the two sides produce the same MA / EMA / MACD / RSI / KDJ / BOLL
 * values? It never re-runs a backtest and never mutates `src/`.
 *
 * Two experiments are emitted:
 *
 *  1. `local` — real TDX daily history for each symbol, raw and
 *     backward-adjusted through `adjustmentFactors`/`applyAdjustment`, with
 *     indicator values read out at the shared target dates. The remote side
 *     recomputes from `get_price` bars and the two tables are diffed.
 *  2. `formulaFixture` — a frozen bar window per symbol plus the values
 *     `src/lib/indicators.ts` produces for it. Uploading this makes the remote
 *     run the *same inputs through its own implementation*, which separates a
 *     formula-convention difference from a raw-data difference.
 *
 * Parameters are the ones the research strategies actually use, not
 * re-invented here: `src/lib/research/technical/research-technical.ts:352-356` calls
 * `ma(bars, 5|10|20|60)`, `macd(bars)`, `kdj(bars)`, `rsi(bars)`, `boll(bars)`,
 * and `src/lib/indicators.ts` fixes those defaults at MACD (12, 26, 9),
 * KDJ (9, 3, 3), RSI (6, 12, 24) and BOLL (20, 2, sample STD).
 *
 *   pnpm tsx scripts/supermind/indicator-crosscheck.ts --out <dir> \
 *       [--tdx-root E:/new_tdx64] [--fixture-bars 160]
 */

const SYMBOLS = ["sh600000", "sh600004", "sh600009", "sh600036"] as const;
/** Trading days are resolved per symbol: anchor -> first bar at or after it. */
const ERA_ANCHORS = [
  "2005-06-06",
  "2005-06-07",
  "2010-07-05",
  "2015-06-15",
  "2020-03-23",
] as const;
const INDICATOR_PARAMS = {
  ma: [5, 10, 20, 60],
  ema: [12, 26],
  macd: [12, 26, 9],
  rsi: [6, 12, 24],
  kdj: [9, 3, 3],
  boll: [20, 2],
};

function parseArgs(argv: string[]) {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (!key.startsWith("--")) throw new Error(`无法识别的参数：${key}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${key} 缺少取值`);
    options.set(key.slice(2), value);
    index += 1;
  }
  return options;
}

/** Every indicator the comparison covers, computed from one bar array. */
function indicatorValues(bars: readonly Bar[]) {
  const averages = INDICATOR_PARAMS.ma.map((period) => ma(bars, period));
  const momentum = macd(
    bars,
    ...(INDICATOR_PARAMS.macd as [number, number, number]),
  );
  const stochastic = kdj(
    bars,
    ...(INDICATOR_PARAMS.kdj as [number, number, number]),
  );
  const strength = rsi(bars, INDICATOR_PARAMS.rsi as [number, number, number]);
  const bands = boll(
    bars,
    INDICATOR_PARAMS.boll[0]!,
    INDICATOR_PARAMS.boll[1]!,
  );
  return {
    ma5: averages[0]!,
    ma10: averages[1]!,
    ma20: averages[2]!,
    ma60: averages[3]!,
    ema12: ema(bars, INDICATOR_PARAMS.ema[0]!),
    ema26: ema(bars, INDICATOR_PARAMS.ema[1]!),
    dif: momentum.map((row) => row.dif),
    dea: momentum.map((row) => row.dea),
    macdHist: momentum.map((row) => row.macd),
    k: stochastic.map((row) => row.k),
    d: stochastic.map((row) => row.d),
    j: stochastic.map((row) => row.j),
    rsi6: strength.map((row) => row.rsi6),
    rsi12: strength.map((row) => row.rsi12),
    rsi24: strength.map((row) => row.rsi24),
    bollMid: bands.map((row) => row.mid),
    bollUpper: bands.map((row) => row.upper),
    bollLower: bands.map((row) => row.lower),
  };
}
type IndicatorSeries = ReturnType<typeof indicatorValues>;
const SERIES_KEYS = Object.keys(
  indicatorValues([]),
) as (keyof IndicatorSeries)[];

/** Round-trip through JSON so the fixture carries exactly what is compared. */
const clean = (value: unknown) => JSON.parse(JSON.stringify(value));

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outDir = resolve(options.get("out") ?? ".codex-runs");
  const tdxRoot = options.get("tdx-root") ?? "E:/new_tdx64";
  const fixtureBars = Number(options.get("fixture-bars") ?? 160);
  // SuperMind's daily history for these securities starts at 2005-01-04 while
  // TDX carries the full listing history, so a recursive indicator is seeded
  // ~5 years apart. Slicing the local series to the same start isolates that
  // seeding difference from any formula difference.
  const remoteStart = options.get("remote-start") ?? "2005-01-04";
  mkdirSync(outDir, { recursive: true });

  // Optional {"<tdx symbol>": [{date, open, high, low, close, prevClose, volume}]}
  // captured from the remote `is_paused` rows. Absent -> the closure test is
  // skipped and only the direct comparison is emitted.
  const calendarPath = options.get("calendar");
  type PausedRow = {
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
  };
  const calendarBySymbol: Record<string, PausedRow[]> = {};
  if (calendarPath) {
    const raw: Record<string, { paused: PausedRow[] }> = JSON.parse(
      readFileSync(resolve(calendarPath), "utf8"),
    );
    for (const [remoteSymbol, entry] of Object.entries(raw))
      calendarBySymbol[`sh${remoteSymbol.split(".")[0]}`] = entry.paused;
  }

  const gbbq = await readGbbq(tdxRoot);
  const local: Record<string, unknown> = {};
  const formulaFixture: Record<string, unknown> = {};

  for (const symbol of SYMBOLS) {
    const snapshot = await readLocalDailySnapshot(tdxRoot, symbol);
    const raw = snapshot.bars;
    // `parseGbbq` keys by the lowercase `sh600000` form, the same shape the
    // TDX snapshot uses, so no case folding is needed here.
    const actions = gbbq.events.get(symbol) ?? [];
    const factors = adjustmentFactors(raw, actions);
    const backward = applyAdjustment(raw, factors, "backward");
    const exDivDates = actions
      .filter((event) => event.category === 1)
      .map((event) => event.date.slice(0, 10));

    const dates = ERA_ANCHORS.map(
      (anchor) => raw.find((bar) => bar.date.slice(0, 10) >= anchor)?.date,
    ).filter((date): date is string => !!date);
    // One ex-dividend day plus its successor, so the table covers the point
    // where a raw series and an adjusted series must diverge.
    const exDiv =
      exDivDates.find((date) => date >= "2015-01-01") ?? exDivDates.at(-1);
    if (exDiv) {
      const index = raw.findIndex((bar) => bar.date.slice(0, 10) >= exDiv);
      if (index >= 0) {
        dates.push(raw[index]!.date);
        if (raw[index + 1]) dates.push(raw[index + 1]!.date);
      }
    }
    const unique = [...new Set(dates)].sort();

    const rawValues = indicatorValues(raw);
    const adjustedValues = indicatorValues(backward);
    // Same indicators, but with the history truncated to the remote's own
    // start so the two sides share a seed.
    const sliceStart = raw.findIndex(
      (bar) => bar.date.slice(0, 10) >= remoteStart,
    );
    const slicedRaw = sliceStart >= 0 ? raw.slice(sliceStart) : raw;
    const slicedBackward =
      sliceStart >= 0 ? backward.slice(sliceStart) : backward;
    const slicedRawValues = indicatorValues(slicedRaw);
    const slicedAdjustedValues = indicatorValues(slicedBackward);
    const slicedIndex = new Map(
      slicedRaw.map((bar, index) => [bar.date, index]),
    );
    // Closure test: rebuild the remote's calendar by inserting the suspension
    // rows TDX omits, then re-run the identical indicators. If the two sides
    // then agree to the last bit, the whole divergence is the calendar.
    const paused = calendarBySymbol[symbol] ?? [];
    const mergedRaw: Bar[] = [];
    const pausedQueue = [...paused].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
    for (const bar of raw) {
      while (pausedQueue.length && pausedQueue[0]!.date < bar.date)
        mergedRaw.push({ ...pausedQueue.shift()!, amount: 0 } as Bar);
      mergedRaw.push(bar);
    }
    while (pausedQueue.length)
      mergedRaw.push({ ...pausedQueue.shift()!, amount: 0 } as Bar);
    const mergedFactors = adjustmentFactors(mergedRaw, actions);
    const mergedBackward = applyAdjustment(
      mergedRaw,
      mergedFactors,
      "backward",
    );
    const mergedRawValues = indicatorValues(mergedRaw);
    const mergedAdjustedValues = indicatorValues(mergedBackward);
    const mergedIndex = new Map(
      mergedRaw.map((bar, index) => [bar.date, index]),
    );
    // Merged *and* sliced to the remote's start: after this the two bar
    // arrays are the same sequence, so any residual is formula, not history.
    const mergedSliceAt = mergedRaw.findIndex(
      (bar) => bar.date.slice(0, 10) >= remoteStart,
    );
    const mergedSliced =
      mergedSliceAt > 0 ? mergedRaw.slice(mergedSliceAt) : mergedRaw;
    const mergedSlicedBackward =
      mergedSliceAt > 0 ? mergedBackward.slice(mergedSliceAt) : mergedBackward;
    const mergedSlicedValues = indicatorValues(mergedSliced);
    const mergedSlicedAdjustedValues = indicatorValues(mergedSlicedBackward);
    const mergedSlicedIndex = new Map(
      mergedSliced.map((bar, index) => [bar.date, index]),
    );
    const indexOf = new Map(raw.map((bar, index) => [bar.date, index]));
    const pick = (values: IndicatorSeries, index: number) =>
      Object.fromEntries(
        SERIES_KEYS.map((key) => [key, values[key][index] ?? null]),
      );
    const rows = Object.fromEntries(
      unique.map((date) => {
        const index = indexOf.get(date)!;
        const bar = raw[index]!,
          adjusted = backward[index]!;
        const sliced = slicedIndex.get(date);
        return [
          date,
          {
            index,
            slicedIndex: sliced ?? null,
            rawBar: [bar.open, bar.high, bar.low, bar.close, bar.volume],
            adjustedBar: [
              adjusted.open,
              adjusted.high,
              adjusted.low,
              adjusted.close,
              adjusted.volume,
            ],
            factor: factors[index]!.factor,
            raw: pick(rawValues, index),
            backward: pick(adjustedValues, index),
            rawFromRemoteStart:
              sliced === undefined ? null : pick(slicedRawValues, sliced),
            backwardFromRemoteStart:
              sliced === undefined ? null : pick(slicedAdjustedValues, sliced),
            rawMerged:
              mergedIndex.get(date) === undefined
                ? null
                : pick(mergedRawValues, mergedIndex.get(date)!),
            backwardMerged:
              mergedIndex.get(date) === undefined
                ? null
                : pick(mergedAdjustedValues, mergedIndex.get(date)!),
            rawMergedSliced:
              mergedSlicedIndex.get(date) === undefined
                ? null
                : pick(mergedSlicedValues, mergedSlicedIndex.get(date)!),
            backwardMergedSliced:
              mergedSlicedIndex.get(date) === undefined
                ? null
                : pick(
                    mergedSlicedAdjustedValues,
                    mergedSlicedIndex.get(date)!,
                  ),
          },
        ];
      }),
    );

    local[symbol] = {
      name: snapshot.name,
      bars: raw.length,
      first: raw[0]!.date,
      last: raw.at(-1)!.date,
      remoteStart: slicedRaw[0]?.date ?? null,
      exDivDates,
      dates: unique,
      rows,
    };

    // Fixture window: the last `fixtureBars` raw bars of the shared history.
    const start = Math.max(0, raw.length - fixtureBars);
    const window = raw.slice(start);
    const windowValues = indicatorValues(window);
    formulaFixture[symbol] = {
      start,
      dates: window.map((bar) => bar.date),
      open: window.map((bar) => bar.open),
      high: window.map((bar) => bar.high),
      low: window.map((bar) => bar.low),
      close: window.map((bar) => bar.close),
      volume: window.map((bar) => bar.volume),
      local: Object.fromEntries(
        SERIES_KEYS.map((key) => [key, windowValues[key]]),
      ),
    };
    console.log(
      `${symbol} bars=${raw.length} exDiv=${exDivDates.length} dates=${unique.length} fixture=${window.length}`,
    );
  }

  const report = clean({
    generatedAt: new Date().toISOString(),
    tdxRoot: resolve(tdxRoot),
    symbols: [...SYMBOLS],
    eraAnchors: [...ERA_ANCHORS],
    indicatorParams: INDICATOR_PARAMS,
    parameterSource:
      "src/lib/research/technical/research-technical.ts:352-356 + src/lib/indicators.ts defaults",
    barFieldOrder: ["open", "high", "low", "close", "volume"],
    local,
    formulaFixture,
  });
  const target = join(outDir, "indicator-crosscheck-local.json");
  writeFileSync(target, JSON.stringify(report, null, 2));
  const fixtureTarget = join(outDir, "indicator-crosscheck-input.json");
  writeFileSync(fixtureTarget, JSON.stringify(report.formulaFixture));
  console.log(`wrote ${target}`);
  console.log(`wrote ${fixtureTarget}`);
}

/**
 * Diffs the local table against the remote one. `layer` names which pair of
 * series is being compared, because a recursive indicator can differ either
 * from a different formula or from a different history origin:
 *
 *   raw-tdx-full        TDX full history          vs remote fq=None
 *   raw-tdx-sliced      TDX sliced to remote start vs remote fq=None
 *   backward-full       TDX backward-adjusted     vs remote fq='post'
 *   backward-sliced     TDX backward, sliced      vs remote fq='post'
 */
type Compared = {
  symbol: string;
  date: string;
  layer: string;
  field: string;
  local: number | null;
  remote: number | null;
  absDiff: number | null;
  relDiff: number | null;
};

function compare() {
  const options = parseArgs(process.argv.slice(3));
  const localPath = options.get("local");
  const remotePath = options.get("remote");
  if (!localPath || !remotePath)
    throw new Error("compare 需要 --local 与 --remote");
  const outDir = resolve(options.get("out") ?? ".codex-runs");
  mkdirSync(outDir, { recursive: true });

  const local = JSON.parse(readFileSync(resolve(localPath), "utf8")) as any;
  const remote = JSON.parse(readFileSync(resolve(remotePath), "utf8")) as any;
  const rows: Compared[] = [];
  const barRows: Compared[] = [];
  const ratioNote: Record<string, number> = {};

  const push = (
    bucket: Compared[],
    symbol: string,
    date: string,
    layer: string,
    field: string,
    left: number | null,
    right: number | null,
  ) => {
    const both = left !== null && right !== null;
    const absDiff = both ? Math.abs(left - right) : null;
    const relDiff = both
      ? absDiff! / Math.max(Math.abs(right!) || 0, 1e-12)
      : null;
    bucket.push({
      symbol,
      date,
      layer,
      field,
      local: left,
      remote: right,
      absDiff,
      relDiff,
    });
  };

  for (const [symbol, entry] of Object.entries(local.local as any)) {
    const remoteSymbol = symbol.replace(/^sh/, "") + ".SH";
    const remoteEntry = remote.exp1[remoteSymbol];
    if (!remoteEntry) throw new Error(`远端缺少 ${remoteSymbol}`);
    // 后复权 absolute level depends on each side's own normalisation base, so
    // record the observed ratio once per symbol before diffing levels.
    const firstShared = Object.keys((entry as any).rows).find(
      (date) =>
        (entry as any).rows[date].adjustedBar && remoteEntry.dates[date],
    );
    if (firstShared) {
      const left = (entry as any).rows[firstShared].adjustedBar[3];
      const right = remoteEntry.dates[firstShared].adjustedBar[3];
      ratioNote[symbol] = right / left;
    }
    for (const date of (entry as any).dates) {
      const localRow = (entry as any).rows[date];
      const remoteRow = remoteEntry.dates[date];
      if (!remoteRow) continue;
      const barFields = ["open", "high", "low", "close", "volume"];
      barFields.forEach((field, index) => {
        if (!remoteRow.bar) return;
        push(
          barRows,
          symbol,
          date,
          "raw-bar",
          field,
          localRow.rawBar[index],
          remoteRow.bar[index],
        );
      });
      const layers: [
        string,
        Record<string, number | null> | null,
        Record<string, number | null>,
      ][] = [
        ["raw-tdx-full", localRow.raw, remoteRow.values],
        ["raw-tdx-sliced", localRow.rawFromRemoteStart, remoteRow.values],
        ["backward-full", localRow.backward, remoteRow.adjustedValues],
        [
          "backward-sliced",
          localRow.backwardFromRemoteStart,
          remoteRow.adjustedValues,
        ],
        ["raw-merged", localRow.rawMerged, remoteRow.values],
        ["backward-merged", localRow.backwardMerged, remoteRow.adjustedValues],
        ["raw-merged-sliced", localRow.rawMergedSliced, remoteRow.values],
        [
          "backward-merged-sliced",
          localRow.backwardMergedSliced,
          remoteRow.adjustedValues,
        ],
      ];
      for (const [layer, left, right] of layers) {
        if (!left) continue;
        for (const field of SERIES_KEYS as string[]) {
          push(
            rows,
            symbol,
            date,
            layer,
            field,
            left[field] ?? null,
            right[field] ?? null,
          );
        }
      }
    }
  }

  const summarise = (list: Compared[]) => {
    const groups = new Map<string, Compared[]>();
    for (const row of list) {
      const key = `${row.layer}|${row.field}`;
      const bucket = groups.get(key);
      if (bucket) bucket.push(row);
      else groups.set(key, [row]);
    }
    return [...groups.entries()]
      .map(([key, bucket]) => {
        const divider = key.indexOf("|");
        const layer = key.slice(0, divider);
        const field = key.slice(divider + 1);
        const diffs = bucket
          .map((row) => row.absDiff)
          .filter((x): x is number => x !== null);
        const rels = bucket
          .map((row) => row.relDiff)
          .filter((x): x is number => x !== null);
        return {
          layer,
          field,
          compared: diffs.length,
          missing: bucket.length - diffs.length,
          exact: diffs.filter((x) => x === 0).length,
          maxAbsDiff: diffs.length ? Math.max(...diffs) : null,
          maxRelDiff: rels.length ? Math.max(...rels) : null,
          firstDiffering: bucket.find(
            (row) => row.absDiff !== null && row.absDiff > 0,
          ),
        };
      })
      .sort((a, b) =>
        `${a.layer}|${a.field}`.localeCompare(`${b.layer}|${b.field}`),
      );
  };

  const summary = summarise(rows);
  const outline = {
    rows,
    barRows,
    barSummary: summarise(barRows),
    ratioNote,
    summary,
  };
  const target = join(outDir, "indicator-crosscheck-compare.json");
  writeFileSync(target, JSON.stringify(outline, null, 2));
  console.log(`wrote ${target}`);
  console.log(`rows=${rows.length} barRows=${barRows.length}`);
  for (const item of outline.summary)
    console.log(
      `${item.layer.padEnd(16)} ${item.field.padEnd(11)} n=${item.compared} exact=${item.exact} maxAbs=${item.maxAbsDiff} maxRel=${item.maxRelDiff}`,
    );
  console.log("--- bars ---");
  for (const item of outline.barSummary)
    console.log(
      `${item.layer.padEnd(16)} ${item.field.padEnd(11)} n=${item.compared} exact=${item.exact} maxAbs=${item.maxAbsDiff} maxRel=${item.maxRelDiff}`,
    );
  console.log("ratio (remote post / local backward, first shared date):");
  for (const [symbol, value] of Object.entries(ratioNote))
    console.log(`  ${symbol} ${value}`);
}

if (process.argv[2] === "compare") compare();
else await main();
