import { join } from "node:path";
import {
  GBBQ_KEY_BASE64,
  GBBQ_RECORD_SIZE,
  parseGbbqFile,
  readStableLocalFile,
  resolveTdxRoot,
} from "tstdx/local";
import { z } from "zod";
import { completedBarFilter } from "trading-strategy-core/completed-bars";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import { etfRotationUniverseFor } from "trading-strategies";
import { equityDailyReturns } from "~/lib/backtest/multiple-testing";
import { studioParameterGridResultSchema } from "~/lib/research/studio-result";
import { readWindowSnapshot } from "../../market/market-panel/window";
import {
  runEtfRotationBacktest,
  type EtfRotationMarketData,
  type EtfRotationDailySource,
} from "../etf-rotation";
import { usageConfigHash } from "../research-config-hash";
import { computeParameterGrid, maxParameterGridCells } from "./parameter-grid";

export type { StudioParameterGridResult } from "./parameter-grid";

const dayMs = 86_400_000;
const unique = (values: number[]) => new Set(values).size === values.length;
export const studioParameterGridInputSchema = z
  .object({
    start: researchDateSchema.default("2020-01-01"),
    holdoutStart: researchDateSchema.default("2023-01-01"),
    trainBars: z.number().int().min(20).max(504).default(126),
    testBars: z.number().int().min(20).max(252).default(63),
    momentumWindows: z
      .array(z.number().int().min(2).max(252))
      .min(1)
      .max(36)
      .refine(unique, "动量窗口重复")
      .default([20, 40, 60]),
    topKs: z
      .array(z.number().int().min(1).max(3))
      .min(1)
      .max(3)
      .refine(unique, "持有只数重复")
      .default([1, 2, 3]),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.start >= v.holdoutStart ||
      Date.parse(v.holdoutStart) - Date.parse(v.start) > 4 * 366 * dayMs
    )
      ctx.addIssue({
        code: "custom",
        path: ["holdoutStart"],
        message: "开发区间须为正且不超过四年",
      });
    if (Math.max(...v.momentumWindows) > v.trainBars)
      ctx.addIssue({
        code: "custom",
        path: ["trainBars"],
        message: "训练窗不足以预热最长动量回看窗口",
      });
    if (v.momentumWindows.length * v.topKs.length > maxParameterGridCells)
      ctx.addIssue({
        code: "custom",
        path: ["momentumWindows"],
        message: "网格最多 36 个组合",
      });
  });
export type StudioParameterGridInput = z.input<
  typeof studioParameterGridInputSchema
>;

const baseConfig = {
  strategyId: "etf-dual-momentum",
  pool: "legacy-long-history",
  cadence: "month-end",
  defense: "treasury",
} as const;
const symbols = ["sh510300", "sh510500", "sz159915", "sh511010"] as const;
const universe = etfRotationUniverseFor(baseConfig).filter((etf) =>
  symbols.some((s) => s === etf.symbol),
);
const initial = 1_000_000;

const gbbqKey = Buffer.from(GBBQ_KEY_BASE64, "base64");
function rejectedEventDate(body: Buffer, offset: number): string | undefined {
  if (offset + GBBQ_RECORD_SIZE > body.length) return undefined;
  // The parser omits dates on rejected rows. Decode only GBBQ's second
  // Blowfish block, whose first word is YYYYMMDD, independently of the payload.
  const box = (base: number, index: number) =>
    gbbqKey.readUInt32LE(base + index * 4);
  let left = (gbbqKey.readUInt32LE(0x44) ^ body.readUInt32LE(offset + 8)) >>> 0;
  let right = body.readUInt32LE(offset + 12);
  for (let round = 64; round >= 4; round -= 4) {
    const mixed =
      (box(0x48, left >>> 24) + box(0x448, (left >>> 16) & 0xff)) >>> 0;
    const roundValue =
      (mixed ^ box(0x848, (left >>> 8) & 0xff)) + box(0xc48, left & 0xff);
    const next = (right ^ roundValue ^ gbbqKey.readUInt32LE(round)) >>> 0;
    right = left;
    left = next;
  }
  const packed = ((right ^ gbbqKey.readUInt32LE(0)) >>> 0).toString();
  if (packed.length !== 8 || packed < "19900101" || packed > "21001231")
    return undefined;
  const date = `${packed.slice(0, 4)}-${packed.slice(4, 6)}-${packed.slice(6)}`;
  return researchDateSchema.safeParse(date).data;
}

/** All price reads use inclusive development bounds. Hash only the dated
 * research inputs: changing a later observation cannot change a grid score. */
async function readDevelopmentSeries(
  root: string,
  start: string,
  end: string,
  signal?: AbortSignal,
) {
  const { body } = await readStableLocalFile(
    join(resolveTdxRoot(root), "T0002/hq_cache/gbbq"),
  );
  const gbbq = parseGbbqFile(body);
  if (
    gbbq.issues.some(({ symbol, offset }) => {
      if (symbol && !symbols.some((s) => s === symbol)) return false;
      const date = rejectedEventDate(body, offset);
      // Records with no trustworthy date cannot be placed outside development.
      return date === undefined || date <= end;
    })
  )
    throw new Error("ETF 网格公司行动来源存在无法归属或池内未解释记录");
  const series: Record<string, EtfRotationDailySource> = {};
  for (const symbol of symbols) {
    signal?.throwIfAborted();
    const { bars } = await readWindowSnapshot(root, symbol, "day", {
      from: start,
      to: end,
      chartFunds: true,
    });
    series[symbol] = {
      bars,
      events: (gbbq.events.get(symbol) ?? []).filter(
        (e) => e.date >= start && e.date <= end,
      ),
    };
  }
  return series;
}

function freezeFold(
  series: Record<string, EtfRotationDailySource>,
  calendar: readonly string[],
  start: string,
  end: string,
): EtfRotationMarketData {
  const dates = calendar.filter((date) => date >= start && date <= end);
  const foldSeries: Record<string, EtfRotationDailySource> = {};
  for (const symbol of symbols) {
    const source = series[symbol]!;
    const bars = source.bars.filter((b) => b.date >= start && b.date <= end);
    if (
      bars.length !== dates.length ||
      dates.some((date, i) => bars[i]!.date !== date || !(bars[i]!.volume > 0))
    )
      throw new Error(
        `ETF 回看或测试窗日行情缺失：${symbol} ${start} 至 ${end}`,
      );
    foldSeries[symbol] = {
      bars,
      events: source.events.filter(
        (event) => event.date >= start && event.date <= end,
      ),
    };
  }
  return {
    calendar: dates,
    calendarBasis: "上证指数开发段已收盘交易日",
    series: foldSeries,
    actionsSource:
      "GBBQ:" +
      usageConfigHash(
        symbols.map((symbol) => [symbol, foldSeries[symbol]!.events]),
      ),
  };
}

export const studioEtfGridResultSchema = studioParameterGridResultSchema.extend(
  {
    replay: z.object({
      strategyId: z.literal(baseConfig.strategyId),
      symbols: z.array(z.string()),
      cadence: z.literal(baseConfig.cadence),
      defense: z.literal(baseConfig.defense),
      initialPerWindow: z.number().positive(),
      trainBars: z.number().int().positive(),
      testBars: z.number().int().positive(),
      sourceHash: z.string().nullable(),
    }),
  },
);
export type StudioEtfGridResult = z.output<typeof studioEtfGridResultSchema>;

/** RPC options belong to the trusted server caller. The strict wire schema
 * accepts parameter coordinates and date bounds only. */
export async function runStudioParameterGrid(
  rawInput: StudioParameterGridInput,
  options: { tdxRoot?: string; signal?: AbortSignal } = {},
): Promise<StudioEtfGridResult> {
  const input = studioParameterGridInputSchema.parse(rawInput);
  const { signal, tdxRoot = "E:/new_tdx64" } = options;
  signal?.throwIfAborted();
  const grid = {
    xAxis: { key: "momentumWindow", values: input.momentumWindows },
    yAxis: { key: "topK", values: input.topKs },
    holdoutStart: input.holdoutStart,
    trainBars: input.trainBars,
    testBars: input.testBars,
  };
  const replay: StudioEtfGridResult["replay"] = {
    strategyId: baseConfig.strategyId,
    symbols: [...symbols],
    cadence: baseConfig.cadence,
    defense: baseConfig.defense,
    initialPerWindow: initial,
    trainBars: input.trainBars,
    testBars: input.testBars,
    sourceHash: null,
  };
  const end = new Date(Date.parse(input.holdoutStart) - dayMs)
    .toISOString()
    .slice(0, 10);
  const now = Date.now();
  let dates: string[] = [];
  let series: Record<string, EtfRotationDailySource> = {};
  try {
    const calendar = await readWindowSnapshot(tdxRoot, "sh000001", "day", {
      from: input.start,
      to: end,
    });
    const completed = completedBarFilter("day", now);
    dates = calendar.bars.map((bar) => bar.date).filter(completed);
    if (dates.length >= input.trainBars + input.testBars) {
      // Skip the incomplete tail even when opening the underlying ETF windows.
      const fullDays =
        input.trainBars +
        Math.floor((dates.length - input.trainBars) / input.testBars) *
          input.testBars;
      series = await readDevelopmentSeries(
        tdxRoot,
        dates[0]!,
        dates[fullDays - 1]!,
        signal,
      );
      replay.sourceHash = usageConfigHash([dates.slice(0, fullDays), series]);
    }
  } catch (error) {
    signal?.throwIfAborted();
    const reason =
      error instanceof Error ? error.message : "开发段行情读取失败";
    const result = await computeParameterGrid(
      { ...grid, dates },
      () => {
        throw new Error(reason);
      },
      signal,
    );
    return {
      ...result,
      reason,
      cells: result.cells.map((cell) => ({ ...cell, reason })),
      replay,
    };
  }

  const markets = new Map<string, EtfRotationMarketData>();
  const result = await computeParameterGrid(
    { ...grid, dates },
    async ({ x, y, window }) => {
      let market = markets.get(window.start);
      if (!market) {
        market = freezeFold(series, dates, window.trainStart, window.end);
        markets.set(window.start, market);
      }
      const { backtest } = await runEtfRotationBacktest(
        {
          config: { ...baseConfig, momentumWindow: x, topK: y },
          initial,
          universe,
          start: window.start,
          end: window.end,
          now,
          source: { kind: "frozen", data: market },
        },
        signal,
      );
      const equity = backtest.equity.map((p) => ({
        date: p.date,
        value: p.equity,
      }));
      return {
        dates: equity.map((p) => p.date),
        trades: backtest.fills.filter(
          (fill) => fill.side === "sell" && fill.holdingAfter === 0,
        ).length,
        returns: equityDailyReturns(equity, initial),
      };
    },
    signal,
  );
  return { ...result, replay };
}
