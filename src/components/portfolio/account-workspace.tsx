"use client";
import { useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, type RouterOutputs } from "~/trpc/react";
import {
  accountKindLabels,
  industryGroupsFor,
  stopStatusFor,
  tradeLinkReceiptText,
  type TradeLink,
} from "~/lib/portfolio/account-workspace";
import {
  formatNumber,
  formatPercent,
} from "trading-strategy-core/format-number";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import { LedgerSelect } from "../signals/ledger-fields";
import { alertReference } from "~/lib/strategy-facts/alert-reference";
import { Input } from "../ui/input";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import { Segmented } from "../panels";
import { PaperAccountsPanel } from "./paper-accounts-panel";
import { TradeLedgerPanel } from "./trade-ledger-panel";
import {
  BulkTradeLinks,
  TradeJournalEditor,
  WeeklyReview,
} from "./account-review-panels";
import { CryptoRiskNotes } from "./crypto-risk-notes";

const pct = (n: number | null) => formatPercent(n === null ? null : n * 100);
const sourceLabels = {
  all: "全部来源",
  delivery: "券商交割单",
  local: "手工账本",
} as const;
type PositionSource = keyof typeof sourceLabels;
type PositionKind = "real" | "paper" | "exchange-simulation" | "all";
type PositionMarket = "all" | "cn-equity" | "crypto";
type PositionGroup = "market" | "sleeve" | "kind";
type PositionStopStatus = "all" | "touched" | "unknown";
type Position = RouterOutputs["accountPositions"]["items"][number];
type AccountTrade = RouterOutputs["accountTrades"]["trades"][number];
type TradeSnapshot = Pick<AccountTrade, "symbol" | "date" | "side">;
type TradeLinkInput = Parameters<
  ReturnType<typeof api.linkAccountTrade.useMutation>["mutate"]
>[0];
type HoldingsFilters = {
  kind: PositionKind;
  source: PositionSource;
  market: PositionMarket;
  stopStatus: PositionStopStatus;
  group: PositionGroup;
  sleeve: string;
  page: number;
};
const defaultHoldingsFilters: HoldingsFilters = {
  kind: "real",
  source: "all",
  market: "all",
  stopStatus: "all",
  group: "market",
  sleeve: "",
  page: 0,
};
export function AccountWorkspace() {
  const search = useSearchParams(),
    tab = search.get("tab"),
    position = search.get("position");
  if (tab === "ledger") return <TradeLedgerPanel />;
  if (tab === "trades") return <AccountTrades />;
  if (tab === "paper") return <PaperAccountsPanel />;
  if (tab === "attribution") return <AccountAttribution />;
  if (tab === "monthly") return <MonthlyReview />;
  if (tab === "weekly") return <WeeklyReview />;
  return <HoldingsExplorer position={position} />;
}
/**
 * Owns the list filters above the list/detail switch, so opening a position and
 * returning (link or Back/Forward) keeps the exact list view. A hard refresh,
 * another workspace tab, or a direct position link starts from the defaults.
 */
function HoldingsExplorer({ position }: { position: string | null }) {
  const [filters, setFilters] = useState(defaultHoldingsFilters);
  const update = (patch: Partial<HoldingsFilters>) =>
    setFilters((current) => ({ ...current, ...patch }));
  return position ? (
    <AccountPositionDetail key={position} id={position} />
  ) : (
    <>
      <CryptoRiskNotes />
      <UnifiedPositions filters={filters} update={update} />
    </>
  );
}
function UnifiedPositions({
  filters,
  update,
}: {
  filters: HoldingsFilters;
  update: (patch: Partial<HoldingsFilters>) => void;
}) {
  const { kind, market, source, stopStatus, group, sleeve, page } = filters;
  const query = api.accountPositions.useQuery({
    kind,
    market,
    group,
    sleeve,
    source,
    stopStatus,
    page,
  });
  const columns: DataTableColumn<Position>[] = [
    {
      id: "symbol",
      header: "持仓",
      cell: ({ row }) => (
        <Link
          className="underline"
          href={`/accounts?position=${encodeURIComponent(row.original.id)}`}
        >
          {row.original.symbol} ·{" "}
          {row.original.market === "cn-equity" ? "A股" : "数字货币"}
        </Link>
      ),
    },
    {
      id: "account",
      header: "账户 / 类型",
      cell: ({ row }) => (
        <span
          className={
            row.original.kind === "real" ? "text-nc-text-1" : "text-nc-accent"
          }
        >
          {row.original.account} · {accountKindLabels[row.original.kind]}
        </span>
      ),
    },
    {
      id: "sleeve",
      header: "分仓 / 行业",
      cell: ({ row }) =>
        `${row.original.sleeve} / ${industryGroupsFor(row.original).join("、") || "未知"}`,
    },
    {
      id: "value",
      header: "市值",
      cell: ({ row }) =>
        `${formatNumber(row.original.value)} ${row.original.currency}`,
    },
    {
      id: "stop",
      header: "距止损 / R",
      cell: ({ row }) => {
        const status = stopStatusFor(row.original);
        return status === "unknown" ? (
          <span>待核对</span>
        ) : (
          <span className={status === "touched" ? "text-nc-bad" : ""}>
            {pct(row.original.stopDistance)} /{" "}
            {formatNumber(row.original.rMultiple)}
          </span>
        );
      },
    },
  ];
  return (
    <section aria-label="统一持仓" className="space-y-4">
      <h2 className="text-xl font-semibold">
        统一持仓与风险
        {kind === "real" && (
          <span className="ml-2 text-sm font-normal text-nc-text-3">
            来源：{sourceLabels[source]}
          </span>
        )}
      </h2>
      <p className="text-sm text-nc-text-3">
        默认仅真实账户；纸面、模拟交易所分别标记。CNY/USDT不换算相加。手工与导入账本为独立事实，请勿重复登记同一成交。
      </p>
      <p className="text-sm text-nc-text-3">
        按已读取的价格与记录的止损比较。缺少有效价格或止损的持仓显示为「待核对」。
      </p>
      <Segmented
        label="账户类型"
        value={kind}
        options={[
          { value: "real", label: "真实账户" },
          { value: "paper", label: "纸面账户" },
          { value: "exchange-simulation", label: "模拟交易所" },
          { value: "all", label: "全部类型" },
        ]}
        onChange={(v) => {
          // Sources only exist on real accounts; leaving real resets to all.
          update({
            kind: v,
            page: 0,
            ...(v === "real" ? {} : { source: "all" as const }),
          });
        }}
      />
      {kind === "real" && (
        <Segmented
          label="持仓来源"
          value={source}
          options={[
            { value: "all", label: "全部来源" },
            { value: "delivery", label: "券商交割单" },
            { value: "local", label: "手工账本" },
          ]}
          onChange={(v) => update({ source: v, page: 0 })}
        />
      )}
      <Segmented
        label="市场"
        value={market}
        options={[
          { value: "all", label: "全部市场" },
          { value: "cn-equity", label: "A股" },
          { value: "crypto", label: "数字货币" },
        ]}
        onChange={(v) => update({ market: v, page: 0 })}
      />
      <Segmented
        label="止损状态"
        value={stopStatus}
        options={[
          { value: "all", label: "全部" },
          { value: "touched", label: "所示价格已到止损位" },
          { value: "unknown", label: "待核对" },
        ]}
        onChange={(v) => update({ stopStatus: v, page: 0 })}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="分组方式"
          value={group}
          options={[
            { value: "market", label: "按市场" },
            { value: "sleeve", label: "按分仓" },
            { value: "kind", label: "按类型" },
          ]}
          onChange={(v) => update({ group: v, page: 0 })}
        />
        <Input
          aria-label="分仓筛选"
          placeholder="分仓ID，空为全部"
          value={sleeve}
          onChange={(e) => update({ sleeve: e.target.value, page: 0 })}
          className="max-w-56"
        />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {query.data?.totals.map((t) => (
          <p key={t.currency} className="rounded border p-3">
            {t.currency} 持仓市值 {formatNumber(t.value)} · {t.count} 笔持仓 ·{" "}
            {t.missing} 笔估值未知
          </p>
        ))}
      </div>
      <div className="flex flex-wrap gap-3 text-sm">
        <p>行业组可重叠，各组独立校验；行业市值不相加为账户总额。</p>
        {query.data?.exposure.map((e) => (
          <p key={`${e.dimension}:${e.key}`}>
            {e.dimension} / {e.key}：{formatNumber(e.value)}
          </p>
        ))}
      </div>
      {query.data?.missingAccounts.map((m) => (
        <p key={m} role="status">
          {m}
        </p>
      ))}
      <DataTable
        label="统一持仓列表"
        columns={columns}
        data={query.data?.items ?? []}
        rowCount={query.data?.total ?? 0}
        emptyMessage={
          stopStatus === "touched"
            ? "当前范围没有所示价格已到止损位的持仓；按已读取价格与记录止损比较。"
            : stopStatus === "unknown"
              ? "当前范围没有待核对的持仓。"
              : kind === "real" && source !== "all"
                ? `当前范围（${sourceLabels[source]}）无持仓。`
                : undefined
        }
        pagination={{ pageIndex: page, pageSize: 20 }}
        sorting={[]}
        onSortingChange={() => {}}
        onPaginationChange={(u) =>
          update({
            page: (
              typeof u === "function" ? u({ pageIndex: page, pageSize: 20 }) : u
            ).pageIndex,
          })
        }
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.error?.message}
        onRetry={() => void query.refetch()}
      />
    </section>
  );
}
function AccountPositionDetail({ id }: { id: string }) {
  const [page, setPage] = useState(0);
  const query = api.accountPosition.useQuery({ id, page });
  const readError = query.error?.message;
  return (
    <section aria-label="持仓归因与衰减" className="space-y-4">
      <Link href="/accounts" scroll={false} className="underline">
        返回统一持仓
      </Link>
      {/* Keep each branch in a fixed sibling slot so a background refetch
          failure never unmounts the loaded content, its drafts or receipts. */}
      {query.isLoading ? <p role="status">正在读取持仓归因…</p> : null}
      {readError ? (
        <p role="alert">
          {query.data
            ? `刷新失败，以下为最近一次读取的结果。${readError}`
            : readError}{" "}
          <Button onClick={() => void query.refetch()}>重试</Button>
        </p>
      ) : null}
      {query.data ? (
        <PositionDetailContent
          data={query.data}
          page={page}
          setPage={setPage}
          fetching={query.isFetching}
          readError={!!readError}
        />
      ) : null}
    </section>
  );
}

function PositionDetailContent({
  data: d,
  page,
  setPage,
  fetching,
  readError,
}: {
  data: RouterOutputs["accountPosition"];
  page: number;
  setPage: (page: number) => void;
  fetching: boolean;
  readError: boolean;
}) {
  const p = d.position;
  const status = stopStatusFor(p);
  return (
    <>
      <h2 className="text-xl font-semibold">
        {p.symbol} · {accountKindLabels[p.kind]} · {p.account}
      </h2>
      <p>
        数量 {formatNumber(p.quantity, 6)} · 市值 {formatNumber(p.value)}{" "}
        {p.currency} ·{" "}
        {(() => {
          return status === "unknown" ? (
            "距止损 待核对"
          ) : (
            <span className={status === "touched" ? "text-nc-bad" : ""}>
              距止损 {pct(p.stopDistance)} · R{" "}
              {formatNumber(p.rMultiple)}
            </span>
          );
        })()}
      </p>
      <p>
        原价时点 {p.at ?? "未知"} · 分仓 {p.sleeve} · 行业组{" "}
        {industryGroupsFor(p).join("、") || "未知"}
      </p>
      {p.reasons.map((r) => (
        <p key={r} className="text-sm text-nc-text-3">
          {r}
        </p>
      ))}
      <h3 className="text-lg font-semibold">归因与衰减</h3>
      {p.strategyId === null ? (
        <p>尚未关联策略；下方按来源建议确认或手工关联。</p>
      ) : (
        <AttributionRows rows={d.attribution} />
      )}
      <h3>持仓相关性与集中度</h3>
      <p>
        同市场同类型价格日收益相关；缺少20个相邻市场日或零方差留空。历史行业未知不补造。集中度仅使用导入账本的重放净值，其他账户缺完整现金事实时留空。
      </p>
      <p>
        平均相关性 {formatNumber(d.correlation.averagePairwise.value)} ·
        有效证券对 {d.correlation.pairCount.available} · 最大权重{" "}
        {pct(d.concentration.summary.maxSingleWeight)}
      </p>
      {d.correlation.rows
        .find((r) => r.symbol === p.symbol)
        ?.cells.map((c, i) => (
          <p key={i}>
            {p.symbol} / {d.correlation.symbols[i]}：{formatNumber(c.value)} ·{" "}
            {c.overlapDays}日 {c.reason}
          </p>
        ))}
      <TradeSources
        trades={d.trades}
        suggestions={d.suggestions}
        total={d.tradeCount}
        page={page}
        setPage={setPage}
        fetching={fetching}
        readError={readError}
      />
    </>
  );
}

function TradeSources({
  trades,
  suggestions,
  total,
  page,
  setPage,
  fetching,
  readError = false,
}: {
  trades: RouterOutputs["accountTrades"]["trades"];
  suggestions: RouterOutputs["accountTrades"]["suggestions"];
  total: number;
  page: number;
  setPage: (page: number) => void;
  fetching: boolean;
  /** Last read failed; rows are stale, so block starting new links. */
  readError?: boolean;
}) {
  const utils = api.useUtils();
  const refreshViews = () => {
    try {
      // Best-effort read refresh; it must never turn a saved link into a
      // failure, so rejections and synchronous errors are swallowed here.
      void Promise.all([
        utils.accountPosition.invalidate(),
        utils.accountTrades.invalidate(),
        utils.accountPositions.invalidate(),
      ]).catch(() => {});
    } catch {
      // The write is already confirmed by the mutation response below.
    }
  };
  const link = api.linkAccountTrade.useMutation({ onSuccess: refreshViews });
  // A synchronous ref blocks a same-tick second submit before React can
  // re-render the disabled buttons.
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  // The row frozen when the dialog opened keeps the draft mounted even while
  // a list refresh temporarily returns no rows.
  const [manualTrade, setManualTrade] = useState<AccountTrade | null>(null);
  // Reset on every open, so a previous opening's receipt never leaks into a
  // new one. Manual success keeps the dialog open to show this attempt.
  const [manualResult, setManualResult] = useState<
    { link: TradeLink; trade: TradeSnapshot } | { error: string } | null
  >(null);
  const [suggestionFeedback, setSuggestionFeedback] = useState<string | null>(
    null,
  );
  // Last successful link for the list; survives closing the dialog.
  const [receipt, setReceipt] = useState<{
    link: TradeLink;
    trade: TradeSnapshot;
  } | null>(null);
  const snapshot = (t: AccountTrade): TradeSnapshot => ({
    symbol: t.symbol,
    date: t.date,
    side: t.side,
  });
  // Suggestion and manual links share this single starting point.
  const save = async (
    input: TradeLinkInput,
    trade: TradeSnapshot,
    origin: "suggestion" | "manual",
  ) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    if (origin === "manual") setManualResult(null);
    else setSuggestionFeedback(null);
    try {
      // Only the real response becomes the receipt; the pre-click snapshot
      // contributes symbol/date/side identity and nothing else.
      const saved = await link.mutateAsync(input);
      setReceipt({ link: saved, trade });
      if (origin === "manual") setManualResult({ link: saved, trade });
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : "关联未保存，请重试。";
      if (origin === "manual") setManualResult({ error: message });
      else setSuggestionFeedback(message);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const d = { trades, suggestions, tradeCount: total };
  return (
    <section aria-label="成交来源" className="space-y-3">
      <h3>
        成交来源（第 {page + 1} 页，共 {d.tradeCount} 笔）
      </h3>
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={page === 0 || fetching || pending}
          onClick={() => {
            if (pendingRef.current) return;
            setPage(page - 1);
          }}
        >
          上一页成交
        </Button>
        <Button
          variant="outline"
          disabled={(page + 1) * 20 >= d.tradeCount || fetching || pending}
          onClick={() => {
            if (pendingRef.current) return;
            setPage(page + 1);
          }}
        >
          下一页成交
        </Button>
      </div>
      <DataTable
        label="成交来源明细"
        data={d.trades}
        rowCount={total}
        pagination={{ pageIndex: page, pageSize: 20 }}
        sorting={[]}
        onSortingChange={() => {}}
        onPaginationChange={(u) => {
          if (pendingRef.current) return;
          setPage(
            (typeof u === "function" ? u({ pageIndex: page, pageSize: 20 }) : u)
              .pageIndex,
          );
        }}
        showPagination={false}
        getRowId={(t) => t.id}
        columns={[
          {
            id: "date",
            header: "日期",
            cell: ({ row }) => (
              <span
                title={`${row.original.account} · ${accountKindLabels[row.original.kind]}`}
              >
                {row.original.date}
              </span>
            ),
          },
          {
            id: "side",
            header: "方向",
            cell: ({ row }) => (row.original.side === "buy" ? "买入" : "卖出"),
          },
          {
            id: "quantity",
            header: "数量",
            cell: ({ row }) => formatNumber(row.original.quantity, 6),
          },
          {
            id: "price",
            header: "价格",
            cell: ({ row }) => formatNumber(row.original.price),
          },
          {
            id: "strategy",
            header: "策略",
            cell: ({ row }) =>
              row.original.strategyId
                ? `${row.original.strategyId} v${row.original.strategyVersion}`
                : "未关联",
          },
          {
            id: "plan",
            header: "计划",
            cell: ({ row }) =>
              row.original.planId ? (
                <Link
                  href={`/accounts/alerts?plan=${encodeURIComponent(row.original.planId)}`}
                  className="underline"
                >
                  查看计划
                </Link>
              ) : (
                "—"
              ),
          },
          {
            id: "alert",
            header: "提醒",
            cell: ({ row }) =>
              row.original.alert ? (
                <Link
                  href={row.original.alert.href}
                  className="inline-block max-w-64 whitespace-normal text-xs underline"
                >
                  {row.original.alert.label}
                </Link>
              ) : row.original.alertKey ? (
                "原提醒不可用"
              ) : (
                "—"
              ),
          },
          {
            id: "journal",
            header: "交易日志",
            cell: ({ row }) => <TradeJournalEditor tradeId={row.original.id} />,
          },
          {
            id: "actions",
            header: "操作",
            cell: ({ row }) => {
              const t = row.original;
              return t.kind === "paper" ? (
                "纸面归属固定"
              ) : (
                <div className="flex flex-wrap gap-1">
                  {d.suggestions
                    .find((s) => s.tradeId === t.id)
                    ?.plans.map((plan) => (
                      <Button
                        key={plan.id}
                        size="sm"
                        variant="outline"
                        disabled={pending || readError}
                        onClick={() =>
                          void save(
                            {
                              tradeId: t.id,
                              planId: plan.id,
                              alertKey: plan.triggerKey,
                              strategyId: plan.strategyId,
                              strategyVersion: plan.strategyVersion,
                              sleeve: plan.sleeve,
                            },
                            snapshot(t),
                            "suggestion",
                          )
                        }
                      >
                        确认关联 {plan.strategyId} / {plan.id}
                      </Button>
                    ))}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending || readError}
                    onClick={() => {
                      if (pendingRef.current) return;
                      setManualResult(null);
                      setManualTrade(t);
                    }}
                  >
                    手工关联
                  </Button>
                </div>
              );
            },
          },
        ]}
      />
      <Dialog
        open={!!manualTrade}
        onOpenChange={(open) => {
          // Esc, overlay and the close button cannot drop the draft while the
          // single request is in flight.
          if (!open && !pendingRef.current) setManualTrade(null);
        }}
      >
        <DialogContent>
          <DialogTitle>手工关联成交来源</DialogTitle>
          <DialogDescription>
            仅保存来源及审计，不修改原始成交。
          </DialogDescription>
          {manualTrade ? (
            <TradeLinkForm
              key={manualTrade.id}
              trade={manualTrade}
              pending={pending}
              onSave={(input) =>
                void save(input, snapshot(manualTrade), "manual")
              }
            />
          ) : null}
          {manualResult &&
            ("error" in manualResult ? (
              <p role="alert">{manualResult.error}</p>
            ) : (
              <TradeLinkReceipt
                link={manualResult.link}
                trade={manualResult.trade}
              />
            ))}
        </DialogContent>
      </Dialog>
      {suggestionFeedback && <p role="alert">{suggestionFeedback}</p>}
      {/* Only one success summary is visible: the dialog hides the list one. */}
      {receipt && !manualTrade && (
        <TradeLinkReceipt
          link={receipt.link}
          trade={receipt.trade}
          prefix="最近一次："
        />
      )}
    </section>
  );
}
/** Same receipt for the dialog and the list; the response tradeId keeps
 * same-day, same-symbol, same-side trades distinguishable (it may wrap). */
function TradeLinkReceipt({
  link,
  trade,
  prefix,
}: {
  link: TradeLink;
  trade: TradeSnapshot;
  prefix?: string;
}) {
  const text = tradeLinkReceiptText(link, trade);
  const copyText = `关联已保存，审计记录保留。${text}`;
  // The list reuses this component while the receipt object changes. Stamp
  // copy feedback with the confirmed response identity so an in-flight copy
  // from a previous receipt can never report on the current one.
  const identity = JSON.stringify([
    link.tradeId,
    link.linkedAt,
    link.strategyId,
    link.strategyVersion,
    link.sleeve,
    link.planId,
    link.alertKey,
    trade.symbol,
    trade.date,
    trade.side,
  ]);
  const [feedback, setFeedback] = useState<{
    identity: string;
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const attempt = useRef(0);
  const shown = feedback?.identity === identity ? feedback : null;
  const copy = async () => {
    const current = ++attempt.current;
    const clipboard =
      typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard?.writeText) {
      setFeedback({
        identity,
        kind: "error",
        message: "剪贴板不可用，请手动选择上方回执文本。",
      });
      return;
    }
    try {
      await clipboard.writeText(copyText);
      if (attempt.current === current)
        setFeedback({ identity, kind: "success", message: "已复制关联回执。" });
    } catch (error) {
      if (attempt.current !== current) return;
      const reason =
        error instanceof Error && error.message
          ? error.message
          : "剪贴板不可用";
      setFeedback({
        identity,
        kind: "error",
        message: `复制失败：${reason}。请手动选择上方回执文本。`,
      });
    }
  };
  return (
    <div className="space-y-1">
      <p role="status" className="break-all">
        关联已保存，审计记录保留。{prefix}
        {text}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void copy()}
        >
          复制关联回执
        </Button>
        {shown ? (
          shown.kind === "success" ? (
            <p role="status">{shown.message}</p>
          ) : (
            <p role="alert">{shown.message}</p>
          )
        ) : null}
      </div>
    </div>
  );
}
function TradeLinkForm({
  trade: t,
  pending,
  onSave,
}: {
  trade: AccountTrade;
  pending: boolean;
  onSave: (input: TradeLinkInput) => void;
}) {
  const [alert, setAlert] = useState(t.alertKey ?? "");
  const events = api.alertHistory.useQuery({
    symbol: t.symbol,
    to: t.date.slice(0, 10),
    size: 100,
  });
  const options = (events.data?.items ?? [])
    .filter((e) => e.observedAt <= t.time)
    .map((e) => alertReference(e));
  if (t.alert && !options.some((e) => e.key === t.alert?.key))
    options.unshift(t.alert);
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        onSave({
          tradeId: t.id,
          strategyId: String(f.get("strategy")),
          strategyVersion: Number(f.get("version")),
          sleeve: String(f.get("sleeve")),
          planId: String(f.get("plan")) || null,
          alertKey: alert || null,
        });
      }}
    >
      {[
        { name: "strategy", label: "策略ID", value: t.strategyId },
        { name: "version", label: "策略版本", value: t.strategyVersion ?? 1 },
        { name: "sleeve", label: "分仓ID", value: t.sleeve },
        { name: "plan", label: "计划ID（可空）", value: t.planId },
      ].map((f) => (
        <label key={f.name}>
          {f.label}
          <Input name={f.name} defaultValue={f.value ?? ""} />
        </label>
      ))}
      <LedgerSelect
        label="关联提醒"
        value={alert}
        onChange={setAlert}
        options={[
          { value: "all", label: "无提醒" },
          ...options.map((e) => ({ value: e.key, label: e.label })),
        ]}
      />
      {events.error && <p role="alert">{events.error.message}</p>}
      <Button disabled={pending}>保存人工关联</Button>
    </form>
  );
}
function AccountTrades() {
  const search = useSearchParams(),
    [page, setPage] = useState(0),
    [symbol, setSymbol] = useState(search.get("symbol") ?? ""),
    [kind, setKind] = useState<
      "real" | "paper" | "exchange-simulation" | "all"
    >("real");
  const query = api.accountTrades.useQuery({
    page,
    symbol,
    kind,
    tradeId: search.get("trade") ?? undefined,
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
          { value: "all", label: "全部" },
        ]}
        onChange={(v) => {
          setKind(v);
          setPage(0);
        }}
      />
      <Input
        aria-label="成交品种筛选"
        value={symbol}
        onChange={(e) => {
          setSymbol(e.target.value);
          setPage(0);
        }}
        placeholder="证券代码或币对"
        className="max-w-56"
      />
      {query.error && <p role="alert">{query.error.message}</p>}
      {query.isLoading && <p role="status">正在读取成交…</p>}
      <TradeSources
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

function AttributionRows({
  rows,
}: {
  rows: RouterOutputs["accountAttribution"];
}) {
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <article
          key={`${r.strategyId}:${r.version}`}
          className="space-y-2 rounded border p-3"
        >
          <h4>
            {r.strategyId} v{r.version} · {r.market}/{r.sleeve}
          </h4>
          <p className={r.flagged ? "text-nc-bad" : "text-nc-text-2"}>
            {r.flagged ? "衰减已标记" : "未标记衰减"}
          </p>
          <p>
            回测期望：{r.expected?.samples.length ?? 0} 个同参数样本；
            {r.expected?.source ??
              r.expectationReason ??
              "缺少同期限冻结分布，不用不等长历史窗口冒充"}
          </p>
          {(["alerts", "paper", "actual", "simulation"] as const).map(
            (key, i) => (
              <p key={key}>
                {["提醒前推", "纸面前推", "用户实际", "模拟场所"][i]}：
                {r[key].observedSamples} 样本 · 中位 {pct(r[key].median)} ·
                期望P{formatNumber(r[key].percentile * 100, 0)}{" "}
                {pct(r[key].threshold)} ·{" "}
                {r[key].flagged
                  ? "衰减"
                  : r[key].enough
                    ? "未偏离"
                    : r[key].reason}
              </p>
            ),
          )}
          <p className="text-xs text-nc-text-3">{r.basis}</p>
        </article>
      ))}
    </div>
  );
}
function AccountAttribution() {
  const query = api.accountAttribution.useQuery();
  return (
    <section className="space-y-4">
      <h2>策略 / 分仓三方对比</h2>
      <p>
        同版本同定义的二十市场日入场期望在登记、影子或晋级时自动冻结。缺真实成交/原价及完整来源哈希时保持不可用，不用窗口汇总补造；与前推符合度的交易收益分布分开。
      </p>
      {query.error && <p role="alert">{query.error.message}</p>}
      <AttributionRows rows={query.data ?? []} />
    </section>
  );
}
function MonthlyReview() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7)),
    query = api.accountMonthlyReview.useQuery(month);
  return (
    <section className="space-y-4">
      <h2>月度纪律自查</h2>
      <Input
        type="month"
        aria-label="自查月份"
        value={month}
        onChange={(e) => setMonth(e.target.value)}
        className="max-w-56"
      />
      <p>{query.data?.notice}</p>
      {query.error && <p role="alert">{query.error.message}</p>}
      {query.data?.unavailable.map((r, i) => (
        <p key={`${r.account}:${r.security}:${i}`}>
          {r.account} / {r.security}：{r.reason}
        </p>
      ))}
      <p>
        未计划交易 {query.data?.unlinked ?? "—"} 个回合 · 已关联计划{" "}
        {query.data?.rounds.planned ?? "—"} 个回合 · 未知开仓{" "}
        {query.data?.rounds.unknownOpening ?? "—"} 个回合（单列，不当作守纪）。
        金额覆盖沪深 CNY；crypto 仅计回合，来源顺序不足另列未覆盖证据。
      </p>
      {query.data?.items.map((r) => (
        <article key={`${r.account}:${r.kind}`} className="rounded border p-3">
          <h3>
            {r.account} ·{" "}
            {
              { stop: "跌破止损仍持有", oversize: "超仓", chase: "追高" }[
                r.kind as "stop" | "oversize" | "chase"
              ]
            }
          </h3>
          <p>
            {r.count} 次 · 实际回合盈亏 {formatNumber(r.actual)} CNY · 按纪律{" "}
            {formatNumber(r.counterfactual)} CNY · 金额改善{" "}
            {formatNumber(r.impact)} CNY
          </p>
          <p>{r.reason}</p>
          <p className="text-xs text-nc-text-3">{r.basis}</p>
        </article>
      ))}
      <Link href="/accounts/review" className="underline">
        交割单现金逐日核对、原有纪律网格与详细归因
      </Link>
    </section>
  );
}
