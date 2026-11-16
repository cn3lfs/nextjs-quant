"use client";
import { useState } from "react";
import Link from "next/link";
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
import { formatNumber } from "trading-strategy-core/format-number";
import { accountKindLabels } from "~/lib/portfolio/account-workspace";
import { useScreenVisible } from "../workbench/use-task-visible";

export function BulkTradeLinks({ batchId }: { batchId?: string }) {
  const visible = useScreenVisible();
  const query = api.accountLinkSuggestions.useQuery(
    { batchId },
    { enabled: visible, retry: false },
  );
  const [selected, setSelected] = useState<Record<string, string>>({});
  const utils = api.useUtils();
  const save = api.confirmAccountLinks.useMutation({
    onSuccess: () =>
      Promise.all([
        utils.accountLinkSuggestions.invalidate(),
        utils.accountTrades.invalidate(),
        utils.accountPositions.invalidate(),
        utils.accountWeeklyReview.invalidate(),
      ]),
  });
  const choice = (row: NonNullable<typeof query.data>["items"][number]) =>
    selected[row.trade.id] ?? (row.plans.length === 1 ? row.plans[0]!.id : "");
  const links = (query.data?.items ?? [])
    .filter((row) => choice(row))
    .map((row) => ({
      tradeId: row.trade.id,
      fingerprint: row.fingerprint,
      planId: choice(row),
    }));
  return (
    <section className="space-y-3 rounded border p-3" aria-label="批量关联计划">
      <h3>导入与成交批量关联</h3>
      <p>{query.data?.notice}</p>
      {query.error && <p role="alert">{query.error.message}</p>}
      <p>
        待核对 {query.data?.total ?? "—"} 笔 · 当前选择 {links.length} 笔
      </p>
      {query.data?.items.map((row) => (
        <label key={row.trade.id} className="block rounded border p-2 text-sm">
          {row.trade.account} · {accountKindLabels[row.trade.kind]} ·{" "}
          {row.trade.date} · {row.trade.symbol} ·{" "}
          {row.trade.side === "buy" ? "买入" : "卖出"}{" "}
          {formatNumber(row.trade.quantity, 6)}
          <Select
            value={choice(row) || "__unlinked__"}
            onValueChange={(value) =>
              setSelected({
                ...selected,
                [row.trade.id]: value === "__unlinked__" ? "" : value,
              })
            }
          >
            <SelectTrigger
              className="mt-1 max-w-full"
              aria-label={`匹配计划 ${row.trade.id}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__unlinked__">
                暂不关联{row.ambiguous ? "，需人工选择" : ""}
              </SelectItem>
              {row.plans.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.strategyId} v{p.strategyVersion} · {p.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {row.reason && (
            <span className="block text-nc-text-3">{row.reason}</span>
          )}
        </label>
      ))}
      <div className="flex gap-2">
        <Button
          disabled={!query.data || !links.length || save.isPending}
          onClick={() => {
            if (query.data)
              save.mutate({
                confirmed: true,
                factVersion: query.data.factVersion,
                links,
              });
          }}
        >
          确认关联所选 {links.length} 笔
        </Button>
        <Button variant="outline" onClick={() => void query.refetch()}>
          刷新匹配
        </Button>
      </div>
      {save.error && <p role="alert">{save.error.message}</p>}
      {save.data && (
        <p role="status">已关联 {save.data.saved} 笔，原成交未改写。</p>
      )}
    </section>
  );
}

export function TradeJournalEditor({ tradeId }: { tradeId: string }) {
  const [open, setOpen] = useState(false),
    visible = useScreenVisible(),
    utils = api.useUtils();
  const query = api.accountJournalContext.useQuery(tradeId, {
    enabled: open && visible,
    retry: false,
  });
  const save = api.saveTradeJournal.useMutation({
    onSuccess: () =>
      Promise.all([
        utils.accountJournalContext.invalidate(tradeId),
        utils.accountWeeklyReview.invalidate(),
      ]),
  });
  return (
    <div className="space-y-2">
      <Button size="sm" variant="outline" onClick={() => setOpen(!open)}>
        交易日志
      </Button>
      {open && query.error && <p role="alert">{query.error.message}</p>}
      {open && query.data && (
        <form
          key={`${query.data.fingerprint}:${query.data.journal?.updatedAt ?? 0}`}
          className="space-y-2 rounded border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget),
              value = query.data;
            if (!value) return;
            save.mutate({
              tradeId,
              fingerprint: value.fingerprint,
              factVersion: value.factVersion,
              note: String(data.get("note") ?? ""),
              tags: [
                ...new Set(
                  String(data.get("tags") ?? "")
                    .split(/[,，]/)
                    .map((x) => x.trim())
                    .filter(Boolean),
                ),
              ],
              exitReason:
                value.trade.side === "sell"
                  ? (String(data.get("exitReason")) as
                      | "stop"
                      | "target"
                      | "time"
                      | "rule"
                      | "manual"
                      | "unknown")
                  : "unknown",
            });
          }}
        >
          {query.data.trade.side === "sell" && (
            <label>
              退出原因
              <Select
                name="exitReason"
                defaultValue={query.data.journal?.exitReason ?? "unknown"}
              >
                <SelectTrigger aria-label="退出原因">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unknown">未记录 / 未知</SelectItem>
                  <SelectItem value="stop">止损</SelectItem>
                  <SelectItem value="target">目标</SelectItem>
                  <SelectItem value="time">时间退出</SelectItem>
                  <SelectItem value="rule">策略规则退出</SelectItem>
                  <SelectItem value="manual">人工判断</SelectItem>
                </SelectContent>
              </Select>
            </label>
          )}
          <label>
            复盘记录
            <Input
              name="note"
              aria-label="复盘记录"
              maxLength={1000}
              defaultValue={query.data.journal?.note ?? ""}
            />
          </label>
          <label>
            标签（逗号分隔）
            <Input
              name="tags"
              aria-label="交易日志标签"
              defaultValue={query.data.journal?.tags.join(",") ?? ""}
            />
          </label>
          <Button size="sm" disabled={save.isPending}>
            保存日志
          </Button>
          {save.error && (
            <p role="alert">
              {save.error.message}{" "}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void query.refetch()}
              >
                重新核验
              </Button>
            </p>
          )}
          {save.isSuccess && <p role="status">已保存元数据，原成交保留。</p>}
        </form>
      )}
    </div>
  );
}

export function WeeklyReview() {
  const today = new Date(),
    monday = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() - ((today.getUTCDay() + 6) % 7),
      ),
    );
  const [from, setFrom] = useState(monday.toISOString().slice(0, 10)),
    visible = useScreenVisible();
  const query = api.accountWeeklyReview.useQuery(from, {
    enabled: visible,
    retry: false,
  });
  const pause = api.strategyLabAction.useMutation({
    onSuccess: () => query.refetch(),
  });
  return (
    <section className="space-y-4" aria-label="周度复盘">
      <h2>周度复盘与执行质量</h2>
      <label>
        起始日期
        <Input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          aria-label="周复盘起始日期"
          className="max-w-56"
        />
      </label>
      <p>{query.data?.notice}</p>
      {query.error && <p role="alert">{query.error.message}</p>}
      {query.data?.suggestions.map((s) => (
        <article key={s.id} className="space-y-2 rounded border p-3">
          <p>{s.reason}</p>
          {s.action === "pause-live" &&
          s.strategyId &&
          s.version &&
          s.revision ? (
            <Button
              disabled={pause.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    `确认暂停 ${s.strategyId} 的live提醒？影子观察与历史证据保留。`,
                  )
                )
                  pause.mutate({
                    id: s.strategyId!,
                    version: s.version!,
                    revision: s.revision!,
                    action: "pause-live",
                    confirmed: true,
                  });
              }}
            >
              暂停 live 提醒
            </Button>
          ) : s.href ? (
            <Link href={s.href} className="underline">
              核对资金与分仓
            </Link>
          ) : null}
        </article>
      ))}
      {pause.error && <p role="alert">{pause.error.message}</p>}
      {pause.isSuccess && <p role="status">已按确认暂停 live 提醒。</p>}
      {query.data?.riskUnknown.map((reason) => (
        <p key={reason}>{reason}</p>
      ))}
      <h3>提醒与未成交窗口</h3>
      {query.data?.execution.alerts.map((r) => (
        <p key={r.alertKey}>
          {r.symbol} · {r.observationOnly ? "仅影子/研究观察" : "live 提醒"} ·{" "}
          {r.status === "late"
            ? "迟到观察"
            : r.status === "skipped"
              ? "已取消计划"
              : "窗口结束未见关联成交"}{" "}
          · {r.reason}
        </p>
      ))}
      <p>{query.data?.execution.notice}</p>
      {query.data?.execution.rows.map((r) => (
        <article key={r.tradeId} className="space-y-1 rounded border p-3">
          <p>
            {r.account} · {accountKindLabels[r.kind]} · {r.date} · {r.symbol}{" "}
            {r.side === "buy" ? "买" : "卖"} {formatNumber(r.quantity, 6)}
          </p>
          <p>
            提醒价 {formatNumber(r.alertPrice)} → 计划价{" "}
            {formatNumber(r.planEntry)} → 成交价 {formatNumber(r.fillPrice)} ·
            提醒差 {formatNumber(r.alertToFillBps)} bp · 计划差{" "}
            {formatNumber(r.planToFillBps)} bp
          </p>
          <p>
            退出前保护价 {formatNumber(r.stop)} → 实际退出{" "}
            {r.side === "sell" ? formatNumber(r.fillPrice) : "—"} · 差额{" "}
            {formatNumber(r.stopToExitBps)} bp · 退出原因 {r.exitReason}
          </p>
          <p>
            {r.stopBasis} · {r.reason}
          </p>
          <TradeJournalEditor tradeId={r.tradeId} />
        </article>
      ))}
      <BulkTradeLinks />
    </section>
  );
}
