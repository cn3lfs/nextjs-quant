"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import { api, type RouterOutputs } from "~/trpc/react";
import {
  accountKindLabels,
  tradeLinkReceiptText,
  type TradeLink,
} from "~/lib/portfolio/account-workspace";
import { formatNumber } from "trading-strategy-core/format-number";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../../ui/dialog";
import { LedgerSelect } from "../../signals/ledger-fields";
import { alertReference } from "~/lib/strategy-facts/alert-reference";
import { Input } from "../../ui/input";
import { DataTable } from "../../ui/data-table";
import { TradeJournalEditor } from "../account-review-panels";
import {
  type AccountTrade,
  type TradeLinkInput,
  type TradeSnapshot,
} from "./shared";

export function TradeSources({
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
      <p className="text-sm text-nc-text-3">
        每笔成交可关联到所属策略、计划与提醒，便于复盘时对上账。关联只记录来源和审计，不修改成交数量、价格或原始账本。
      </p>
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
                "模拟盘成交，归属固定"
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
