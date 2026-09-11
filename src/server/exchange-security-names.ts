import { z } from "zod";
import snapshot from "./data/exchange-delisted.json";

const date = z
  .string()
  .transform((s) => s.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"))
  .refine(
    (s) =>
      /^\d{4}-\d{2}-\d{2}$/.test(s) &&
      Number.isFinite(Date.parse(s)) &&
      new Date(s).toISOString().slice(0, 10) === s,
  );
export const exchangeNamesSchema = z.object({
  version: z.literal(1),
  fetchedAt: z.string().datetime(),
  sources: z.object({ sse: z.string().url(), szse: z.string().url() }),
  entries: z
    .array(
      z.object({
        symbol: z.string().regex(/^(sh(60|68)|sz(00|30))\d{4}$/),
        name: z.string().trim().min(1).max(80),
        listingDate: date,
        delistingDate: date,
        source: z.enum(["sse", "szse"]),
      }),
    )
    .refine(
      (rows) => new Set(rows.map((r) => r.symbol)).size === rows.length,
      "交易所名录代码重复",
    ),
});
const verified = exchangeNamesSchema.parse(snapshot);
export type HistoricalIdentity = {
  name: string;
  status: "delisted" | "code-changed";
  date: string;
  successor?: string;
  source: string;
  fetchedAt: string;
};
export const exchangeNames = new Map<string, HistoricalIdentity>(
  verified.entries.map((row) => [
    row.symbol,
    {
      name: row.name,
      status: "delisted",
      date: row.delistingDate,
      source: verified.sources[row.source],
      fetchedAt: verified.fetchedAt,
    },
  ]),
);
// Code changes are not delistings. Keep both original data files and identifiers.
exchangeNames.set("sh600849", {
  name: "上海医药",
  status: "code-changed",
  date: "2010-03-05",
  successor: "sh601607",
  source:
    "https://static.sse.com.cn/cs/zhs/scfw/gg/ssgs/2011-03-09/601607_2010_n.pdf",
  fetchedAt: verified.fetchedAt,
});
exchangeNames.set("sz300114", {
  name: "中航电测",
  status: "code-changed",
  date: "2025-02-17",
  successor: "sz302132",
  source: "https://static.cninfo.com.cn/finalpage/2025-02-15/1222544408.PDF",
  fetchedAt: verified.fetchedAt,
});

// Public notices verified on 2026-09-11. Names belong to the original code;
// neither successor prices nor current membership are inferred from the mapping.
for (const [symbol, identity] of [
  [
    "sz000022",
    {
      name: "深赤湾A",
      status: "code-changed",
      date: "2018-12-26",
      successor: "sz001872",
      source:
        "https://static.cninfo.com.cn/finalpage/2018-12-26/1205690369.PDF",
    },
  ],
  [
    "sz000043",
    {
      name: "中航善达",
      status: "code-changed",
      date: "2019-12-16",
      successor: "sz001914",
      source:
        "https://www.szse.cn/disclosure/notice/general/t20191211_572534.html",
    },
  ],
  [
    "bj920305",
    {
      name: "云创退",
      status: "delisted",
      date: "2026-07-30",
      source: "https://www.foundersc.com/fzhtml/fxjs/5/A/F/37MDBF7.html",
    },
  ],
  [
    "bj920680",
    {
      name: "广道退",
      status: "delisted",
      date: "2026-01-05",
      source:
        "https://www.foundersc.com/fzhtml/infoBusinessDyn/1/C/1/5B2DI96.html",
    },
  ],
] satisfies [string, Omit<HistoricalIdentity, "fetchedAt">][]) {
  exchangeNames.set(symbol, {
    ...identity,
    fetchedAt: "2026-09-11T10:00:00.000Z",
  });
}
