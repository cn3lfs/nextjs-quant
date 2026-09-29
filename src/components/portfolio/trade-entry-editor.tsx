"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import { tradeSignalOptionsSchema } from "~/lib/portfolio/trade-workspace";
import type {
  TradeDraft,
  TradeDraftFields,
  TradeAttempt,
} from "~/lib/portfolio/trade-workspace-draft";
import { feeLabel } from "~/lib/portfolio/trade-ledger";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import {
  TradeInputField,
  TradeSelect,
  TradeError,
} from "./trade-workspace-fields";
export function TradeEntryEditor({
  draft,
  attempt,
  busy,
  visible,
  error,
  onChange,
  onSave,
  onRetry,
  onNew,
  onLocate,
  onClose,
}: {
  draft: TradeDraft;
  attempt: TradeAttempt | null;
  busy: boolean;
  visible: boolean;
  error: string;
  onChange: (patch: Partial<TradeDraftFields>) => void;
  onSave: () => void;
  onRetry: () => void;
  onNew: () => void;
  onLocate: (id: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState(false),
    [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const f = draft.fields,
    valid = tradeSignalOptionsSchema.safeParse({
      symbol: f.symbol.trim(),
      date: f.date,
    });
  const signals = api.tradeWorkspaceSignals.useQuery(
    { symbol: f.symbol.trim(), date: f.date, cursor: cursors.at(-1) },
    {
      enabled: visible && search && valid.success,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      gcTime: 0,
      retry: false,
    },
  );
  const change = (key: keyof TradeDraftFields, value: string) => {
    onChange({ [key]: value });
    if (key === "symbol" || key === "date") {
      setSearch(false);
      setCursors([undefined]);
    }
  };
  return (
    <section aria-label="本地交易草稿" tabIndex={-1} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3>
          录入本地交易
          {draft.saved ? " · 已保存" : draft.dirty ? " · 未保存" : ""}
        </h3>
        <Button size="sm" variant="outline" onClick={onClose}>
          返回列表
        </Button>
      </div>
      <p className="text-xs text-nc-text-3">
        只追加本地事实；{feeLabel}。保存成功后核对原记录，再新增下一笔。
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
        className="space-y-4"
      >
        <fieldset
          disabled={draft.saved}
          className="grid grid-cols-2 gap-3 max-sm:grid-cols-1"
        >
          <TradeInputField
            label="证券代码"
            value={f.symbol}
            onChange={(value) => change("symbol", value)}
            maxLength={20}
          />
          <TradeInputField
            label="交易日期"
            type="date"
            value={f.date}
            onChange={(value) => change("date", value)}
          />
          <TradeSelect
            label="交易方向"
            value={f.side}
            onChange={(value) => change("side", value)}
            options={[
              { value: "buy", label: "买入" },
              { value: "sell", label: "卖出" },
            ]}
          />
          {(
            [
              ["price", "成交价格"],
              ["quantity", "成交股数（100的整数倍）"],
              ["lowerLimit", "当日跌停价"],
              ["upperLimit", "当日涨停价"],
              ["limitSource", "涨跌停依据"],
              ["stop", "止损价（可选）"],
            ] as const
          ).map(([key, label]) => (
            <TradeInputField
              key={key}
              label={label}
              value={f[key]}
              onChange={(value) => change(key, value)}
              maxLength={key === "limitSource" ? 200 : 40}
            />
          ))}
          <label className="col-span-full grid gap-1 text-sm">
            交易备注
            <Textarea
              aria-label="交易备注"
              className="min-h-20 rounded border border-nc-border-soft bg-nc-inset p-2"
              maxLength={500}
              value={f.note}
              onChange={(event) => change("note", event.target.value)}
            />
          </label>
        </fieldset>
        <div className="space-y-2">
          <p className="break-all text-sm">
            关联信号：{f.signalId || "无（手动交易）"}
          </p>
          <p className="text-xs text-nc-text-3">
            仅选择同证券且不晚于交易日期的信号；修改证券或日期后请重新核对已选信号，保存时服务端再次校验。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!valid.success || draft.saved}
              onClick={() => {
                setCursors([undefined]);
                setSearch(true);
              }}
            >
              查找可关联信号
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={!f.signalId || draft.saved}
              onClick={() => change("signalId", "")}
            >
              取消关联
            </Button>
          </div>
          {search && (
            <div aria-label="可关联信号" className="space-y-2">
              <TradeError
                error={signals.error?.message}
                onRetry={() => void signals.refetch()}
              />
              {signals.isLoading ? (
                <p>正在检索信号…</p>
              ) : signals.data?.items.length === 0 ? (
                <p>没有符合证券与日期的信号。</p>
              ) : (
                signals.data?.items.map((row) => (
                  <Button
                    type="button"
                    key={row.id}
                    size="sm"
                    variant={f.signalId === row.id ? "default" : "outline"}
                    className="h-auto w-full justify-start whitespace-normal break-all text-left"
                    disabled={draft.saved}
                    onClick={() => change("signalId", row.id)}
                  >
                    {row.date} · {row.strategy} · {row.id}
                  </Button>
                ))
              )}
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={cursors.length === 1}
                  onClick={() => setCursors(cursors.slice(0, -1))}
                >
                  上一页信号
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!signals.data?.nextCursor}
                  onClick={() =>
                    setCursors([...cursors, signals.data!.nextCursor!])
                  }
                >
                  下一页信号
                </Button>
              </div>
            </div>
          )}
        </div>
        <TradeError error={error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || draft.saved}>
            {busy ? "正在保存…" : "仅保存本地交易"}
          </Button>
          <Button type="button" variant="outline" onClick={onNew}>
            新增下一笔
          </Button>
        </div>
      </form>
      {attempt && (
        <div
          role="status"
          className="space-y-2 rounded border border-nc-border-soft p-3"
        >
          <p className="break-all">
            提交记录 {attempt.input.id}：{attempt.input.symbol} ·{" "}
            {attempt.input.quantity}股 × {attempt.input.price}
          </p>
          <p>
            {attempt.state === "saved"
              ? "已保存，可定位核对原始事实。"
              : attempt.state === "pending"
                ? "正在提交冻结输入；之后修改的草稿不会被该响应覆盖。"
                : attempt.error ||
                  "上次提交结果尚未确认，可用相同编号核对并重试。"}
          </p>
          {attempt.state === "saved" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onLocate(attempt.input.id)}
            >
              查看已保存交易
            </Button>
          ) : (
            attempt.state !== "pending" && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={onRetry}
              >
                重试这份提交（相同编号）
              </Button>
            )
          )}
        </div>
      )}
    </section>
  );
}
