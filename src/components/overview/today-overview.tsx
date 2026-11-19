"use client";
import { formatNumber } from "trading-strategy-core/format-number";

import {
  CheckCircle,
  Crosshair,
  Database,
  ChartBar,
  ListChecks,
  Newspaper,
  PaperPlaneTilt,
  Ranking,
  Star,
  Timer,
  WarningCircle,
  Lightning,
} from "@phosphor-icons/react/ssr";
import { type Icon } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type CSSProperties, useState } from "react";
import { cn } from "~/lib/common/classnames";
import { capabilityAllows } from "~/lib/common/capabilities";
import {
  beijingClock,
  dateLine,
  marketSession,
} from "~/lib/market/market-session";
import { api } from "~/trpc/react";
import {
  BarRows,
  GridTable,
  PageGrid,
  Panel,
  PanelEmpty,
  Pill,
  SecurityCell,
  Segmented,
  toneEdge,
  toneText,
  type Tone,
} from "../panels";
import { Button } from "../ui/button";
import { AlertStatus } from "../signals/alert-status";
import { useTaskVisible } from "../workbench/use-task-visible";
import { MarketBreadth } from "./market-breadth";
import {
  MarketPulse,
  quoteChange,
  useOverviewQuotes,
  WatchQuote,
} from "./market-pulse";
import { sortWatchSymbols, type WatchSort } from "./watch-sort";
import { useNow } from "../workbench/use-now";
import {
  axisPct,
  AXIS_END,
  AXIS_START,
  LUNCH_END,
  LUNCH_START,
  health,
  phaseOf,
  scheduleSummary,
  timeline,
  todos,
  type OverviewInput,
} from "./overview-model";

const dot: Record<Tone, string> = {
  neutral: "var(--nc-ok)",
  ok: "var(--nc-ok)",
  accent: "var(--nc-accent)",
  warn: "var(--nc-warn)",
  bad: "var(--nc-bad)",
  idle: "var(--nc-text-4)",
};
const healthIcon: Record<string, Icon> = {
  day: Database,
  "5m": ChartBar,
  rps: Ranking,
  schedule: Timer,
  channels: PaperPlaneTilt,
};
const todoIcon: Record<Tone, Icon> = {
  bad: WarningCircle,
  warn: WarningCircle,
  accent: Crosshair,
  ok: CheckCircle,
  neutral: CheckCircle,
  idle: ListChecks,
};
const deliveryLabel = {
  pending: ["待投递", "accent"],
  sending: ["投递中", "accent"],
  sent: ["已送达", "ok"],
  failed: ["失败", "bad"],
  expired: ["已过期", "idle"],
  cancelled: ["已取消", "idle"],
} as const;
const tradingLabel = {
  trading: ["已核验 · 正常交易", "ok"],
  suspended: ["停牌 · 已暂停", "warn"],
  unknown: ["状态未知 · 已暂停", "warn"],
} as const;

/**
 * 今日总览: the landing page. Everything shown comes from existing status
 * endpoints; the phase and next steps are derived from the current time.
 */
export function TodayOverview() {
  const visible = useTaskVisible();
  const search = useSearchParams();
  const [watchSort, setWatchSort] = useState<WatchSort>("saved");
  const rpsTarget = search.get("rank") === "concept" ? "concept" : "industry";
  function setRpsTarget(target: "industry" | "concept") {
    const url = new URL(window.location.href);
    if (target === "concept") url.searchParams.set("rank", target);
    else url.searchParams.delete("rank");
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }
  // Configuration/coverage refresh belongs to this visible page. Activity
  // summaries retain the sidebar's independent polling policy.
  const status = api.status.useQuery(undefined, {
    enabled: visible,
    staleTime: 30000,
    refetchInterval: visible ? 30000 : false,
    select: ({ coverage, watchlist }) => ({ coverage, watchlist }),
  });
  const directory = api.securityNames.useQuery(undefined, {
    enabled: visible,
    staleTime: 60000,
  });
  const monitorSummary = api.monitorWorkspaceSummary.useQuery(undefined, {
    enabled: visible,
    staleTime: 30000,
  });
  const channels = api.channels.useQuery(undefined, { enabled: visible });
  const signalPage = api.signalWorkspacePage.useQuery(
    {
      from: monitorSummary.data?.today,
      to: monitorSummary.data?.today,
    },
    {
      enabled: visible && !!monitorSummary.data,
      refetchInterval: visible ? 10000 : false,
    },
  );
  const now = useNow(15000);
  const daily = api.localDailyAsOf.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 60000 : false,
  });
  const intraday = api.intradayStatus.useQuery(
    { offset: 0 },
    { enabled: visible, refetchInterval: visible ? 15000 : false },
  );
  const cls = api.clsReviewSchedule.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 60000 : false,
  });
  const rps = api.rpsStatus.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
  });
  const industry = api.industryRpsPage.useQuery(
    { period: 20, page: 0 },
    { enabled: visible && rpsTarget === "industry" },
  );
  const concept = api.conceptRpsPage.useQuery(
    { period: 20, page: 0 },
    { enabled: visible && rpsTarget === "concept" },
  );
  // Hooks stay above the early return below.
  const quotes = useOverviewQuotes(status.data?.watchlist ?? []);
  if (now === null) return null;
  const clock = beijingClock(now);
  const schedule = intraday.data?.lastCheck?.schedule;
  const trading =
    schedule?.date === clock.date
      ? (schedule.trading as "open" | "closed" | "unknown")
      : "unknown";
  const session = marketSession(now, trading);
  const todayRows =
    intraday.data?.rows.filter((row) =>
      row.value.barCutoff.startsWith(clock.date),
    ) ?? [];
  const input: OverviewInput = {
    now,
    date: clock.date,
    minutes: clock.minutes,
    intraday: intraday.data && {
      config: intraday.data.config,
      lastCheck: intraday.data.lastCheck,
      worker: intraday.data.worker,
      runs: intraday.data.runs,
      unconfirmed: todayRows.filter((row) => row.attempts.length === 0).length,
    },
    cls: cls.data && {
      enabled: cls.data.config.enabled,
      lastCheck: cls.data.lastCheck,
    },
    coverage: status.data?.coverage ?? null,
    daily: daily.data ?? null,
    rps: rps.data && {
      latestDate: rps.data.latest?.date ?? null,
      running: rps.data.progress?.status === "running",
      waiting:
        rps.data.progress?.status === "waiting"
          ? rps.data.progress.waiting?.message
          : null,
      error:
        rps.data.progress?.status === "failed" ? rps.data.progress.error : null,
    },
    channels: channels.data ?? [],
    failedDeliveries: monitorSummary.data?.failedDeliveries ?? 0,
  };
  const phase = phaseOf(input);
  const slots = timeline(input);
  const nowPct = axisPct(clock.minutes);
  const names = directory.data ?? {};
  const signals = signalPage.data?.items ?? [];
  const batch =
    intraday.data?.runs.find(
      (run) => run.date === clock.date && run.slot === "late",
    ) ??
    intraday.data?.runs.find(
      (run) => run.date === clock.date && run.slot === "noon",
    );
  const sectorQuery = rpsTarget === "industry" ? industry : concept;
  const sectors = sectorQuery.data;
  const intradayArchived = !capabilityAllows("intraday", "schedule");
  const watch = status.data?.watchlist ?? [];
  // A failed quote request must not rank cached prices as if they were live.
  const sortedWatch = quotes.error
    ? watch
    : sortWatchSymbols(
        watch,
        (symbol) => quoteChange(quotes.bySymbol.get(symbol)),
        watchSort,
      );
  const name = (symbol: string) => names[symbol] ?? symbol.toUpperCase();
  return (
    <div className="flex flex-col gap-[var(--nc-gap)]">
      <AlertStatus />
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[13px] text-nc-text-3">
          {dateLine(now)} ·{" "}
          {trading === "unknown"
            ? "交易日历待核验"
            : trading === "closed"
              ? "已核验休市"
              : "已核验交易日"}
        </span>
        <Pill tone={trading === "unknown" ? "warn" : "accent"}>
          {session.label}
          {trading === "unknown" ? "（仅时钟参考）" : ""} · {clock.hhmm}
        </Pill>
        <span className="text-[13px] text-nc-text-4">当前阶段：{phase}</span>
      </div>
      <PageGrid>
        <div className="nc-span-7 flex min-w-0 flex-col gap-[var(--nc-gap)]">
          <Panel title="下一步" meta="按当前时段排序，每条给出理由与证据">
            <NextSteps items={todos(input)} />
          </Panel>

          <Panel
            icon={Lightning}
            title="今日信号"
            meta="最近20条 · 完整历史见订阅信号"
            actions={
              <Link
                href="/system/notifications?monitorTab=signals"
                className="text-[13px]"
              >
                全部订阅信号 →
              </Link>
            }
            note="历史导入与回测不会发送通知；未知或停牌的证券暂停信号。"
          >
            {monitorSummary.error || signalPage.error ? (
              <ReadError
                label="今日信号"
                message={(monitorSummary.error ?? signalPage.error)!.message}
                retry={() => {
                  if (monitorSummary.error) void monitorSummary.refetch();
                  else void signalPage.refetch();
                }}
              />
            ) : (
              <GridTable
                label="今日信号"
                minWidth={520}
                empty={
                  monitorSummary.isLoading || signalPage.isLoading
                    ? "正在读取信号…"
                    : !capabilityAllows("signalMonitor", "schedule")
                      ? "旧监控没有今日记录；新提醒见提醒历史。"
                      : "今日还没有新信号"
                }
                rows={signals}
                rowKey={(s) => s.id}
                columns={[
                  {
                    key: "security",
                    header: "证券",
                    width: "1.5fr",
                    cell: (s) => (
                      <SecurityCell
                        name={name(s.symbol)}
                        code={s.symbol.toUpperCase()}
                        extra={
                          s.close === undefined
                            ? undefined
                            : `收 ${formatNumber(s.close, 2)}`
                        }
                      />
                    ),
                  },
                  {
                    key: "strategy",
                    header: "策略",
                    width: "1.2fr",
                    cell: (s) => (
                      <span className="text-nc-text-2">{s.strategyName}</span>
                    ),
                  },
                  {
                    key: "time",
                    header: "触发",
                    width: "0.7fr",
                    cell: (s) => (
                      <span className="text-nc-text-3">
                        {new Date(s.createdAt).toLocaleTimeString("zh-CN", {
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                        })}
                      </span>
                    ),
                  },
                  {
                    key: "check",
                    header: "核验",
                    width: "1fr",
                    cell: (s) => {
                      const [label, tone] = s.tradingStatus
                        ? tradingLabel[s.tradingStatus]
                        : (["未记录核验", "idle"] as const);
                      return (
                        <span className={cn("text-[13px]", toneText[tone])}>
                          {label}
                        </span>
                      );
                    },
                  },
                  {
                    key: "send",
                    header: "投递",
                    width: "0.9fr",
                    cell: (s) => {
                      const label =
                        Object.entries(s.deliveries)
                          .filter(([, count]) => count > 0)
                          .map(
                            ([status, count]) =>
                              `${deliveryLabel[status as keyof typeof deliveryLabel][0]} ${count}`,
                          )
                          .join(" / ") || "未找到投递记录";
                      const tone = s.deliveries.failed
                        ? "bad"
                        : s.deliveries.pending || s.deliveries.sending
                          ? "accent"
                          : s.deliveries.sent
                            ? "ok"
                            : "idle";
                      return (
                        <span className={cn("text-[13px]", toneText[tone])}>
                          {label}
                        </span>
                      );
                    },
                  },
                ]}
              />
            )}
          </Panel>
        </div>

        <div className="nc-span-5 flex min-w-0 flex-col gap-[var(--nc-gap)]">
          <Panel
            tone="accent"
            icon={Crosshair}
            title={`盘中预选${batch ? ` · ${batch.slot === "noon" ? "午盘" : "尾盘"}批次` : ""}`}
            meta={intradayArchived ? "历史预选" : undefined}
            actions={
              <Link href="/?tab=intraday" className="text-[13px]">
                {intradayArchived || intraday.data?.config.enabled
                  ? "查看记录 →"
                  : "去设置 →"}
              </Link>
            }
            note={
              intradayArchived
                ? "预选历史保留；新候选与持仓保护由统一提醒引擎管理。"
                : "预选使用截至该时点的行情，收盘后另行确认或撤销，不覆盖原始记录。"
            }
          >
            {intraday.error ? (
              <ReadError
                label="预选记录"
                message={intraday.error.message}
                retry={() => void intraday.refetch()}
              />
            ) : todayRows.length === 0 ? (
              <PanelEmpty>
                {intraday.isLoading
                  ? "正在读取预选记录…"
                  : intradayArchived
                    ? "今日没有旧预选记录；请查看统一提醒历史。"
                    : "今日暂无预选候选。缺少当日行情不会生成候选。"}
              </PanelEmpty>
            ) : (
              <div className="flex flex-col gap-[7px]">
                {todayRows.slice(0, 6).map((row, index) => (
                  <div key={row.id} className="nc-candidate">
                    <span className="nc-rank">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <SecurityCell
                      name={name(row.value.snapshot.symbol)}
                      code={row.value.snapshot.symbol.toUpperCase()}
                      extra={
                        row.value.signals.length
                          ? row.value.signals
                              .map((signal) =>
                                signal.strategy === "czsc"
                                  ? "缠论买点"
                                  : "双突破",
                              )
                              .join("、")
                          : "未出现买入信号"
                      }
                    />
                    <span className="ml-auto flex-none text-right text-[13px] text-nc-text-4 tabular-nums">
                      RPS {formatNumber(row.value.rps, 0)}
                      <br />
                      {row.attempts.length ? "已核对" : "待核对"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel
            icon={Ranking}
            title="RPS 强度"
            meta={
              sectors?.day ? `20日 · 截至 ${sectors.day.date.slice(5)}` : "20日"
            }
            actions={
              <Segmented
                label="RPS 口径"
                value={rpsTarget}
                onChange={setRpsTarget}
                options={[
                  { value: "industry", label: "行业" },
                  { value: "concept", label: "概念" },
                ]}
              />
            }
          >
            {sectorQuery.error ? (
              <ReadError
                label="板块 RPS"
                message={sectorQuery.error.message}
                retry={() => void sectorQuery.refetch()}
              />
            ) : (
              <BarRows
                empty={
                  sectorQuery.isLoading
                    ? "正在读取板块 RPS…"
                    : "尚未计算板块 RPS"
                }
                items={(sectors?.rows ?? [])
                  .filter((row) => row.value)
                  .slice(0, 6)
                  .map((row) => ({
                    key: row.name,
                    name: row.name,
                    value: formatNumber(row.value!.rps, 0),
                    pct: row.value!.rps,
                  }))}
              />
            )}
          </Panel>

          <Panel
            icon={Star}
            title="自选"
            note={
              quotes.error && watchSort !== "saved"
                ? "行情未刷新，暂按保存顺序"
                : undefined
            }
            actions={
              <>
                <span className="text-[13px] text-nc-text-4">
                  {watch.length} 个标的
                </span>
                <Segmented
                  label="自选排序"
                  value={watchSort}
                  onChange={setWatchSort}
                  options={[
                    { value: "saved", label: "保存顺序" },
                    { value: "gain", label: "涨幅优先" },
                    { value: "loss", label: "跌幅优先" },
                  ]}
                />
              </>
            }
          >
            {watch.length === 0 ? (
              <PanelEmpty>在行情图表中加入自选</PanelEmpty>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-[7px]">
                {sortedWatch.map((symbol) => (
                  <Link
                    key={symbol}
                    href={`/scan?symbol=${symbol}`}
                    className="nc-watch"
                  >
                    <SecurityCell
                      name={name(symbol)}
                      code={symbol.toUpperCase()}
                    />
                    <WatchQuote quote={quotes.bySymbol.get(symbol)} />
                  </Link>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </PageGrid>
      <MarketBreadth />
      <MarketPulse bySymbol={quotes.bySymbol} error={quotes.error} />
      <details className="rounded-lg border border-nc-border bg-nc-card p-4">
        <summary className="cursor-pointer text-sm font-medium">
          数据与调度状态 · 展开查看各自时点
        </summary>
        <div className="mt-4">
          <div className="nc-health">
            {health(input).map((card) => {
              const CardIcon = healthIcon[card.key]!;
              return (
                <div
                  key={card.key}
                  className={cn(
                    "nc-health-card",
                    card.tone !== "neutral" &&
                      card.tone !== "idle" &&
                      toneEdge[card.tone],
                  )}
                >
                  <div className="flex items-center gap-[7px] text-[13px] whitespace-nowrap text-nc-text-3">
                    <CardIcon size={14} />
                    {card.name}
                    <span
                      className="ml-auto size-1.5 rounded-full"
                      style={{ background: dot[card.tone] }}
                    />
                  </div>
                  <strong
                    className={cn(
                      "text-[14px] font-medium tabular-nums",
                      card.tone === "neutral" || card.tone === "idle"
                        ? "text-nc-text"
                        : toneText[card.tone],
                    )}
                  >
                    {card.value}
                  </strong>
                  <span className="text-[13px] leading-[1.45] text-nc-text-4">
                    {card.note}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </details>
      <details className="rounded-lg border border-nc-border bg-nc-card p-4">
        <summary className="cursor-pointer text-sm font-medium">
          今日调度窗口 · {scheduleSummary(input)}
        </summary>
        <div className="mt-4">
          <Panel
            icon={Timer}
            title="今日调度时间轴"
            meta="窗口只在应用运行时触发 · 休眠或退出会漏批次"
            actions={
              <span className="text-[13px] text-nc-accent">
                {scheduleSummary(input)}
              </span>
            }
          >
            <div className="nc-timeline" aria-label="调度时间轴">
              <span className="nc-timeline-rail" />
              <span
                className="nc-timeline-lunch"
                style={{
                  left: `${axisPct(LUNCH_START)}%`,
                  width: `${axisPct(LUNCH_END) - axisPct(LUNCH_START)}%`,
                }}
                title="午休 11:30–13:00"
              />
              {session.kind !== "closed-day" && (
                <span
                  className="nc-timeline-done"
                  style={{ width: `${nowPct}%` }}
                />
              )}
              {session.kind !== "closed-day" &&
                clock.minutes >= AXIS_START &&
                clock.minutes <= AXIS_END && (
                  <span
                    className="nc-timeline-now"
                    style={{ left: `${nowPct}%` }}
                  >
                    <em
                      style={{
                        transform: `translateX(${nowPct < 4 ? -10 : nowPct > 96 ? -90 : -50}%)`,
                      }}
                    >
                      现在 {clock.hhmm}
                    </em>
                    <i />
                  </span>
                )}
              {slots.map((slot, index) => {
                // Close neighbours lean apart so every label stays on one row.
                const near = (other?: { pct: number }) =>
                  other !== undefined && Math.abs(other.pct - slot.pct) < 9;
                const align = near(slots[index + 1])
                  ? "end"
                  : near(slots[index - 1])
                    ? "start"
                    : "center";
                const passed = axisPct(clock.minutes) >= slot.pct;
                return (
                  <div
                    key={slot.key}
                    className="nc-timeline-slot"
                    data-align={align}
                    data-passed={passed || undefined}
                    data-active={
                      slot.tone === "accent" && passed ? true : undefined
                    }
                    style={{ left: `${slot.pct}%` }}
                  >
                    <span
                      className="nc-timeline-dot"
                      style={{ "--dot": dot[slot.tone] } as CSSProperties}
                    />
                    <span className="nc-timeline-text">
                      <span className="text-[13px] text-nc-text-3 tabular-nums">
                        {slot.time}
                      </span>
                      <span className="text-[13px] text-nc-text">
                        {slot.label}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "text-[13px] whitespace-nowrap",
                        toneText[slot.tone === "neutral" ? "ok" : slot.tone],
                      )}
                    >
                      {slot.status}
                    </span>
                  </div>
                );
              })}
              {session.kind === "closed-day" && (
                <span className="nc-timeline-closed">
                  今日休市 · 调度不运行
                </span>
              )}
            </div>
          </Panel>
        </div>
      </details>
      {!cls.data?.config.enabled && cls.data && (
        <p className="flex items-center gap-2 text-[13px] text-nc-text-4">
          <Newspaper size={13} />{" "}
          财联社盘前报告扫描未启用，可在财联社复盘中配置报告目录。
        </p>
      )}
    </div>
  );
}

function NextSteps({ items }: { items: ReturnType<typeof todos> }) {
  const router = useRouter();
  if (items.length === 0)
    return <PanelEmpty>当前时段没有待处理事项</PanelEmpty>;
  return (
    <div className="flex flex-col gap-[9px]">
      {items.map((todo, index) => {
        const TodoIcon = todoIcon[todo.tone];
        const tone = todo.tone === "neutral" ? "ok" : todo.tone;
        return (
          <div
            key={todo.key}
            className={cn(
              "nc-todo",
              index === 0 && "border-l-4 bg-nc-accent-900",
              toneEdge[tone === "idle" ? "neutral" : tone],
            )}
          >
            <TodoIcon
              size={17}
              className={cn("mt-px flex-none", toneText[tone])}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-[13px] font-medium">
                  {todo.title}
                </strong>
                <Pill tone={tone}>{todo.tag}</Pill>
              </div>
              <span className="text-[13px] leading-[1.55] text-nc-text-3">
                {todo.detail}
              </span>
            </div>
            <Button
              size="sm"
              variant={index === 0 ? "default" : "outline"}
              className="flex-none"
              onClick={() => router.push(todo.href, { scroll: false })}
            >
              {todo.action}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function ReadError({
  label,
  message,
  retry,
}: {
  label: string;
  message: string;
  retry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 text-sm text-nc-bad"
    >
      <span>
        {label}读取失败：{message}
      </span>
      <Button size="sm" variant="outline" onClick={retry}>
        重新加载
      </Button>
    </div>
  );
}
