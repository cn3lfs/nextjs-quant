"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "~/trpc/react";
import { cn } from "~/lib/common/classnames";
import { cryptoDisplayName } from "~/lib/market/crypto";
import {
  formatSimAtoms,
  type SimAccountSummary,
  type SimCashFlowRow,
  type SimPosition,
  type SimTradeRow,
} from "~/lib/portfolio/sim-accounts";
import { Panel, Pill, Segmented } from "../panels";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../ui/dialog";
import { ChartSymbolLink } from "../market/chart-symbol-link";
import { useSecurityNames } from "../market/use-security-names";
import { useScreenVisible } from "../workbench/use-task-visible";
import { useAccumulatedPages, useTablePage } from "../ui/use-infinite-table";
import {
  SimOrderForm,
  formatSimDecimal,
  isPositiveSimDecimal,
} from "./sim-order-form";

type Market = SimAccountSummary["market"];
type DetailTab = "positions" | "cashFlows" | "trades";

const LEDGER_PAGE = 50;
const moneyDigits = (market: Market) => (market === "crypto" ? 8 : 2);
const quantityDigits = (market: Market) => (market === "crypto" ? 8 : 0);
const marketLabel = (market: Market) =>
  market === "crypto" ? "数字货币" : "A股";
const kindLabel: Record<SimCashFlowRow["kind"], string> = {
  opening: "开户资金",
  deposit: "充值",
  withdrawal: "出金",
  settlement: "成交结算",
};
const modeLabel: Record<SimTradeRow["executionMode"], string> = {
  manual: "手动成交",
  "plan-manual": "计划手动",
  "plan-auto": "计划自动",
};
const signOf = (value: string) => (value.startsWith("-") ? "bad" : "ok");

function atomsOf(value: string, digits: number) {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const atoms = BigInt(
    (whole || "0") + fraction.padEnd(digits, "0").slice(0, digits),
  );
  return negative ? -atoms : atoms;
}
function newRequestId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Exact per-account totals. The detail endpoint pages by cursor, so this walks
 * every page instead of presenting a truncated first page as a lifetime sum.
 */
function useAccountTotals(account: SimAccountSummary, enabled: boolean) {
  const utils = api.useUtils();
  return useQuery({
    queryKey: [
      "sim-account-totals",
      account.id,
      account.revision,
      account.market,
    ],
    enabled,
    staleTime: 15000,
    queryFn: async () => {
      const digits = moneyDigits(account.market);
      let costAtoms = 0n;
      let netAtoms = 0n;
      let positionCount = 0;
      let cursor: string | undefined;
      for (let page = 0; page < 200; page++) {
        const detail = await utils.simAccountDetail.fetch({
          accountId: account.id,
          limit: 200,
          cashFlowCursor: cursor,
        });
        if (page === 0) {
          positionCount = detail.positions.length;
          for (const row of detail.positions)
            costAtoms += atomsOf(row.costBasis, digits);
        }
        for (const flow of detail.cashFlows) {
          if (flow.kind === "deposit" || flow.kind === "withdrawal")
            netAtoms += atomsOf(flow.delta, digits);
        }
        if (!detail.nextCashFlowCursor) break;
        cursor = detail.nextCashFlowCursor;
      }
      return { costAtoms, netAtoms, positionCount };
    },
  });
}

function AccountCard({
  account,
  active,
  onSelect,
}: {
  account: SimAccountSummary;
  active: boolean;
  onSelect: () => void;
}) {
  const visible = useScreenVisible();
  const totals = useAccountTotals(account, visible);
  const digits = moneyDigits(account.market);
  const net = totals.data?.netAtoms ?? 0n;
  return (
    <Button
      type="button"
      variant="outline"
      aria-pressed={active}
      onClick={onSelect}
      className={cn(
        "h-auto w-full min-w-0 flex-col items-stretch gap-1.5 whitespace-normal p-3 text-left",
        active && "border-nc-accent! bg-nc-inset",
      )}
    >
      <span className="flex flex-wrap items-center justify-between gap-2">
        <strong className="break-all text-base font-semibold text-nc-text">
          {account.name}
        </strong>
        <Pill tone={active ? "accent" : "neutral"}>
          {marketLabel(account.market)} · {account.currency}
        </Pill>
      </span>
      <span className="flex justify-between gap-2 text-sm">
        <span className="text-nc-text-4">可用资金</span>
        <span className="tabular-nums">
          {formatSimDecimal(account.cash, digits)} {account.currency}
        </span>
      </span>
      <span className="flex justify-between gap-2 text-sm">
        <span className="text-nc-text-4">持仓成本 / 标的数</span>
        <span className="tabular-nums">
          {!totals.data
            ? "读取中…"
            : `${formatSimDecimal(formatSimAtoms(totals.data.costAtoms, digits), digits)} · ${totals.data.positionCount} 只`}
        </span>
      </span>
      <span className="flex justify-between gap-2 text-sm">
        <span className="text-nc-text-4">累计出入金</span>
        <span
          className={cn(
            "tabular-nums",
            signOf(formatSimAtoms(net, digits)) === "bad"
              ? "text-nc-bad"
              : net > 0n
                ? "text-nc-ok"
                : undefined,
          )}
        >
          {net > 0n ? "+" : ""}
          {formatSimDecimal(formatSimAtoms(net, digits), digits)}{" "}
          {account.currency}
        </span>
      </span>
    </Button>
  );
}

function AccountCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (account: SimAccountSummary) => void;
}) {
  const [name, setName] = useState("");
  const [market, setMarket] = useState<Market>("cn-equity");
  const [capital, setCapital] = useState("1000000");
  const utils = api.useUtils();
  const create = api.simAccountCreate.useMutation({
    onSuccess: (account) => {
      void utils.simAccountsList.invalidate();
      onCreated(account);
      setName("");
      setMarket("cn-equity");
      setCapital("1000000");
      onOpenChange(false);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>新建模拟账户</DialogTitle>
        <DialogDescription>
          仅创建本地模拟账簿；不连接真实券商，也不会触发真实下单。
        </DialogDescription>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate({
              name: name.trim(),
              market,
              initialCapital: capital.trim(),
            });
          }}
        >
          <label className="block">
            账户名称
            <Input
              aria-label="账户名称"
              value={name}
              maxLength={32}
              required
              placeholder="沪深短线模拟"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <Segmented
            label="账户市场"
            value={market}
            onChange={(value) => {
              setMarket(value);
              setCapital(value === "crypto" ? "100000" : "1000000");
              create.reset();
            }}
            options={[
              { value: "cn-equity", label: "A 股 (CNY)" },
              { value: "crypto", label: "数字货币 (USDT)" },
            ]}
          />
          <label className="block">
            初始本金（{market === "crypto" ? "USDT" : "CNY"}）
            <Input
              aria-label="初始本金"
              value={capital}
              inputMode="decimal"
              required
              onChange={(event) => setCapital(event.target.value)}
            />
          </label>
          {create.error && (
            <p role="alert" className="text-sm text-nc-bad">
              {create.error.message}
            </p>
          )}
          <div className="flex gap-2">
            <Button disabled={create.isPending}>
              {create.isPending ? "正在创建…" : "创建模拟账户"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={create.isPending}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CashFlowLedger({ account }: { account: SimAccountSummary }) {
  const visible = useScreenVisible();
  const resetKey = `${account.id}:cashFlows`;
  const page = useTablePage(resetKey);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  useEffect(() => setCursors([null]), [resetKey]);
  const cursor = cursors[page.pageIndex] ?? null;
  const query = api.simAccountDetail.useQuery(
    {
      accountId: account.id,
      limit: LEDGER_PAGE,
      cashFlowCursor: cursor ?? undefined,
    },
    { enabled: visible && (page.pageIndex === 0 || !!cursor) },
  );
  const result =
    query.isSuccess && !query.isPlaceholderData ? query.data : undefined;
  useEffect(() => {
    const next = result?.nextCashFlowCursor;
    if (!next) return;
    const index = page.pageIndex + 1;
    setCursors((prev) => {
      if (prev[index] === next) return prev;
      const copy = prev.slice(0, index);
      copy[index] = next;
      return copy;
    });
  }, [result?.nextCashFlowCursor, page.pageIndex]);
  const batches = useAccumulatedPages({
    resetKey,
    pageIndex: page.pageIndex,
    items: result?.cashFlows,
    total: result
      ? page.pageIndex * LEDGER_PAGE +
        result.cashFlows.length +
        (result.nextCashFlowCursor ? 1 : 0)
      : undefined,
    getKey: (row) => row.id,
    pageSize: LEDGER_PAGE,
    isSuccess: query.isSuccess && !query.isPlaceholderData,
  });
  const digits = moneyDigits(account.market);
  const columns: DataTableColumn<SimCashFlowRow>[] = [
    {
      id: "time",
      header: "时间",
      cell: ({ row }) => (
        <span className="tabular whitespace-nowrap">
          {new Date(row.original.occurredAt).toLocaleString("zh-CN")}
        </span>
      ),
    },
    {
      id: "kind",
      header: "类型",
      cell: ({ row }) => kindLabel[row.original.kind],
    },
    {
      id: "amount",
      header: () => <span className="block text-right">金额</span>,
      cell: ({ row }) => {
        const value = row.original.delta;
        return (
          <span
            className={cn(
              "block text-right tabular-nums",
              signOf(value) === "bad" ? "text-nc-bad" : "text-nc-ok",
            )}
          >
            {isPositiveSimDecimal(value) ? "+" : ""}
            {formatSimDecimal(value, digits)} {account.currency}
          </span>
        );
      },
    },
    {
      id: "note",
      header: "备注",
      cell: ({ row }) => (
        <span
          className="block max-w-[18rem] truncate"
          title={row.original.note}
        >
          {row.original.note || "—"}
        </span>
      ),
    },
  ];
  return (
    <DataTable
      label={`${account.name} 资金流水`}
      data={batches.rows}
      rowCount={batches.hasMore ? undefined : batches.rows.length}
      columns={columns}
      getRowId={(row) => row.id}
      pagination={{ pageIndex: page.pageIndex, pageSize: LEDGER_PAGE }}
      onPaginationChange={() => {}}
      sorting={[]}
      onSortingChange={() => {}}
      loading={batches.rows.length === 0 && query.isLoading}
      error={batches.rows.length === 0 ? query.error?.message : undefined}
      onRetry={() => void query.refetch()}
      infiniteScroll={{
        hasMore: batches.hasMore,
        loadingMore: page.pageIndex > 0 && query.isFetching,
        onLoadMore: page.loadMore,
      }}
      emptyMessage="尚无资金流水；充值或成交后会在此记录。"
    />
  );
}

function TradeLedger({
  account,
  securityNames,
}: {
  account: SimAccountSummary;
  securityNames?: Record<string, string>;
}) {
  const visible = useScreenVisible();
  const resetKey = `${account.id}:trades`;
  const page = useTablePage(resetKey);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  useEffect(() => setCursors([null]), [resetKey]);
  const cursor = cursors[page.pageIndex] ?? null;
  const query = api.simAccountDetail.useQuery(
    {
      accountId: account.id,
      limit: LEDGER_PAGE,
      tradeCursor: cursor ?? undefined,
    },
    { enabled: visible && (page.pageIndex === 0 || !!cursor) },
  );
  const result =
    query.isSuccess && !query.isPlaceholderData ? query.data : undefined;
  useEffect(() => {
    const next = result?.nextTradeCursor;
    if (!next) return;
    const index = page.pageIndex + 1;
    setCursors((prev) => {
      if (prev[index] === next) return prev;
      const copy = prev.slice(0, index);
      copy[index] = next;
      return copy;
    });
  }, [result?.nextTradeCursor, page.pageIndex]);
  const batches = useAccumulatedPages({
    resetKey,
    pageIndex: page.pageIndex,
    items: result?.trades,
    total: result
      ? page.pageIndex * LEDGER_PAGE +
        result.trades.length +
        (result.nextTradeCursor ? 1 : 0)
      : undefined,
    getKey: (row) => row.fillId,
    pageSize: LEDGER_PAGE,
    isSuccess: query.isSuccess && !query.isPlaceholderData,
  });
  const digits = moneyDigits(account.market);
  const columns: DataTableColumn<SimTradeRow>[] = [
    {
      id: "time",
      header: "时间",
      cell: ({ row }) => (
        <span className="tabular whitespace-nowrap">
          {new Date(row.original.executedAt).toLocaleString("zh-CN")}
        </span>
      ),
    },
    {
      id: "symbol",
      header: "标的",
      cell: ({ row }) => {
        const value = row.original.symbol;
        const name =
          securityNames?.[value] ??
          (account.market === "crypto" ? cryptoDisplayName(value) : undefined);
        return <ChartSymbolLink symbol={value} name={name} />;
      },
    },
    {
      id: "side",
      header: "方向",
      cell: ({ row }) => (
        <span
          className={row.original.side === "buy" ? "text-nc-bad" : "text-nc-ok"}
        >
          {row.original.side === "buy" ? "买入" : "卖出"}
        </span>
      ),
    },
    {
      id: "mode",
      header: "方式",
      cell: ({ row }) => modeLabel[row.original.executionMode],
    },
    {
      id: "quantity",
      header: () => <span className="block text-right">数量</span>,
      cell: ({ row }) => (
        <span className="block text-right tabular-nums">
          {formatSimDecimal(
            row.original.quantity,
            quantityDigits(account.market),
          )}
        </span>
      ),
    },
    {
      id: "price",
      header: () => <span className="block text-right">价格</span>,
      cell: ({ row }) => (
        <span className="block text-right tabular-nums">
          {formatSimDecimal(row.original.price, digits)}
        </span>
      ),
    },
    {
      id: "gross",
      header: () => <span className="block text-right">成交额</span>,
      cell: ({ row }) => (
        <span className="block text-right tabular-nums">
          {formatSimDecimal(row.original.gross, digits)}
        </span>
      ),
    },
    {
      id: "fees",
      header: "费用",
      cell: ({ row }) => (
        <span className="block whitespace-nowrap text-xs text-nc-text-3">
          佣金 {formatSimDecimal(row.original.commission, digits)} · 印花税{" "}
          {formatSimDecimal(row.original.tax, digits)} · 滑点{" "}
          {formatSimDecimal(row.original.slippage, digits)}
        </span>
      ),
    },
    {
      id: "net",
      header: () => <span className="block text-right">现金变动</span>,
      cell: ({ row }) => {
        const value = row.original.netCashDelta;
        return (
          <span
            className={cn(
              "block text-right tabular-nums",
              signOf(value) === "bad" ? "text-nc-bad" : "text-nc-ok",
            )}
          >
            {isPositiveSimDecimal(value) ? "+" : ""}
            {formatSimDecimal(value, digits)}
          </span>
        );
      },
    },
  ];
  return (
    <DataTable
      label={`${account.name} 交易明细`}
      data={batches.rows}
      rowCount={batches.hasMore ? undefined : batches.rows.length}
      columns={columns}
      getRowId={(row) => row.fillId}
      pagination={{ pageIndex: page.pageIndex, pageSize: LEDGER_PAGE }}
      onPaginationChange={() => {}}
      sorting={[]}
      onSortingChange={() => {}}
      loading={batches.rows.length === 0 && query.isLoading}
      error={batches.rows.length === 0 ? query.error?.message : undefined}
      onRetry={() => void query.refetch()}
      infiniteScroll={{
        hasMore: batches.hasMore,
        loadingMore: page.pageIndex > 0 && query.isFetching,
        onLoadMore: page.loadMore,
      }}
      emptyMessage="尚无成交；下单并确认后会在此记录。"
    />
  );
}

function PositionsTable({
  account,
  positions,
  loading,
  onSell,
}: {
  account: SimAccountSummary;
  positions: SimPosition[];
  loading: boolean;
  onSell: (position: SimPosition) => void;
}) {
  const { data: names } = useSecurityNames();
  const [pageIndex, setPageIndex] = useState(0);
  const digits = moneyDigits(account.market);
  const columns: DataTableColumn<SimPosition>[] = [
    {
      id: "symbol",
      header: "标的",
      cell: ({ row }) => {
        const value = row.original.symbol;
        const name =
          names?.[value] ??
          (account.market === "crypto" ? cryptoDisplayName(value) : undefined);
        return <ChartSymbolLink symbol={value} name={name} />;
      },
    },
    {
      id: "quantity",
      header: () => <span className="block text-right">总数量</span>,
      cell: ({ row }) => (
        <span className="block text-right tabular-nums">
          {row.original.quantity}
        </span>
      ),
    },
    {
      id: "sellable",
      header: () => <span className="block text-right">可卖 (T+1)</span>,
      cell: ({ row }) => (
        <span className="block text-right tabular-nums">
          {row.original.sellableQuantity}
        </span>
      ),
    },
    {
      id: "average",
      header: () => <span className="block text-right">移动加权成本</span>,
      cell: ({ row }) => (
        <span className="block text-right tabular-nums">
          {formatSimDecimal(
            row.original.averageCost,
            account.market === "crypto" ? 8 : 4,
          )}
        </span>
      ),
    },
    {
      id: "cost",
      header: () => <span className="block text-right">成本金额</span>,
      cell: ({ row }) => (
        <span className="block text-right tabular-nums">
          {formatSimDecimal(row.original.costBasis, digits)}
        </span>
      ),
    },
    {
      id: "sell",
      header: "操作",
      cell: ({ row }) => (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!isPositiveSimDecimal(row.original.sellableQuantity)}
          onClick={() => onSell(row.original)}
        >
          卖出
        </Button>
      ),
    },
  ];
  return (
    <DataTable
      label={`${account.name} 持仓`}
      data={positions}
      rowCount={positions.length}
      columns={columns}
      getRowId={(row) => row.symbol}
      pagination={{ pageIndex, pageSize: 20 }}
      onPaginationChange={(update) => {
        const next =
          typeof update === "function"
            ? update({ pageIndex, pageSize: 20 })
            : update;
        setPageIndex(next.pageIndex);
      }}
      sorting={[]}
      onSortingChange={() => {}}
      loading={loading}
      emptyMessage="暂无持仓；买入成交后会在此显示。"
    />
  );
}

function AccountWorkspace({
  account,
  onChanged,
  onDelete,
}: {
  account: SimAccountSummary;
  onChanged: () => void;
  onDelete: () => void;
}) {
  const visible = useScreenVisible();
  const [tab, setTab] = useState<DetailTab>("positions");
  const [order, setOrder] = useState<{
    side: "buy" | "sell";
    symbol?: string;
    quantity?: string;
  } | null>(null);
  const [cashOpen, setCashOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [flowKind, setFlowKind] = useState<"deposit" | "withdrawal">("deposit");
  const [flowAmount, setFlowAmount] = useState("");
  const [flowNote, setFlowNote] = useState("");
  const [requestId, setRequestId] = useState(newRequestId);
  const [rename, setRename] = useState(account.name);
  const utils = api.useUtils();
  const { data: names } = useSecurityNames();
  useEffect(() => {
    setRequestId(newRequestId());
  }, [account.id, flowKind, flowAmount, flowNote]);
  const detail = api.simAccountDetail.useQuery(
    { accountId: account.id, limit: 1 },
    { enabled: visible, refetchInterval: visible ? 30000 : false },
  );
  const cashFlow = api.simAccountCashFlow.useMutation({
    onSuccess: () => {
      setRequestId(newRequestId());
      setCashOpen(false);
      setFlowAmount("");
      setFlowNote("");
      setMessage("资金流水已记录");
      void utils.simAccountsList.invalidate();
      void utils.simAccountDetail.invalidate();
      void detail.refetch();
      onChanged();
    },
    onError: (error) => setMessage(error.message),
  });
  const renameAccount = api.simAccountRename.useMutation({
    onSuccess: () => {
      setRenameOpen(false);
      setMessage("账户已重命名");
      void utils.simAccountsList.invalidate();
      onChanged();
    },
    onError: (error) => setMessage(error.message),
  });
  const removeAccount = api.simAccountDelete.useMutation({
    onSuccess: () => {
      setDeleteOpen(false);
      void utils.simAccountsList.invalidate();
      onDelete();
    },
    onError: (error) => setMessage(error.message),
  });
  const digits = moneyDigits(account.market);
  return (
    <div className="space-y-3 border-t border-nc-border-soft pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold">{account.name}</h3>
          <p className="text-sm text-nc-text-3">
            {marketLabel(account.market)} · {account.currency} · 可用{" "}
            {formatSimDecimal(account.cash, digits)} {account.currency}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setOrder({ side: "buy" })}>
            买入
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setOrder({ side: "sell" })}
          >
            卖出
          </Button>
          <Button size="sm" variant="outline" onClick={() => setCashOpen(true)}>
            充值 / 出金
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setRename(account.name);
              setRenameOpen(true);
            }}
          >
            重命名
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => setDeleteOpen(true)}
          >
            删除账户
          </Button>
        </div>
      </div>
      {message && (
        <p role="status" className="text-sm text-nc-text-3">
          {message}
        </p>
      )}
      <Segmented
        label="模拟账户明细"
        value={tab}
        onChange={setTab}
        options={[
          { value: "positions", label: "持仓" },
          { value: "cashFlows", label: "资金流水" },
          { value: "trades", label: "交易明细" },
        ]}
      />
      {tab === "positions" ? (
        <PositionsTable
          account={account}
          positions={detail.data?.positions ?? []}
          loading={detail.isLoading}
          onSell={(position) =>
            setOrder({
              side: "sell",
              symbol: position.symbol,
              quantity: position.sellableQuantity,
            })
          }
        />
      ) : tab === "cashFlows" ? (
        <CashFlowLedger
          key={`${account.id}:${account.revision}`}
          account={account}
        />
      ) : (
        <TradeLedger
          key={`${account.id}:${account.revision}`}
          account={account}
          securityNames={names}
        />
      )}

      <Dialog
        open={order !== null}
        onOpenChange={(open) => {
          if (!open) setOrder(null);
        }}
      >
        <DialogContent className="lg:max-w-xl">
          <DialogTitle>
            {order?.side === "sell" ? "卖出" : "买入"} · {account.name}
          </DialogTitle>
          <DialogDescription>
            仅写入本地模拟账户，绝不触发真实下单；成交按本地费用与滑点口径记账。
          </DialogDescription>
          {order && (
            <SimOrderForm
              key={`${account.id}:${order.side}:${order.symbol ?? ""}`}
              defaults={{
                accountId: account.id,
                symbol: order.symbol ?? "",
                side: order.side,
                quantity: order.quantity ?? "",
              }}
              marketHint={account.market}
              onDone={() => {
                setOrder(null);
                void detail.refetch();
                onChanged();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={cashOpen} onOpenChange={setCashOpen}>
        <DialogContent>
          <DialogTitle>充值 / 出金 · {account.name}</DialogTitle>
          <DialogDescription>
            只调整本地模拟账户的可用资金，不影响真实券商账簿。
          </DialogDescription>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              cashFlow.mutate({
                accountId: account.id,
                requestId,
                kind: flowKind,
                amount: flowAmount.trim(),
                note: flowNote.trim(),
              });
            }}
          >
            <Segmented
              label="资金方向"
              value={flowKind}
              onChange={setFlowKind}
              options={[
                { value: "deposit", label: "充值" },
                { value: "withdrawal", label: "出金" },
              ]}
            />
            <label className="block">
              金额（{account.currency}）
              <Input
                aria-label="金额"
                inputMode="decimal"
                required
                value={flowAmount}
                onChange={(event) => setFlowAmount(event.target.value)}
              />
            </label>
            <label className="block">
              备注
              <Input
                aria-label="备注"
                maxLength={500}
                value={flowNote}
                onChange={(event) => setFlowNote(event.target.value)}
              />
            </label>
            {cashFlow.error && (
              <p role="alert" className="text-sm text-nc-bad">
                {cashFlow.error.message}
              </p>
            )}
            <div className="flex gap-2">
              <Button disabled={cashFlow.isPending}>
                {cashFlow.isPending ? "正在记录…" : "记录资金流水"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={cashFlow.isPending}
                onClick={() => setCashOpen(false)}
              >
                取消
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogTitle>重命名模拟账户</DialogTitle>
          <DialogDescription>
            只修改本地显示名称，不改变持仓、资金流水与成交记录。
          </DialogDescription>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              renameAccount.mutate({
                accountId: account.id,
                name: rename.trim(),
              });
            }}
          >
            <label className="block">
              新名称
              <Input
                aria-label="新名称"
                required
                maxLength={32}
                value={rename}
                onChange={(event) => setRename(event.target.value)}
              />
            </label>
            {renameAccount.error && (
              <p role="alert" className="text-sm text-nc-bad">
                {renameAccount.error.message}
              </p>
            )}
            <div className="flex gap-2">
              <Button disabled={renameAccount.isPending}>
                {renameAccount.isPending ? "正在保存…" : "保存名称"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={renameAccount.isPending}
                onClick={() => setRenameOpen(false)}
              >
                取消
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogTitle>删除模拟账户 · {account.name}</DialogTitle>
          <DialogDescription>
            删除会永久移除该模拟账户的持仓、资金流水与全部模拟成交记录；其他模拟账户与真实券商账簿不受影响。此操作不可撤销。
          </DialogDescription>
          {removeAccount.error && (
            <p role="alert" className="text-sm text-nc-bad">
              {removeAccount.error.message}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              variant="danger"
              disabled={removeAccount.isPending}
              onClick={() => removeAccount.mutate({ accountId: account.id })}
            >
              {removeAccount.isPending
                ? "正在删除…"
                : `确认删除〈${account.name}〉`}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={removeAccount.isPending}
              onClick={() => setDeleteOpen(false)}
            >
              取消
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function SimAccountsPanel() {
  const visible = useScreenVisible();
  const query = api.simAccountsList.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
  });
  const accounts = useMemo(
    () => (query.data ?? []).filter((account) => account.status === "active"),
    [query.data],
  );
  const [selectedId, setSelectedId] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const selected =
    accounts.find((account) => account.id === selectedId) ??
    accounts[0] ??
    null;
  return (
    <Panel
      title="本地模拟盘"
      aria-label="本地模拟盘"
      tone="accent"
      meta="仅本地模拟记账，不连接真实券商"
      actions={
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          + 新建模拟账户
        </Button>
      }
    >
      <div className="space-y-4">
        {query.error && (
          <p role="alert" className="text-sm text-nc-bad">
            {query.error.message}{" "}
            <Button
              size="sm"
              variant="outline"
              onClick={() => void query.refetch()}
            >
              重试
            </Button>
          </p>
        )}
        {query.isLoading && (
          <p className="text-sm text-nc-text-3">正在读取模拟账户…</p>
        )}
        {!query.isLoading && accounts.length === 0 && (
          <p className="text-sm text-nc-text-3">
            尚无活跃模拟账户；点击「+ 新建模拟账户」开始记账。
          </p>
        )}
        {accounts.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {accounts.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                active={selected?.id === account.id}
                onSelect={() => setSelectedId(account.id)}
              />
            ))}
          </div>
        )}
        {selected && (
          <AccountWorkspace
            key={selected.id}
            account={selected}
            onChanged={() => void query.refetch()}
            onDelete={() => setSelectedId("")}
          />
        )}
      </div>
      <AccountCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(account) => setSelectedId(account.id)}
      />
    </Panel>
  );
}
