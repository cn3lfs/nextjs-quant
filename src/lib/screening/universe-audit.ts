import { z } from "zod";
import { symbolSchema } from "../domain";
import { historicalDateSchema } from "./historical-screen";
import { poolSelectionSchema } from "../market/market-pool";

export const universeAuditLabels = {
  total: "池内标的",
  notListedAtStart: "起点尚未上市",
  listedDuring: "区间内上市",
  delistedDuring: "截至终点已退市（下界）",
  codeChanged: "区间内代码变更记录",
  noEvidence: "无上市/退市日期证据",
  localCoverageStartsAfter: "已知行情覆盖晚于起点",
} as const;
export type UniverseAuditMetric = keyof typeof universeAuditLabels;
export const universeBiasWarning =
  "本次结果的证券池含生存者偏差，幅度未知且不可由本地数据估计";
export const universeAuditSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("market"), pool: poolSelectionSchema.nullable() }),
  z.object({ kind: z.literal("research"), id: z.string().min(1) }),
  z.object({
    kind: z.literal("concept"),
    date: historicalDateSchema,
    hash: z.string().min(1),
  }),
]);
export type UniverseAuditSource = z.infer<typeof universeAuditSourceSchema>;
export const universeAuditQuerySchema = z
  .object({
    source: universeAuditSourceSchema,
    start: historicalDateSchema,
    end: historicalDateSchema,
    metric: z
      .enum(
        Object.keys(universeAuditLabels) as [
          UniverseAuditMetric,
          ...UniverseAuditMetric[],
        ],
      )
      .default("total"),
    page: z.number().int().min(0).max(10000).default(0),
  })
  .refine((q) => q.start <= q.end, "审计开始日期不能晚于结束日期");
export type UniverseAuditEvidence = {
  symbol: string;
  listingDate: string | null;
  delistingDate: string | null;
  lifecycleSource: string;
  localFirstDate: string | null;
  localSource: string;
  codeChanges: { date: string; source: string }[];
};
export type UniverseAuditRow = {
  symbol: string;
  date: string | null;
  source: string;
};
export type UniverseAuditInput = {
  symbols: string[];
  source: string;
  start: string;
  end: string;
  rosterAsOf: string | null;
  rosterAsOfReason: string | null;
  rosterIsCurrentSnapshot: boolean;
  evidence: UniverseAuditEvidence[];
};

/** V4: dates are evidence, never inferred from price history or file timestamps. */
export function auditUniverse(input: UniverseAuditInput) {
  const start = historicalDateSchema.parse(input.start),
    end = historicalDateSchema.parse(input.end);
  if (start > end) throw new Error("审计开始日期不能晚于结束日期");
  const symbols = [
    ...new Set(input.symbols.map((s) => symbolSchema.parse(s))),
  ].sort();
  const evidence = new Map(input.evidence.map((row) => [row.symbol, row]));
  if (evidence.size !== input.evidence.length)
    throw new Error("证券审计证据重复");
  const details: Record<UniverseAuditMetric, UniverseAuditRow[]> = {
    total: [],
    notListedAtStart: [],
    listedDuring: [],
    delistedDuring: [],
    codeChanged: [],
    noEvidence: [],
    localCoverageStartsAfter: [],
  };
  let localCoverageUnknown = 0;
  for (const symbol of symbols) {
    const row = evidence.get(symbol);
    const date = (value: string | null | undefined) =>
      value == null ? null : historicalDateSchema.parse(value);
    const listed = date(row?.listingDate),
      delisted = date(row?.delistingDate),
      first = date(row?.localFirstDate);
    const add = (
      key: UniverseAuditMetric,
      day: string | null,
      source: string,
    ) => details[key].push({ symbol, date: day, source });
    add("total", null, input.source);
    if (listed && listed > start)
      add("notListedAtStart", listed, row!.lifecycleSource);
    if (listed && listed >= start && listed <= end)
      add("listedDuring", listed, row!.lifecycleSource);
    // The task explicitly defines <= end, including delistings before start.
    if (delisted && delisted <= end)
      add("delistedDuring", delisted, row!.lifecycleSource);
    if (!listed && !delisted)
      add(
        "noEvidence",
        null,
        row?.lifecycleSource ?? "无既有上市/退市日期缓存",
      );
    if (first && first > start)
      add("localCoverageStartsAfter", first, row!.localSource);
    if (!first) localCoverageUnknown++;
    const changes = (row?.codeChanges ?? [])
      .filter((change) => date(change.date)! >= start && change.date <= end)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (changes.length)
      add(
        "codeChanged",
        changes[0]!.date,
        changes.map((c) => `${c.date} ${c.source}`).join("；"),
      );
  }
  return {
    ...(Object.fromEntries(
      Object.entries(details).map(([key, rows]) => [key, rows.length]),
    ) as Record<UniverseAuditMetric, number>),
    start,
    end,
    source: input.source,
    rosterAsOf: input.rosterAsOf,
    rosterAsOfReason:
      input.rosterAsOf === null
        ? input.rosterAsOfReason || "名单未记录快照时间"
        : null,
    localCoverageUnknown,
    unknowable: {
      vanishedFromSource:
        "本地通达信目录只含当前存在的证券，区间内退市后被移除的标的无法枚举" as const,
      delistedDuringIsLowerBound: true as const,
      rosterIsCurrentSnapshot: input.rosterIsCurrentSnapshot,
    },
    details,
  };
}
