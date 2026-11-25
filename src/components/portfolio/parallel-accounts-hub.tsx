"use client";

import Big from "big.js";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { futuresContract } from "~/lib/market/futures";
import {
  futuresSimActionLabels,
  type FuturesSimAccountSummary,
  type FuturesSimCurrency,
} from "~/lib/portfolio/futures-sim";
import { api } from "~/trpc/react";
import {
  futuresOpeningCapital,
  FuturesSimAccountCreateButton,
} from "../market/chart-sim-order-dialog";
import { Panel, PanelEmpty, Segmented, TablePanel } from "../panels";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { SimAccountsPanel } from "./sim-accounts-panel";
import { formatSimDecimal } from "./sim-order-form";
import { ThsLiveAccountPanel } from "./ths-live-account-panel";
import { ThsMockAccountPanel } from "./ths-mock-account-panel";

const channels = [
  { value: "local", label: "本地模拟账户", Panel: SimAccountsPanel },
  { value: "ths-mock", label: "同花顺模拟账户", Panel: ThsMockAccountPanel },
  { value: "ths-live", label: "同花顺实盘账户", Panel: ThsLiveAccountPanel },
  {
    value: "futures-sim",
    label: "期货模拟账户",
    Panel: FuturesSimAccountsPanel,
  },
] as const;

export function ParallelAccountsHub() {
  const search = useSearchParams();
  const channel = search.get("channel");
  const active = channels.find(({ value }) => channel === value) ?? channels[0];

  return (
    <Tabs
      value={active.value}
      activationMode="manual"
      onValueChange={(value) => {
        const next = new URL(window.location.href);
        if (value === "local") next.searchParams.delete("channel");
        else next.searchParams.set("channel", value);
        window.history.pushState(null, "", next);
      }}
    >
      <TabsList aria-label="交易账户通道" className="flex-wrap justify-start">
        {channels.map(({ value, label }) => (
          <TabsTrigger key={value} value={value}>
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
      {channels.map(({ value, Panel }) => (
        <TabsContent key={value} value={value} className="min-w-0">
          {value === active.value && <Panel />}
        </TabsContent>
      ))}
    </Tabs>
  );
}

const tradeTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  dateStyle: "short",
  timeStyle: "short",
});
const money = (value: string) => formatSimDecimal(value, 2);

function multiplierLabel(symbol: string, multiplier: number | undefined) {
  if (multiplier === undefined) return "—";
  const unit = futuresContract(symbol)?.unit.split("/")[1] ?? "报价单位";
  return `${formatSimDecimal(String(multiplier))} ${unit}/手`;
}

function FuturesSimAccountsPanel() {
  const search = useSearchParams();
  const queryAccountId = search.get("accountId") ?? "";
  const [accountId, setAccountId] = useState(queryAccountId);
  const [currency, setCurrency] = useState<FuturesSimCurrency>("CNY");
  const accounts = api.futuresSimAccountsList.useQuery();
  const effectiveAccountId = accountId || queryAccountId;
  const account =
    accounts.data?.find((row) => row.id === effectiveAccountId) ??
    accounts.data?.[0];

  return (
    <div className="space-y-4">
      <Panel title="期货模拟账户">
        <div className="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              label="新建账户币种"
              value={currency}
              onChange={setCurrency}
              options={[
                { value: "CNY", label: "CNY" },
                { value: "USD", label: "USD" },
              ]}
            />
            <FuturesSimAccountCreateButton
              currency={currency}
              label="创建期货模拟账户"
              onCreated={setAccountId}
            />
            <span className="text-sm text-nc-text-3 tabular-nums">
              初始资金 {formatSimDecimal(futuresOpeningCapital[currency])}{" "}
              {currency}
            </span>
          </div>
          {accounts.isPending && <PanelEmpty>正在读取期货模拟账户…</PanelEmpty>}
          {accounts.error && (
            <p role="alert" className="text-sm text-nc-bad">
              期货模拟账户读取失败：{accounts.error.message}
            </p>
          )}
          {accounts.isSuccess && !account && (
            <PanelEmpty>暂无期货模拟账户。</PanelEmpty>
          )}
          {account && (
            <>
              <label className="block max-w-sm">
                账户
                <Select value={account.id} onValueChange={setAccountId}>
                  <SelectTrigger className="w-full" aria-label="期货模拟账户">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.data?.map((row) => (
                      <SelectItem key={row.id} value={row.id}>
                        {row.name} · {row.currency}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <dl className="grid grid-cols-2 gap-3 text-sm tabular-nums md:grid-cols-4">
                {[
                  ["初始资金", account.initialCapital],
                  ["可用资金", account.cash],
                  ["冻结保证金", account.frozenMargin],
                  ["已实现盈亏", account.realizedPnl],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-nc-text-3">{label}</dt>
                    <dd>
                      {formatSimDecimal(value, 2)} {account.currency}
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </div>
      </Panel>
      {account && (
        <>
          <TablePanel
            title="当前期货持仓"
            meta={account.currency}
            rows={account.positions}
            rowKey={(row) => [row.symbol, row.side].join(":")}
            minWidth={760}
            empty="暂无未平仓头寸"
            columns={[
              {
                key: "symbol",
                header: "合约",
                width: "1.5fr",
                cell: (row) => <span title={row.symbol}>{row.name}</span>,
              },
              {
                key: "side",
                header: "方向",
                cell: (row) => (row.side === "long" ? "多仓" : "空仓"),
              },
              {
                key: "quantity",
                header: "可平手数",
                align: "right",
                cell: (row) => row.quantity,
              },
              {
                key: "price",
                header: "开仓均价",
                align: "right",
                cell: (row) => formatSimDecimal(row.avgEntryPrice),
              },
              {
                key: "multiplier",
                header: "合约乘数",
                align: "right",
                cell: (row) =>
                  multiplierLabel(row.symbol, row.contractMultiplier),
              },
              {
                key: "costBasis",
                header: "开仓名义价值",
                align: "right",
                cell: (row) => (
                  <span title={formatSimDecimal(row.costBasis)}>
                    {money(new Big(row.costBasis).toFixed(2))}
                  </span>
                ),
              },
              {
                key: "margin",
                header: "占用保证金",
                align: "right",
                cell: (row) => money(row.margin),
              },
            ]}
          />
          <FuturesSimTradesPanel key={account.id} account={account} />
        </>
      )}
    </div>
  );
}

function FuturesSimTradesPanel({
  account,
}: {
  account: FuturesSimAccountSummary;
}) {
  const [pageIndex, setPageIndex] = useState(0);
  const { trades, currency } = account;
  const pageSize = 20;
  const pageCount = Math.ceil(trades.length / pageSize);
  const page = Math.min(pageIndex, Math.max(0, pageCount - 1));

  return (
    <TablePanel
      title="期货成交记录"
      meta={`共 ${trades.length} 笔 · 北京时间 · ${currency}`}
      rows={trades.slice(page * pageSize, (page + 1) * pageSize)}
      rowKey={(row) => row.id}
      minWidth={840}
      empty="暂无期货模拟成交"
      columns={[
        {
          key: "time",
          header: "成交时间",
          width: "1.6fr",
          cell: (row) => tradeTime.format(row.executedAt),
        },
        {
          key: "symbol",
          header: "合约",
          width: "1.4fr",
          cell: (row) => <span title={row.symbol}>{row.name}</span>,
        },
        {
          key: "action",
          header: "开平方向",
          cell: (row) => futuresSimActionLabels[row.action],
        },
        {
          key: "quantity",
          header: "手数",
          align: "right",
          cell: (row) => row.quantity,
        },
        {
          key: "price",
          header: "成交价格",
          align: "right",
          cell: (row) => formatSimDecimal(row.price),
        },
        {
          key: "multiplier",
          header: "合约乘数",
          align: "right",
          cell: (row) => multiplierLabel(row.symbol, row.contractMultiplier),
        },
        {
          key: "fee",
          header: "手续费",
          align: "right",
          cell: (row) => money(row.fee),
        },
        {
          key: "pnl",
          header: "已实现盈亏",
          align: "right",
          cell: (row) => money(row.realizedPnl),
        },
      ]}
    >
      {pageCount > 1 && (
        <nav
          aria-label="期货成交分页"
          className="flex flex-wrap items-center justify-between gap-2 px-4 py-2"
        >
          <span aria-live="polite" className="text-sm text-muted-foreground">
            第 {page + 1} / {pageCount} 页
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPageIndex(page - 1)}
            >
              上一页
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page + 1 >= pageCount}
              onClick={() => setPageIndex(page + 1)}
            >
              下一页
            </Button>
          </div>
        </nav>
      )}
    </TablePanel>
  );
}
