"use client";
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
import { useRouter } from "next/navigation";
import { useEffect, useState, type CSSProperties } from "react";
import { cn } from "~/lib/common/classnames";
import { beijingClock, dateLine, marketSession } from "~/lib/market/market-session";
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
import { usePanelVisible } from "../workbench/keep-alive";
import type { WorkbenchState } from "../workbench/use-workbench-state";
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

/** Deep links written before 行情图表 had its own route. */
export function useLegacyMarketLink() {
  const router = useRouter();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("symbol") || params.has("poolCategory"))
      router.replace(`/market${window.location.search}`, { scroll: false });
  }, []);
}

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
export function TodayOverview({ state }: { state: WorkbenchState }) {
  useLegacyMarketLink();
  const visible = usePanelVisible();
  const now = useNow(15000);
  const [rpsTarget, setRpsTarget] = useState<"industry" | "concept">(
    "industry",
  );
  const intraday = api.intradayStatus.useQuery(
    { offset: 0 },
    { enabled: visible, refetchInterval: 15000 },
  );
  const cls = api.clsReviewSchedule.useQuery(undefined, {
    enabled: visible,
    refetchInterval: 60000,
  });
  const rps = api.rpsStatus.useQuery(undefined, {
    enabled: visible,
    refetchInterval: 30000,
  });
  const industry = api.industryRpsPage.useQuery(
    { period: 20, page: 0 },
    { enabled: visible && rpsTarget === "industry" },
  );
  const concept = api.conceptRpsPage.useQuery(
    { period: 20, page: 0 },
    { enabled: visible && rpsTarget === "concept" },
  );
  if (now === null) return null;
  const clock = beijingClock(now);
  const schedule = intraday.data?.lastCheck?.schedule;
  const session = marketSession(
    now,
    schedule?.date === clock.date
      ? (schedule.trading as "open" | "closed" | "unknown")
      : "unknown",
  );
  const todayRows =
    intraday.data?.rows.filter((row) =>
      row.value.barCutoff.startsWith(clock.date),
    ) ?? [];
  const deliveries = state.deliveries.data ?? [];
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
    coverage: state.status.data?.coverage ?? null,
    rps: rps.data && {
      latestDate: rps.data.latest?.date ?? null,
      running: rps.data.progress?.status === "running",
      error:
        rps.data.progress?.status === "failed" ? rps.data.progress.error : null,
    },
    channels: state.channels.data ?? [],
    failedDeliveries: deliveries.filter((d) => d.status === "failed").length,
  };
  const phase = phaseOf(input);
  const slots = timeline(input);
  const nowPct = axisPct(clock.minutes);
  const names = state.names;
  const today = (at: number) =>
    new Date(at + 8 * 3600000).toISOString().slice(0, 10) === clock.date;
  const signals = (state.signals.data ?? []).filter((s) => today(s.createdAt));
  const batch =
    intraday.data?.runs.find(
      (run) => run.date === clock.date && run.slot === "late",
    ) ??
    intraday.data?.runs.find(
      (run) => run.date === clock.date && run.slot === "noon",
    );
  const sectors = (rpsTarget === "industry" ? industry : concept).data;
  const watch = state.status.data?.watchlist ?? [];
  const name = (symbol: string) => names[symbol] ?? symbol.toUpperCase();
  return (
    <div className="flex flex-col gap-[var(--nc-gap)]">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[12px] text-nc-text-3">
          {dateLine(now)} ·{" "}
          {session.kind === "closed-day" ? "非交易日" : "交易日"}
        </span>
        <Pill tone="accent">
          {session.label} · {clock.hhmm}
        </Pill>
        <span className="text-[11px] text-nc-text-4">当前阶段：{phase}</span>
      </div>

      <Panel
        icon={Timer}
        title="今日调度时间轴"
        meta="窗口只在应用运行时触发 · 休眠或退出会漏批次"
        actions={
          <span className="text-[11px] text-nc-accent">
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
              <span className="nc-timeline-now" style={{ left: `${nowPct}%` }}>
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
                data-active={slot.tone === "accent" && passed ? true : undefined}
                style={{ left: `${slot.pct}%` }}
              >
                <span
                  className="nc-timeline-dot"
                  style={{ "--dot": dot[slot.tone] } as CSSProperties}
                />
                <span className="nc-timeline-text">
                  <span className="text-[11px] text-nc-text-3 tabular-nums">
                    {slot.time}
                  </span>
                  <span className="text-[12px] text-nc-text">{slot.label}</span>
                </span>
                <span
                  className={cn(
                    "text-[10.5px] whitespace-nowrap",
                    toneText[slot.tone === "neutral" ? "ok" : slot.tone],
                  )}
                >
                  {slot.status}
                </span>
              </div>
            );
          })}
          {session.kind === "closed-day" && (
            <span className="nc-timeline-closed">今日休市 · 调度不运行</span>
          )}
        </div>
      </Panel>

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
              <div className="flex items-center gap-[7px] text-[11px] whitespace-nowrap text-nc-text-3">
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
              <span className="text-[10.5px] leading-[1.45] text-nc-text-4">
                {card.note}
              </span>
            </div>
          );
        })}
      </div>

      <PageGrid>
        <div className="nc-span-7 flex min-w-0 flex-col gap-[var(--nc-gap)]">
          <Panel title="下一步" meta="按当前时段排序，每条给出理由与证据">
            <NextSteps items={todos(input)} />
          </Panel>

          <Panel
            icon={Lightning}
            title="今日信号"
            meta="规则触发 · 已通过交易状态核验才会投递"
            actions={
              <Link href="/signal-ledger" className="text-[11.5px]">
                全部台账 →
              </Link>
            }
            note="历史导入与回测不会发送通知；未知或停牌的证券暂停信号。"
          >
            <GridTable
              label="今日信号"
              minWidth={520}
              empty="今日还没有新信号"
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
                        s.metrics.close === undefined
                          ? undefined
                          : `收 ${s.metrics.close.toFixed(2)}`
                      }
                    />
                  ),
                },
                {
                  key: "strategy",
                  header: "策略",
                  width: "1.2fr",
                  cell: (s) => (
                    <span className="text-nc-text-2">{s.strategy.name}</span>
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
                    const [label, tone] = s.tradingStatusEvidence
                      ? tradingLabel[s.tradingStatusEvidence.status]
                      : (["未记录核验", "idle"] as const);
                    return (
                      <span className={cn("text-[11.5px]", toneText[tone])}>
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
                    const delivery = deliveries.find(
                      (d) => d.signalId === s.id,
                    );
                    const [label, tone] = delivery
                      ? deliveryLabel[delivery.status]
                      : (["未投递", "idle"] as const);
                    return (
                      <span
                        className={cn("text-[11.5px]", toneText[tone])}
                        title={delivery?.error}
                      >
                        {label}
                      </span>
                    );
                  },
                },
              ]}
            />
          </Panel>
        </div>

        <div className="nc-span-5 flex min-w-0 flex-col gap-[var(--nc-gap)]">
          <Panel
            tone="accent"
            icon={Crosshair}
            title={`盘中预选${batch ? ` · ${batch.slot === "noon" ? "午盘" : "尾盘"}批次` : ""}`}
            actions={
              <Link href="/intraday" className="text-[11px]">
                {intraday.data?.config.enabled ? "查看批次 →" : "去设置 →"}
              </Link>
            }
            note="预选使用截至该时点的行情，收盘后另行确认或撤销，不覆盖原始记录。"
          >
            {todayRows.length === 0 ? (
              <PanelEmpty>
                {intraday.isLoading
                  ? "正在读取预选记录…"
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
                    <span className="ml-auto flex-none text-right text-[10.5px] text-nc-text-4 tabular-nums">
                      RPS {row.value.rps.toFixed(0)}
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
            <BarRows
              empty="尚未计算板块 RPS"
              items={(sectors?.rows ?? [])
                .filter((row) => row.value)
                .slice(0, 6)
                .map((row) => ({
                  key: row.name,
                  name: row.name,
                  value: row.value!.rps.toFixed(0),
                  pct: row.value!.rps,
                }))}
            />
          </Panel>

          <Panel
            icon={Star}
            title="自选"
            actions={
              <span className="text-[11px] text-nc-text-4">
                {watch.length} 个标的
              </span>
            }
          >
            {watch.length === 0 ? (
              <PanelEmpty>在行情图表中加入自选</PanelEmpty>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-[7px]">
                {watch.map((symbol) => (
                  <Link
                    key={symbol}
                    href={`/market?symbol=${symbol}`}
                    className="nc-watch"
                  >
                    <SecurityCell
                      name={name(symbol)}
                      code={symbol.toUpperCase()}
                    />
                  </Link>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </PageGrid>
      {!cls.data?.config.enabled && cls.data && (
        <p className="flex items-center gap-2 text-[11px] text-nc-text-4">
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
      {items.map((todo) => {
        const TodoIcon = todoIcon[todo.tone];
        const tone = todo.tone === "neutral" ? "ok" : todo.tone;
        return (
          <div
            key={todo.key}
            className={cn(
              "nc-todo",
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
              <span className="text-[11.5px] leading-[1.55] text-nc-text-3">
                {todo.detail}
              </span>
            </div>
            <Button
              size="sm"
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
