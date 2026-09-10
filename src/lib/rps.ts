import { z } from "zod";
import { historicalDateSchema } from "./historical-screen";

export const rpsPeriods = [5, 10, 20, 50, 120, 250] as const;
export const isRpsMarketSymbol = (symbol: string) =>
  /^(sh(60|68)\d{4}|sz(00|30)\d{4})$/.test(symbol);
export const rpsPolicy = {
  version: "rps-1",
  adjustment: "backward",
  minimumListingYears: 1,
  suspensionSessions: 20,
  retentionDays: 750,
  maxSymbols: 10000,
  tie: "average-one-based",
  description:
    "后复权；仅沪深A股；首条本地日线满一年（保守上市年龄代理）；排除ST/*ST及名称未知；连续20个参考交易日无成交视为长期停牌；收益两端必须有成交，不补价；并列取1起始平均名次，RPS=(1-名次/有效总数)×100。",
  backfillWarning:
    "回填使用当前存活证券及当前名称，存在生存者偏差和历史ST状态偏差；不能视为当时可得证券池。",
} as const;
export const rpsRequestSchema = z.object({
  target: z.enum(["stock", "industry"]).optional(),
  mode: z.enum(["forward", "backfill"]),
  days: z.number().int().min(1).max(250).default(250),
});
export type RpsRequest = z.infer<typeof rpsRequestSchema>;
export const rpsQuerySchema = z.object({
  date: historicalDateSchema,
  period: z
    .number()
    .int()
    .refine((n) => (rpsPeriods as readonly number[]).includes(n)),
});
export type RpsValue = { return: number; rank: number; rps: number };
export type RpsRow = { symbol: string; values: (RpsValue | null)[] };
export const rpsExclusions = [
  "market",
  "nameUnknown",
  "st",
  "young",
  "suspended",
  "unsupportedAction",
  "missingEndpoint",
] as const;
export type RpsExclusion = (typeof rpsExclusions)[number];
export const rpsExclusionLabels: Record<RpsExclusion, string> = {
  market: "非沪深A股（含北交所）",
  nameUnknown: "名称未知",
  st: "ST/*ST",
  young: "本地历史未满一年",
  suspended: "连续20日无成交",
  unsupportedAction: "不支持的扩缩股/无效除权",
  missingEndpoint: "全部周期收益端点不足",
};
export type RpsDay = {
  industry?: import("./industry-rps").IndustryRpsAudit;
  date: string;
  mode: RpsRequest["mode"];
  periods: number[];
  policy: typeof rpsPolicy;
  total: number;
  pool: number;
  counts: number[];
  excluded: Record<RpsExclusion, string[]>;
  missing: number[];
  source: {
    root: string;
    calendar: string;
    calendarHash: string;
    actionsHash: string;
    actionsCoverage: string;
    universeHash: string;
  };
  inputHash: string;
  createdAt: number;
};
export type RpsProgress = {
  target?: "stock" | "industry";
  id: string;
  mode: RpsRequest["mode"];
  status: "running" | "complete" | "failed" | "cancelled";
  phase: string;
  scanned: number;
  total: number;
  completedDays: number;
  totalDays: number;
  startedAt: number;
  updatedAt: number;
  error?: string;
};

/** docs/rps-plan.md: ranks start at 1; ties share their occupied ranks' mean. */
export function rankRps(values: { symbol: string; return: number }[]) {
  const sorted = [...values].sort(
    (a, b) => b.return - a.return || a.symbol.localeCompare(b.symbol),
  );
  if (
    sorted.some((v) => !Number.isFinite(v.return)) ||
    new Set(sorted.map((v) => v.symbol)).size !== sorted.length
  )
    throw new Error("RPS收益无效或证券重复");
  const result = new Map<string, RpsValue>();
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end]!.return === sorted[start]!.return)
      end++;
    const rank = (start + 1 + end) / 2;
    for (let i = start; i < end; i++)
      result.set(sorted[i]!.symbol, {
        return: sorted[i]!.return,
        rank,
        rps: (1 - rank / sorted.length) * 100,
      });
    start = end;
  }
  return result;
}
