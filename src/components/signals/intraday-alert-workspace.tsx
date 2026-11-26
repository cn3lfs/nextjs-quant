"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  BellRinging,
  CheckCircle,
  PlayCircle,
  Plus,
  Trash,
  Warning,
} from "@phosphor-icons/react/ssr";
import { formatNumber } from "trading-strategy-core/format-number";
import { accountKindLabels } from "~/lib/portfolio/account-workspace";
import { alertModeLabel } from "~/lib/common/ui-glossary";
import { chinaDate } from "~/lib/market/security-trading-status";
import type {
  IntradayAlertConfig,
  IntradayAlertStatus,
  IntradayTriggerEvent,
  IntradayWatchRule,
  IntradayWatchRuleInput,
} from "~/lib/strategy-facts/intraday-alerts";
import { api } from "~/trpc/react";
import { Panel, Pill, StateBanner } from "../panels";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

/** 用户可选的轮询节流间隔（秒）。 */
const intradayPollIntervals = [15, 30, 60, 120, 300] as const;

const intradaySessionLabels = {
  trading: "交易中",
  "lunch-break": "午休",
  closed: "休市",
} as const;

const intradayTriggerLabels: Record<
  IntradayTriggerEvent["triggerKind"],
  string
> = {
  stop_loss: "触及止损",
  take_profit: "触及目标价",
  planned_entry: "触及计划入场价",
  watch_above: "上穿自定义阈值",
  watch_below: "下破自定义阈值",
};

const quoteStatusLabels = {
  fresh: "报价实时",
  stale: "报价已过期",
  missing: "缺少报价",
} as const;

type IntradayRuleDraft = {
  id?: string;
  symbol: string;
  direction: "above" | "below";
  thresholdPrice: string;
  note: string;
  enabled: boolean;
};

const emptyIntradayRuleDraft: IntradayRuleDraft = {
  symbol: "",
  direction: "above",
  thresholdPrice: "",
  note: "",
  enabled: true,
};

function parseIntradayRuleDraft(
  draft: IntradayRuleDraft,
): { ok: true; input: IntradayWatchRuleInput } | { ok: false; error: string } {
  const symbol = draft.symbol.trim().toLowerCase();
  if (!/^(sh|sz|bj)\d{6}$/.test(symbol))
    return { ok: false, error: "证券代码需为 sh / sz / bj 加 6 位数字。" };
  const thresholdPrice = Number(draft.thresholdPrice);
  if (!Number.isFinite(thresholdPrice) || thresholdPrice <= 0)
    return { ok: false, error: "触发价需为大于零的数字。" };
  return {
    ok: true,
    input: {
      ...(draft.id ? { id: draft.id } : {}),
      symbol,
      direction: draft.direction,
      thresholdPrice,
      enabled: draft.enabled,
      note: draft.note.trim(),
    },
  };
}

function ruleDraftFrom(rule: IntradayWatchRule): IntradayRuleDraft {
  return {
    id: rule.id,
    symbol: rule.symbol,
    direction: rule.direction,
    thresholdPrice: String(rule.thresholdPrice),
    note: rule.note,
    enabled: rule.enabled,
  };
}

const beijingTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function timeLabel(value: number | null): string {
  return value === null ? "尚未检测" : beijingTime.format(value);
}

function percentDistance(distance: number | null, price: number | null) {
  if (distance === null || price === null || price <= 0) return "—";
  const pct = (distance / price) * 100;
  return `${pct > 0 ? "+" : ""}${formatNumber(pct, 2)}%`;
}

export function IntradayAlertWorkspace() {
  const search = useSearchParams();
  const symbol = search.get("symbol")?.trim().toLowerCase() ?? "";
  return <IntradayAlertSettings key={symbol} symbol={symbol} />;
}

function IntradayAlertSettings({ symbol }: { symbol: string }) {
  const utils = api.useUtils();
  const overview = api.intradayAlertOverview.useQuery(undefined, {
    retry: false,
    refetchInterval: ({ state }) =>
      Math.max(15, state.data?.config.pollIntervalSec ?? 30) * 1_000,
  });
  const alertStatus = api.alertStatus.useQuery(undefined, {
    retry: false,
  });
  const [configDraft, setConfigDraft] = useState<IntradayAlertConfig | null>(
    null,
  );
  const [ruleDraft, setRuleDraft] = useState<IntradayRuleDraft>(() => {
    return /^(sh|sz|bj)\d{6}$/.test(symbol)
      ? { ...emptyIntradayRuleDraft, symbol }
      : emptyIntradayRuleDraft;
  });
  const [message, setMessage] = useState("");
  const [ruleError, setRuleError] = useState("");

  const saveConfig = api.intradayAlertConfigSave.useMutation({
    onSuccess: (saved) => {
      utils.intradayAlertOverview.setData(
        undefined,
        (previous) => previous && { ...previous, config: saved },
      );
      setConfigDraft(null);
      setMessage(saved.enabled ? "盘中预警设置已保存。" : "盘中预警已关闭。");
      return utils.intradayAlertOverview.invalidate();
    },
  });
  const runNow = api.intradayAlertRunNow.useMutation({
    onSuccess: ({ result, snapshot }) => {
      utils.intradayAlertOverview.setData(undefined, snapshot);
      setMessage(
        {
          checked: "检测完成，结果已更新。",
          "no-targets": "没有需要检测的标的。",
          disabled: "盘中预警已关闭，请先开启并保存。",
          off: "提醒总开关已关闭，请先到提醒设置开启。",
          closed: "当前休市，本次未检测。",
          "lunch-break": "当前午休，本次未检测。",
          throttled: "检测间隔未到，本次未检测。",
        }[result],
      );
    },
  });
  const saveRule = api.intradayWatchRuleSave.useMutation({
    onSuccess: () => {
      setRuleError("");
      setMessage("价格阈值规则已保存。");
      return utils.intradayAlertOverview.invalidate();
    },
    onError: (error) => setRuleError(error.message),
  });
  const deleteRule = api.intradayWatchRuleDelete.useMutation({
    onSuccess: () => {
      setRuleError("");
      setMessage("价格阈值规则已删除。");
      return utils.intradayAlertOverview.invalidate();
    },
    onError: (error) => setRuleError(error.message),
  });

  function submitRule(fields: FormData) {
    const parsed = parseIntradayRuleDraft({
      ...ruleDraft,
      symbol: String(fields.get("symbol") ?? ""),
      thresholdPrice: String(fields.get("thresholdPrice") ?? ""),
      note: String(fields.get("note") ?? ""),
    });
    if (!parsed.ok) {
      setRuleError(parsed.error);
      return;
    }
    setRuleError("");
    saveRule.mutate(parsed.input, {
      onSuccess: () => setRuleDraft(emptyIntradayRuleDraft),
    });
  }

  function toggleRule(rule: IntradayWatchRule) {
    saveRule.mutate({
      id: rule.id,
      symbol: rule.symbol,
      direction: rule.direction,
      thresholdPrice: rule.thresholdPrice,
      note: rule.note,
      enabled: !rule.enabled,
    });
  }

  if (!overview.data && overview.error)
    return (
      <StateBanner
        state="error"
        title="盘中预警读取失败"
        action={{ label: "重试", onClick: () => void overview.refetch() }}
      >
        {overview.error.message}
      </StateBanner>
    );
  if (!overview.data)
    return (
      <p role="status" className="text-sm text-nc-text-3">
        正在读取盘中预警状态…
      </p>
    );

  const savedConfig = overview.data.config;
  const config = configDraft ?? savedConfig;
  const configBusy = saveConfig.isPending || runNow.isPending;
  return (
    <IntradayAlertView
      status={overview.data}
      alertMode={alertStatus.data?.mode}
      config={config}
      configSaving={saveConfig.isPending}
      configBusy={configBusy}
      onConfigChange={(patch) =>
        setConfigDraft((previous) => ({
          ...(previous ?? savedConfig),
          ...patch,
        }))
      }
      onSaveConfig={() => {
        setMessage("");
        runNow.reset();
        saveConfig.mutate(config);
      }}
      running={runNow.isPending}
      onRunNow={() => {
        setMessage("");
        saveConfig.reset();
        runNow.mutate();
      }}
      ruleDraft={ruleDraft}
      onRuleDraftChange={(patch) =>
        setRuleDraft((previous) => ({ ...previous, ...patch }))
      }
      onSubmitRule={submitRule}
      onCancelRule={() => {
        setRuleDraft(emptyIntradayRuleDraft);
        setRuleError("");
      }}
      onEditRule={(rule) => {
        setRuleError("");
        setRuleDraft(ruleDraftFrom(rule));
      }}
      onToggleRule={toggleRule}
      onDeleteRule={(id) =>
        deleteRule.mutate(
          { id },
          {
            onSuccess: () =>
              setRuleDraft((draft) =>
                draft.id === id ? emptyIntradayRuleDraft : draft,
              ),
          },
        )
      }
      ruleSaving={saveRule.isPending || deleteRule.isPending}
      ruleError={ruleError}
      refreshFailed={overview.isError}
      message={
        message || saveConfig.error?.message || runNow.error?.message || ""
      }
    />
  );
}

type IntradayAlertViewProps = {
  status: IntradayAlertStatus;
  /** Global alert mode: `shadow` renders 空跑观察, `live` renders 正式提醒. */
  alertMode?: string;
  config: IntradayAlertConfig;
  configSaving: boolean;
  configBusy: boolean;
  onConfigChange: (patch: Partial<IntradayAlertConfig>) => void;
  onSaveConfig: () => void;
  running: boolean;
  onRunNow: () => void;
  ruleDraft: IntradayRuleDraft;
  onRuleDraftChange: (patch: Partial<IntradayRuleDraft>) => void;
  onSubmitRule: (fields: FormData) => void;
  onCancelRule: () => void;
  onEditRule: (rule: IntradayWatchRule) => void;
  onToggleRule: (rule: IntradayWatchRule) => void;
  onDeleteRule: (id: string) => void;
  ruleSaving: boolean;
  ruleError: string;
  refreshFailed: boolean;
  message: string;
};

function IntradayAlertView({
  status,
  alertMode,
  config,
  configSaving,
  configBusy,
  onConfigChange,
  onSaveConfig,
  running,
  onRunNow,
  ruleDraft,
  onRuleDraftChange,
  onSubmitRule,
  onCancelRule,
  onEditRule,
  onToggleRule,
  onDeleteRule,
  ruleSaving,
  ruleError,
  refreshFailed,
  message,
}: IntradayAlertViewProps) {
  const last = status.lastResult;
  const today = chinaDate(Date.now());
  return (
    <div className="space-y-4">
      <Panel
        icon={BellRinging}
        title="预警运行状态"
        meta={
          status.config.enabled
            ? `每 ${status.config.pollIntervalSec} 秒检测`
            : "已关闭"
        }
        note="盘中预警只记录和提醒，不会自动下单。模拟成交需人工预览确认。"
        actions={
          <Button
            type="button"
            size="sm"
            disabled={configBusy || !status.config.enabled}
            title={
              status.config.enabled ? undefined : "先开启并保存盘中预警总开关"
            }
            onClick={onRunNow}
          >
            <PlayCircle size={14} aria-hidden="true" />
            {running ? "正在检测…" : "立即检测一次"}
          </Button>
        }
        bodyClassName="space-y-3"
      >
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="nc-status-chip" data-state="idle">
            交易时段：{intradaySessionLabels[status.session]}
          </span>
          <span className="nc-status-chip" data-state="ok">
            最近检测：{timeLabel(status.lastCheckedAt)}
          </span>
          <Pill tone={alertMode === "live" ? "warn" : "idle"}>
            {alertMode ? alertModeLabel(alertMode) : "提醒状态未读取"}
          </Pill>
          <span className="text-sub text-nc-text-3">
            监控 {status.monitoredSymbolCount} 只 · 规则 {status.rules.length}{" "}
            条
          </span>
        </div>
        {refreshFailed && (
          <StateBanner state="warn" title="预警状态更新失败" hideIcon>
            下方显示上次读取的结果。
          </StateBanner>
        )}
        {last && (
          <p className="text-sub text-nc-text-3">
            上次结果：实时 {last.freshCount} · 过期 {last.staleCount} · 缺失{" "}
            {last.missingCount} · 触发 {last.triggeredCount}
            {status.lastQuoteSource
              ? ` · 报价源 ${status.lastQuoteSource}`
              : ""}
          </p>
        )}
        {last?.status === "no-targets" && (
          <StateBanner state="info" title="当前没有需要监控的标的" hideIcon>
            可在下方开启监控项，或添加自定义价格阈值规则。
          </StateBanner>
        )}
        {last?.status === "error" && (
          <StateBanner state="warn" title="上次检测未完成">
            行情或账本读取异常，系统会在下一次轮询重试；不会补造价格。
          </StateBanner>
        )}
        {message && (
          <p role="status" className="text-sub text-nc-text-3">
            {message}
          </p>
        )}
      </Panel>

      <Panel
        title="预警开关与轮询"
        icon={Warning}
        meta="保存后生效"
        bodyClassName="space-y-3"
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex items-center gap-2 rounded-lg border border-nc-border-soft bg-nc-inset px-3 py-2 text-sm">
            <Checkbox
              aria-label="开启盘中预警"
              checked={config.enabled}
              disabled={configBusy}
              onCheckedChange={(checked) =>
                onConfigChange({ enabled: checked === true })
              }
            />
            <span>开启盘中预警总开关</span>
          </label>
          <label className="flex flex-wrap items-center gap-2 rounded-lg border border-nc-border-soft bg-nc-inset px-3 py-2 text-sm">
            <span>轮询节流间隔</span>
            <Select
              value={String(config.pollIntervalSec)}
              disabled={configBusy}
              onValueChange={(value) =>
                onConfigChange({ pollIntervalSec: Number(value) })
              }
            >
              <SelectTrigger aria-label="轮询节流间隔" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {intradayPollIntervals.map((seconds) => (
                  <SelectItem key={seconds} value={String(seconds)}>
                    {seconds} 秒
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>
        <fieldset disabled={configBusy} className="grid gap-2 sm:grid-cols-2">
          <legend className="mb-1 text-sm font-medium text-nc-text">
            监控项
          </legend>
          {(
            [
              [
                "monitorHoldingsStops",
                "持仓止损与目标价",
                "统一账本持仓（含模拟盘）触及止损或目标价时提醒。",
              ],
              [
                "monitorPlannedEntries",
                "进行中计划的入场价",
                "人工计划与提醒计划触及入场价时提醒。",
              ],
              [
                "monitorWatchlistRules",
                "自选价格阈值规则",
                "下方自定义的上穿 / 下破规则。",
              ],
              [
                "intradayScanEnabled",
                "午间 / 尾盘盘中扫描",
                "午休与尾盘各补扫一次，避免漏掉盘中异动。",
              ],
            ] as const
          ).map(([key, label, detail]) => (
            <label
              key={key}
              className="flex items-start gap-2 rounded-lg border border-nc-border-soft px-3 py-2 text-sm"
            >
              <Checkbox
                aria-label={label}
                checked={config[key]}
                onCheckedChange={(checked) =>
                  onConfigChange({ [key]: checked === true })
                }
              />
              <span>
                <span className="block text-nc-text">{label}</span>
                <span className="block text-sub text-nc-text-3">{detail}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={configBusy}
            onClick={onSaveConfig}
          >
            {configSaving ? "正在保存…" : "保存预警设置"}
          </Button>
          <span className="text-sub text-nc-text-4">
            提醒只推送，不生成真实委托。
          </span>
        </div>
      </Panel>

      <Panel
        title="实时监控总览"
        icon={CheckCircle}
        meta={`${status.holdings.length} 笔持仓`}
        note="距离百分比按当前价计算；负值表示已经越过止损或目标价。"
        bodyClassName="space-y-2"
      >
        {status.holdings.length === 0 ? (
          <StateBanner state="empty" title="当前没有受监控的持仓" hideIcon>
            在统一账本或本地模拟盘建仓后，这里会自动列出。
          </StateBanner>
        ) : (
          <ul className="divide-y divide-nc-border-soft">
            {status.holdings.map((holding) => (
              <li
                key={holding.positionId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
              >
                <Link
                  href={`/scan?symbol=${encodeURIComponent(holding.symbol)}`}
                  className="min-w-24 font-medium text-nc-text underline underline-offset-2"
                >
                  {holding.symbol.toUpperCase()}
                </Link>
                <span className="text-sub text-nc-text-3">
                  {accountKindLabels[holding.kind] ?? holding.kind} ·{" "}
                  {holding.account || "未命名账户"}
                </span>
                <span className="tabular-nums text-nc-text-2">
                  现价 {formatNumber(holding.price, 2)}
                </span>
                <span className="tabular-nums text-nc-text-3">
                  止损 {formatNumber(holding.stopPrice, 2)} · 距止损{" "}
                  {percentDistance(holding.distanceToStop, holding.price)}
                </span>
                <span className="tabular-nums text-nc-text-3">
                  目标 {formatNumber(holding.targetPrice, 2)} · 距目标{" "}
                  {percentDistance(holding.distanceToTarget, holding.price)}
                </span>
                <Pill
                  tone={
                    holding.quoteStatus === "fresh"
                      ? "ok"
                      : holding.quoteStatus === "stale"
                        ? "warn"
                        : "bad"
                  }
                >
                  {quoteStatusLabels[holding.quoteStatus]}
                </Pill>
              </li>
            ))}
          </ul>
        )}
        <section aria-label="最近盘中触发" className="space-y-1 pt-2">
          <h4 className="m-0 text-sm font-semibold text-nc-text">
            最近盘中触发
          </h4>
          {status.recentEvents.length === 0 ? (
            <p className="text-sub text-nc-text-3">暂无盘中触发记录。</p>
          ) : (
            <ul className="divide-y divide-nc-border-soft">
              {status.recentEvents.map((event) => (
                <li
                  key={`${event.alertKey}:${event.observedAt}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-sub"
                >
                  <span className="text-nc-text-4">盘中实时</span>
                  <span className="text-nc-text-4">
                    {beijingTime.format(event.quoteAt)}
                  </span>
                  <Link
                    href={`/scan?symbol=${encodeURIComponent(event.symbol)}`}
                    className="font-medium text-nc-text underline underline-offset-2"
                  >
                    {event.symbol.toUpperCase()}
                  </Link>
                  <Pill tone="warn">
                    {intradayTriggerLabels[event.triggerKind]}
                  </Pill>
                  <span className="tabular-nums text-nc-text-3">
                    阈值 {formatNumber(event.thresholdPrice, 2)} · 现价{" "}
                    {formatNumber(event.price, 2)}
                  </span>
                  <span className="text-nc-text-4">
                    {alertModeLabel(event.mode)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </Panel>

      <Panel
        title="自定义价格阈值规则"
        icon={Plus}
        meta={`${status.rules.length} 条`}
        note="上穿 / 下破只在盘中实时报价确认时触发；同一规则每个交易日最多提醒一次。"
        bodyClassName="space-y-3"
      >
        <form
          aria-label="价格阈值规则"
          className="flex flex-wrap items-end gap-2 rounded-lg border border-nc-border-soft bg-nc-inset px-3 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmitRule(new FormData(event.currentTarget));
          }}
        >
          <label className="space-y-1 text-sub text-nc-text-3">
            <span>证券代码</span>
            <Input
              aria-label="预警规则证券代码"
              name="symbol"
              disabled={ruleSaving}
              className="w-32"
              placeholder="sh600000"
              value={ruleDraft.symbol}
              onChange={(event) =>
                onRuleDraftChange({ symbol: event.target.value })
              }
            />
          </label>
          <label className="space-y-1 text-sub text-nc-text-3">
            <span>方向</span>
            <Select
              value={ruleDraft.direction}
              disabled={ruleSaving}
              onValueChange={(value) =>
                onRuleDraftChange({
                  direction: value === "below" ? "below" : "above",
                })
              }
            >
              <SelectTrigger aria-label="预警规则方向" className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="above">上穿</SelectItem>
                <SelectItem value="below">下破</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="space-y-1 text-sub text-nc-text-3">
            <span>触发价</span>
            <Input
              aria-label="预警规则触发价"
              name="thresholdPrice"
              disabled={ruleSaving}
              className="w-28"
              inputMode="decimal"
              placeholder="11.20"
              value={ruleDraft.thresholdPrice}
              onChange={(event) =>
                onRuleDraftChange({ thresholdPrice: event.target.value })
              }
            />
          </label>
          <label className="min-w-40 flex-1 space-y-1 text-sub text-nc-text-3">
            <span>备注（可选）</span>
            <Input
              aria-label="预警规则备注"
              name="note"
              disabled={ruleSaving}
              value={ruleDraft.note}
              onChange={(event) =>
                onRuleDraftChange({ note: event.target.value })
              }
            />
          </label>
          <Button type="submit" size="sm" disabled={ruleSaving}>
            {ruleDraft.id ? "保存修改" : "新增规则"}
          </Button>
          {ruleDraft.id && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={ruleSaving}
              onClick={onCancelRule}
            >
              取消编辑
            </Button>
          )}
        </form>
        {ruleError && (
          <p role="alert" className="text-sub text-nc-bad">
            {ruleError}
          </p>
        )}
        {status.rules.length === 0 ? (
          <p className="text-sub text-nc-text-3">
            还没有自定义规则。添加后，盘中价格上穿或下破触发价时会提醒。
          </p>
        ) : (
          <ul className="divide-y divide-nc-border-soft">
            {status.rules.map((rule) => (
              <li
                key={rule.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
              >
                <Checkbox
                  aria-label={`${rule.enabled ? "停用" : "启用"} ${rule.symbol} 规则`}
                  checked={rule.enabled}
                  disabled={ruleSaving}
                  onCheckedChange={() => onToggleRule(rule)}
                />
                <Link
                  href={`/scan?symbol=${encodeURIComponent(rule.symbol)}`}
                  className="min-w-24 font-medium text-nc-text underline underline-offset-2"
                >
                  {rule.symbol.toUpperCase()}
                </Link>
                <Pill tone={rule.direction === "above" ? "ok" : "warn"}>
                  {rule.direction === "above" ? "上穿" : "下破"}
                </Pill>
                <span className="tabular-nums text-nc-text-2">
                  {formatNumber(rule.thresholdPrice, 2)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sub text-nc-text-3">
                  {rule.note || "—"}
                </span>
                <span className="text-sub text-nc-text-4">
                  {rule.lastTriggeredDate === today
                    ? "今日已触发"
                    : rule.lastTriggeredDate
                      ? `今日未触发 · 上次 ${rule.lastTriggeredDate}`
                      : "今日未触发"}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={ruleSaving}
                  onClick={() => onEditRule(rule)}
                >
                  编辑
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`删除 ${rule.symbol} 价格阈值规则`}
                  disabled={ruleSaving}
                  onClick={() => onDeleteRule(rule.id)}
                >
                  <Trash size={14} aria-hidden="true" />
                  删除
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
