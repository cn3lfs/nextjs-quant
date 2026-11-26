"use client";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "~/trpc/react";
import { Segmented } from "../../panels";
import { Input } from "../../ui/input";
import { BulkTradeLinks } from "../account-review-panels";
import { TradeSources } from "./trade-sources";

type TradeKind = "real" | "paper" | "exchange-simulation" | "local-sim" | "all";
const tradeKinds: readonly TradeKind[] = [
  "real",
  "paper",
  "exchange-simulation",
  "local-sim",
  "all",
];
function initialTradeKind(search: URLSearchParams): TradeKind {
  const kind = tradeKinds.find((value) => value === search.get("kind"));
  if (kind) return kind;
  const trade = search.get("trade");
  if (trade?.startsWith("local-sim:")) return "local-sim";
  if (trade?.startsWith("paper:")) return "paper";
  return "real";
}

export function AccountTrades() {
  const search = useSearchParams();
  return <AccountTradeList key={search.toString()} search={search} />;
}

function AccountTradeList({ search }: { search: URLSearchParams }) {
  const [page, setPage] = useState(0),
    [symbol, setSymbol] = useState(search.get("symbol") ?? ""),
    [kind, setKind] = useState(() => initialTradeKind(search));
  const [tradeId, setTradeId] = useState(search.get("trade") ?? undefined);
  const query = api.accountTrades.useQuery({
    page,
    symbol,
    kind,
    tradeId,
  });
  return (
    <section className="space-y-4">
      <h2>全部成交与来源</h2>
      <BulkTradeLinks batchId={search.get("batch") ?? undefined} />
      <p>包含已清仓交易；建议不自动确认，纸面成交归属固定。</p>
      <Segmented
        label="成交账户类型"
        value={kind}
        options={[
          { value: "real", label: "真实" },
          { value: "paper", label: "纸面" },
          { value: "exchange-simulation", label: "模拟交易所" },
          { value: "local-sim", label: "本地模拟" },
          { value: "all", label: "全部" },
        ]}
        onChange={(v) => {
          setKind(v);
          setTradeId(undefined);
          setPage(0);
        }}
      />
      <Input
        aria-label="成交品种筛选"
        value={symbol}
        onChange={(e) => {
          setSymbol(e.target.value);
          setTradeId(undefined);
          setPage(0);
        }}
        placeholder="证券代码或币对"
        className="max-w-56"
      />
      {query.error && <p role="alert">{query.error.message}</p>}
      {query.isLoading && <p role="status">正在读取成交…</p>}
      <TradeSources
        tradeId={tradeId ?? ""}
        trades={query.data?.trades ?? []}
        suggestions={query.data?.suggestions ?? []}
        total={query.data?.tradeCount ?? 0}
        page={page}
        setPage={setPage}
        fetching={query.isFetching}
        readError={!!query.error}
      />
    </section>
  );
}
