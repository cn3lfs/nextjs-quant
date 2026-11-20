"use client";
import { useEffect, useRef, useState } from "react";
import Big from "big.js";
import {
  Wallet,
  ClockCounterClockwise as History,
} from "@phosphor-icons/react/ssr";
import type {
  AccountTradeRow,
  AccountViewInput,
} from "~/server/crypto-trading/account-model";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import { useAccumulatedPages } from "../ui/use-infinite-table";
import { GridTable, Pill } from "../panels";
import { useScreenVisible } from "../workbench/use-task-visible";

type Filters = {
  symbol: "all" | "BTCUSDT" | "ETHUSDT";
  side: "all" | "BUY" | "SELL";
  source: "all" | "strategy" | "platform";
  from: string;
  to: string;
};
const utcDay = (time = Date.now()) => new Date(time).toISOString().slice(0, 10);
const initialFilters = (): Filters => ({
  symbol: "all",
  side: "all",
  source: "all",
  from: utcDay(Date.now() - 30 * 86400000),
  to: utcDay(),
});
const dateTime = (value: number | null | undefined) =>
  value == null
    ? "尚无"
    : `${new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone: "UTC" })} UTC`;
function range(filters: Pick<Filters, "from" | "to">) {
  const from = filters.from
    ? Date.parse(`${filters.from}T00:00:00.000Z`)
    : undefined;
  const to = filters.to
    ? Math.min(Date.parse(`${filters.to}T00:00:00.000Z`) + 86400000, Date.now())
    : undefined;
  if (
    (from !== undefined && !Number.isFinite(from)) ||
    (to !== undefined && !Number.isFinite(to))
  )
    throw new Error("日期无效");
  if (from !== undefined && to !== undefined && from >= to)
    throw new Error("起始时间须早于结束时间");
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}
const tradeColumns: DataTableColumn<AccountTradeRow>[] = [
  {
    id: "time",
    header: "成交时间",
    cell: ({ row }) => (
      <span className="whitespace-nowrap">{dateTime(row.original.time)}</span>
    ),
  },
  {
    id: "symbol",
    header: "交易对 / 方向",
    cell: ({ row }) => (
      <>
        <strong>{row.original.symbol}</strong>
        <p>{row.original.side === "BUY" ? "买入" : "卖出"}</p>
      </>
    ),
  },
  {
    id: "source",
    header: "来源",
    cell: ({ row }) => (
      <Pill tone={row.original.source === "strategy" ? "accent" : "idle"}>
        {row.original.source === "strategy" ? "本策略" : "平台成交"}
      </Pill>
    ),
  },
  {
    id: "quantity",
    header: "数量 / 价格",
    cell: ({ row }) => (
      <div className="tabular-nums">
        <p>
          {row.original.quantity}{" "}
          {row.original.symbol === "BTCUSDT" ? "BTC" : "ETH"}
        </p>
        <p>{row.original.price} USDT</p>
      </div>
    ),
  },
  {
    id: "quote",
    header: "成交金额",
    cell: ({ row }) => (
      <span className="tabular-nums">{row.original.quoteQuantity} USDT</span>
    ),
  },
  {
    id: "fee",
    header: "手续费",
    cell: ({ row }) => (
      <span className="tabular-nums">
        {row.original.fee} {row.original.feeAsset}
      </span>
    ),
  },
  {
    id: "identifiers",
    header: "平台编号",
    cell: ({ row }) => (
      <div className="min-w-36 max-w-64 break-all">
        <p>成交：{row.original.id}</p>
        <p>订单：{row.original.orderId}</p>
        {row.original.clientOrderId && (
          <p>客户单号：{row.original.clientOrderId}</p>
        )}
      </div>
    ),
  },
];

/** Account facts are a read model, independent of strategy positions and execution controls. */
export function CryptoAccountPanel({
  id,
  configured,
}: {
  id: string;
  configured: boolean;
}) {
  const visible = useScreenVisible();
  const utils = api.useUtils();
  const [draft, setDraft] = useState<Filters>(initialFilters);
  const [filter, setFilter] = useState<
    Omit<AccountViewInput, "id" | "page" | "pageSize">
  >(() => range(initialFilters()));
  const filterToDate = useRef(utcDay());
  const [page, setPage] = useState(1);
  const [inputError, setInputError] = useState<string | null>(null);
  const [autoPaused, setAutoPaused] = useState(false);
  const [syncFrom, setSyncFrom] = useState("");
  const [syncTo, setSyncTo] = useState("");
  const lastAttempt = useRef(0);
  const sync = api.syncCryptoAccount.useMutation({
    retry: false,
    onSuccess: (state) => {
      setAutoPaused(
        state.status === "failed" ||
          (state.status === "partial" &&
            (state.lastIncrementalTo === null ||
              state.lastIncrementalTo < state.requestedTo)),
      );
      if (filterToDate.current >= utcDay())
        setFilter((current) => ({ ...current, to: Date.now() }));
      void utils.cryptoAccountView.invalidate();
    },
    onError: () => {
      setAutoPaused(true);
      void utils.cryptoAccountView.invalidate();
    },
  });
  const latestSync = useRef(sync);
  latestSync.current = sync;
  const view = api.cryptoAccountView.useQuery(
    { id: id as AccountViewInput["id"], ...filter, page, pageSize: 50 },
    {
      enabled: configured && visible,
      retry: false,
      refetchInterval: (query) =>
        visible &&
        configured &&
        (sync.isPending || query.state.data?.sync?.status === "running")
          ? 2000
          : false,
    },
  );
  useEffect(() => {
    if (!configured || !visible || autoPaused) return;
    const refresh = () => {
      if (
        latestSync.current.isPending ||
        Date.now() - lastAttempt.current < 60000
      )
        return;
      lastAttempt.current = Date.now();
      latestSync.current.mutate({ id: id as AccountViewInput["id"] });
    };
    refresh();
    const timer = setInterval(refresh, 60000);
    return () => clearInterval(timer);
  }, [configured, visible, id, autoPaused]);
  const data = view.data;
  const resetKey = JSON.stringify([id, filter]);
  const batches = useAccumulatedPages({
    pageIndex: page - 1,
    items: data?.rows,
    total: data?.total,
    resetKey,
    getKey: (row) => `${row.symbol}-${row.orderId}-${row.id}`,
    isSuccess: view.isSuccess && !view.isFetching,
    pageSize: 50,
  });
  const snapshot = data?.snapshot;
  const state = data?.sync;
  const canSync = configured && !sync.isPending && state?.status !== "running";
  const syncRange = (custom: boolean) => {
    try {
      const selected = custom ? range({ from: syncFrom, to: syncTo }) : {};
      if (custom && (!syncFrom || !syncTo))
        throw new Error("补同步需要起止时间");
      if (
        custom &&
        selected.from !== undefined &&
        selected.to !== undefined &&
        selected.to - selected.from > 90 * 86400000
      )
        throw new Error("单次补同步范围不得超过90天");
      setInputError(null);
      lastAttempt.current = Date.now();
      sync.mutate({ id: id as AccountViewInput["id"], ...selected });
    } catch (error) {
      setInputError(error instanceof Error ? error.message : "日期无效");
    }
  };
  const applyFilters = () => {
    try {
      const dates = range(draft);
      setFilter({
        ...dates,
        ...(draft.symbol === "all" ? {} : { symbol: draft.symbol }),
        ...(draft.side === "all" ? {} : { side: draft.side }),
        ...(draft.source === "all" ? {} : { source: draft.source }),
      });
      filterToDate.current = draft.to;
      setPage(1);
      setInputError(null);
    } catch (error) {
      setInputError(error instanceof Error ? error.message : "日期无效");
    }
  };
  let emptyMessage =
    "尚未同步账户历史，请先同步；这里不能据此判断平台没有成交。";
  if (state?.status === "running")
    emptyMessage =
      "正在同步，已保存的成交会逐步显示；尚未完成的范围不能视为无成交。";
  if (state?.status === "success")
    emptyMessage =
      "当前筛选的本地已同步范围暂无成交；未覆盖或超过平台保留期的历史不能据此判断。";
  if (state?.status === "partial" || state?.status === "failed")
    emptyMessage =
      "账户同步未完整成功，当前筛选暂无已保存成交；请查看范围和错误后重试。";
  return (
    <section
      aria-label="平台账户持仓与历史成交"
      className="min-w-0 space-y-4 text-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <Wallet size={16} />
            平台当前持仓
          </h3>
          <p className="mt-1 text-nc-text-3">
            账户内全部
            BTC、ETH、USDT，与策略模拟工作区的持仓数量分开；读取账户不启动策略，也不接管原有资产。
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={!canSync}
          onClick={() => syncRange(false)}
        >
          {sync.isPending || state?.status === "running"
            ? "同步中…"
            : "同步账户与最近成交"}
        </Button>
      </div>
      {!configured && (
        <p role="status">
          尚未配置当前模拟账户凭证。先保存策略配置与模拟凭证，再同步平台余额和成交。
        </p>
      )}
      {configured && (
        <p className="text-nc-text-4">
          页面可见且窗口获得焦点时自动增量同步，每60秒最多一次；首次默认最近30天。隐藏页面停止轮询。
          {autoPaused ? "最近同步未完整成功，自动同步已暂停，请手动重试。" : ""}
        </p>
      )}
      {inputError && (
        <p role="alert" className="nc-text-bad">
          {inputError}
        </p>
      )}
      {sync.error && (
        <p role="alert" className="nc-text-bad">
          同步失败：{sync.error.message}；保留上次成功保存的数据。
        </p>
      )}
      {view.error && (
        <p role="alert" className="nc-text-bad">
          读取已同步账户数据失败：{view.error.message}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void view.refetch()}
          >
            重试读取
          </Button>
        </p>
      )}
      {snapshot ? (
        <>
          <p>
            平台余额快照：{dateTime(snapshot.at)}
            。估值仅为快照时点现价换算，不代表成本或收益。
          </p>
          <GridTable
            label="平台BTC ETH USDT余额"
            rows={snapshot.balances.filter((balance) =>
              ["BTC", "ETH", "USDT"].includes(balance.asset),
            )}
            rowKey={(balance) => balance.asset}
            minWidth={560}
            columns={[
              {
                key: "asset",
                header: "资产",
                cell: (balance) => balance.asset,
              },
              {
                key: "total",
                header: "平台总量",
                cell: (balance) => balance.total,
                align: "right",
              },
              {
                key: "free",
                header: "可用",
                cell: (balance) => balance.free,
                align: "right",
              },
              {
                key: "locked",
                header: "冻结",
                cell: (balance) =>
                  new Big(balance.total).minus(balance.free).toFixed(),
                align: "right",
              },
            ]}
          />
          <GridTable
            label="平台BTC ETH持仓估值"
            rows={snapshot.positions}
            rowKey={(position) => position.symbol}
            minWidth={580}
            columns={[
              {
                key: "symbol",
                header: "交易对",
                cell: (position) => position.symbol,
              },
              {
                key: "price",
                header: "现价 USDT",
                cell: (position) => position.price ?? "不可得",
                align: "right",
              },
              {
                key: "value",
                header: "估算市值 USDT",
                cell: (position) => position.marketValue ?? "不可得",
                align: "right",
              },
              {
                key: "at",
                header: "行情时点",
                cell: (position) => dateTime(position.priceAt),
              },
            ]}
          />
          {snapshot.warnings.map((warning, index) => (
            <p key={index} className="nc-text-warn">
              {warning}
            </p>
          ))}
        </>
      ) : (
        <p className="text-nc-text-4">
          {view.isLoading
            ? "正在读取本地账户快照…"
            : "尚无成功读取的平台余额快照；策略数量不能代替平台持仓。"}
        </p>
      )}
      <div className="space-y-2 rounded border border-nc-border-soft p-3">
        <h4 className="font-medium">同步状态与覆盖范围</h4>
        {state ? (
          <>
            <p role="status">
              {
                (
                  {
                    running: "同步进行中",
                    success: "本次请求范围同步成功",
                    partial: "部分同步",
                    failed: "同步失败",
                  } as const
                )[state.status]
              }{" "}
              · 最近完整同步：{dateTime(state.lastSuccessAt)} · 最近增量终点：
              {dateTime(state.lastIncrementalTo)}
            </p>
            <p>
              本次请求：{dateTime(state.requestedFrom)} 至{" "}
              {dateTime(state.requestedTo)}（结束时点不含）
            </p>
            {state.error && (
              <p role="alert" className="nc-text-bad">
                {state.error}
              </p>
            )}
            {state.warnings.map((warning, index) => (
              <p key={index} className="nc-text-warn">
                {warning}
              </p>
            ))}
            <details>
              <summary className="cursor-pointer">
                累计已查询范围（{state.completedRanges.length}）
              </summary>
              <ul className="mt-2 max-h-40 space-y-1 overflow-auto">
                {state.completedRanges.map((item, index) => (
                  <li key={index}>
                    {item.symbol}：{dateTime(item.from)} 至 {dateTime(item.to)}
                  </li>
                ))}
              </ul>
            </details>
          </>
        ) : (
          <p>尚未同步历史成交；没有覆盖范围记录。</p>
        )}
        <p className="text-nc-text-4">
          平台历史接口存在查询窗口与保留期限制，模拟账户历史可能重置；本地记录不等于平台全部历史。失败或不可得范围不会补造成交。
        </p>
        <details>
          <summary className="cursor-pointer">按时间补同步（最多90天）</summary>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label>
              起始日期（UTC）
              <Input
                type="date"
                value={syncFrom}
                onChange={(event) => setSyncFrom(event.target.value)}
              />
            </label>
            <label>
              结束日期（UTC，含当日）
              <Input
                type="date"
                value={syncTo}
                onChange={(event) => setSyncTo(event.target.value)}
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={!canSync}
              onClick={() => syncRange(true)}
            >
              补同步指定范围
            </Button>
          </div>
        </details>
      </div>
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <History size={16} />
        平台历史成交
      </h3>
      <p className="text-nc-text-3">
        日期筛选与补同步按UTC自然日，结束日期含当日，今天只查询至当前时刻；显示时间统一为UTC。包含本策略以外的
        BTCUSDT / ETHUSDT
        成交；仅匹配本系统订单的记录标记“本策略”，其他标记“平台成交”，不推断为手动交易。
      </p>
      <form
        className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          applyFilters();
        }}
      >
        <label className="flex flex-col gap-1">
          交易对
          <Select
            value={draft.symbol}
            onValueChange={(value) =>
              setDraft({ ...draft, symbol: value as Filters["symbol"] })
            }
          >
            <SelectTrigger aria-label="历史成交交易对">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部交易对</SelectItem>
              <SelectItem value="BTCUSDT">BTCUSDT</SelectItem>
              <SelectItem value="ETHUSDT">ETHUSDT</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          方向
          <Select
            value={draft.side}
            onValueChange={(value) =>
              setDraft({ ...draft, side: value as Filters["side"] })
            }
          >
            <SelectTrigger aria-label="历史成交方向">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部方向</SelectItem>
              <SelectItem value="BUY">买入</SelectItem>
              <SelectItem value="SELL">卖出</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          来源
          <Select
            value={draft.source}
            onValueChange={(value) =>
              setDraft({ ...draft, source: value as Filters["source"] })
            }
          >
            <SelectTrigger aria-label="历史成交来源">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部来源</SelectItem>
              <SelectItem value="strategy">本策略</SelectItem>
              <SelectItem value="platform">平台成交</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          起始日期（UTC）
          <Input
            type="date"
            value={draft.from}
            onChange={(event) =>
              setDraft({ ...draft, from: event.target.value })
            }
          />
        </label>
        <label className="flex flex-col gap-1">
          结束日期（UTC，含当日）
          <Input
            type="date"
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <Button type="submit" size="sm" disabled={!configured}>
            筛选已同步成交
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              const next = initialFilters();
              setDraft(next);
              setFilter(range(next));
              filterToDate.current = next.to;
              setPage(1);
              setInputError(null);
            }}
          >
            重置
          </Button>
        </div>
      </form>
      {configured && (
        <DataTable
          label="平台历史成交"
          columns={tradeColumns}
          data={batches.rows}
          rowCount={batches.total}
          pagination={{ pageIndex: 0, pageSize: 50 }}
          sorting={[]}
          onSortingChange={() => {}}
          onPaginationChange={() => {}}
          getRowId={(row) => `${row.symbol}-${row.orderId}-${row.id}`}
          loading={view.isFetching}
          error={view.error?.message}
          onRetry={() => void view.refetch()}
          emptyMessage={emptyMessage}
          showPagination={false}
          infiniteScroll={{
            hasMore: batches.hasMore,
            loadingMore: view.isFetching,
            onLoadMore: () => setPage(page + 1),
          }}
        />
      )}
    </section>
  );
}
