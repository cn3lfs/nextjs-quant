import { createHash } from "node:crypto";
import Big from "big.js";
import { z } from "zod";
import { classifySecurityCode } from "trading-strategy-core/security";
import { chinaDate } from "~/lib/market/security-trading-status";
import type {
  AccountPosition,
  AccountTrade,
} from "~/lib/portfolio/account-workspace";
import type { MockResponseEvidence } from "../mock/mock-trading";

const number = z
  .union([z.number(), z.string().regex(/^-?\d+(?:\.\d+)?$/)])
  .pipe(z.coerce.number().finite());
const code = z.string().regex(/^\d{6}$/);
const stock = z.object({
  zqdm: code,
  gpsl: number,
  gpcb: number,
  djsl: number.optional(),
});
const stocks = z.union([
  z.object({ data: z.array(stock) }),
  z.object({ result: z.array(stock.extend({ djsl: number })) }),
]);
const identifier = z
  .union([z.string(), z.number()])
  .transform(String)
  .pipe(z.string().regex(/^[a-z\d][\w-]{0,31}$/i));
const fill = z.object({
  zqdm: code,
  mmlb: z.enum(["B", "S", "买入", "卖出"]),
  cjsj: z.string(),
  cjg: number.optional(),
  cjjg: number.optional(),
  cje: number.optional(),
  cjje: number.optional(),
  cjsl: number.optional(),
  fee: number.optional(),
  entrust_no: identifier.nullish().catch(null),
  entrustNo: identifier.nullish().catch(null),
  trade_no: identifier.nullish().catch(null),
  tradeNo: identifier.nullish().catch(null),
  cjbh: identifier.nullish().catch(null),
});
const fills = z.union([
  z.object({ ret: z.object({ item: z.array(fill) }) }),
  z.object({ result: z.array(fill) }),
]);
type Receipt = {
  id: string;
  tradeDate: string;
  entrustNos: string[];
  state: string;
};
const channel = {
  kind: "ths-mock",
  account: "default",
  accountName: "同花顺模拟盘",
  market: "cn-equity",
  currency: "CNY",
  sleeve: "未知",
  strategyId: null,
  strategyVersion: null,
} as const;

/** The adapter retains redacted response bodies. Only expose typed economic fields. */
export function readMockCache(
  diagnostics: readonly MockResponseEvidence[],
  receipts: Receipt[],
  at: number,
) {
  let positions: AccountPosition[] = [];
  const days = new Map<string, AccountTrade[]>();
  let lastRefreshedAt: number | null = null;
  for (const { path, rawBody, envelope } of [...diagnostics].sort(
    (a, b) => a.envelope.fetchedAt - b.envelope.fetchedAt,
  )) {
    if (
      !rawBody ||
      envelope.quality !== "validated" ||
      envelope.fetchedAt > at ||
      !["/pt_web_qry_stock", "/pt_qry_busin_nocache"].includes(path) ||
      createHash("sha256").update(JSON.stringify(rawBody)).digest("hex") !==
        envelope.payloadHash
    )
      continue;
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      continue;
    }
    const cache = { cacheSource: path, refreshedAt: envelope.fetchedAt };
    if (path === "/pt_web_qry_stock") {
      const parsed = stocks.safeParse(body);
      if (!parsed.success) continue;
      const rows =
        "data" in parsed.data ? parsed.data.data : parsed.data.result;
      positions = rows.flatMap((row) => {
        const market = classifySecurityCode(row.zqdm).market;
        const quantity = row.gpsl + ("result" in parsed.data ? row.djsl! : 0);
        if (!market || !Number.isSafeInteger(quantity) || quantity <= 0)
          return [];
        const symbol = market + row.zqdm;
        return [
          {
            ...channel,
            ...cache,
            symbol,
            id: "ths-mock:default:" + symbol,
            quantity,
            cost: row.gpcb,
            price: null,
            value: null,
            stop: null,
            at: new Date(cache.refreshedAt).toISOString(),
            industry: "未知",
            reasons: ["来自同花顺本地持仓快照，数量与成本截至最后刷新时间"],
          },
        ];
      });
    } else {
      const parsed = fills.safeParse(body);
      if (!parsed.success) continue;
      const rows =
        "result" in parsed.data ? parsed.data.result : parsed.data.ret.item;
      const date = chinaDate(cache.refreshedAt);
      const trades = new Map<string, AccountTrade>();
      const conflicts = new Set<string>();
      rows.forEach((row, index) => {
        const market = classifySecurityCode(row.zqdm).market;
        const price = row.cjg ?? row.cjjg,
          gross = row.cje ?? row.cjje;
        if (!market || price === undefined || price <= 0) return;
        const quantity =
          row.cjsl ??
          (gross === undefined ? null : new Big(gross).div(price).toNumber());
        if (!quantity || !Number.isSafeInteger(quantity) || quantity < 0)
          return;
        const symbol = market + row.zqdm,
          side = row.mmlb === "B" || row.mmlb === "买入" ? "buy" : "sell";
        const fillId = row.trade_no ?? row.tradeNo ?? row.cjbh ?? undefined;
        const entrust = row.entrust_no ?? row.entrustNo;
        const matched = entrust
          ? receipts.filter(
              (r) =>
                r.state === "accepted" &&
                r.tradeDate === date &&
                r.entrustNos.includes(entrust),
            )
          : [];
        const orderId = matched.length === 1 ? matched[0]!.id : undefined;
        const venueFillKey =
          orderId && fillId
            ? JSON.stringify([
                "ths_mock:default",
                symbol,
                date,
                orderId,
                fillId,
              ])
            : undefined;
        const id =
          "ths-mock:" +
          JSON.stringify([
            date,
            symbol,
            entrust,
            fillId ?? [envelope.payloadHash, index],
          ]);
        const clock = /^(\d\d):?(\d\d):?(\d\d)$/.exec(row.cjsj);
        const instant = clock
          ? Date.parse(`${date}T${clock[1]}:${clock[2]}:${clock[3]}+08:00`)
          : NaN;
        const trade: AccountTrade = {
          ...channel,
          ...cache,
          id,
          symbol,
          side,
          price,
          quantity,
          date,
          time: Number.isFinite(instant)
            ? instant
            : Date.parse(date + "T00:00:00+08:00"),
          timePrecision: Number.isFinite(instant) ? "instant" : "day",
          fees: row.fee ?? null,
          planId: null,
          alertKey: null,
          fillId,
          orderId,
          venueFillKey,
        };
        const previous = trades.get(id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(trade))
          conflicts.add(id);
        trades.set(id, trade);
      });
      days.set(
        date,
        [...trades.values()].filter((t) => !conflicts.has(t.id)),
      );
    }
    lastRefreshedAt = cache.refreshedAt;
  }
  return {
    source: "mock-diagnostics" as const,
    lastRefreshedAt,
    positions,
    trades: [...days.values()].flat(),
  };
}
