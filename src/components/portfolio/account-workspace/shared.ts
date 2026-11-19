import type { RouterOutputs, api } from "~/trpc/react";
import { formatPercent } from "trading-strategy-core/format-number";

export const pct = (n: number | null) =>
  formatPercent(n === null ? null : n * 100);

export const sourceLabels = {
  all: "全部来源",
  delivery: "券商交割单",
  local: "手工账本",
} as const;

export type Position = RouterOutputs["accountPositions"]["items"][number];
export type AccountTrade = RouterOutputs["accountTrades"]["trades"][number];
export type TradeSnapshot = Pick<AccountTrade, "symbol" | "date" | "side">;
export type TradeLinkInput = Parameters<
  ReturnType<typeof api.linkAccountTrade.useMutation>["mutate"]
>[0];
