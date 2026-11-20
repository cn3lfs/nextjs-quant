"use client";
import { formatNumber } from "trading-strategy-core/format-number";

import { useState } from "react";
import { rpsPeriods } from "quant-rps";
import { Newspaper, Ranking, Lightning } from "@phosphor-icons/react/ssr";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
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
  Panel,
  Pill,
  SecurityCell,
  Segmented,
  toneText,
} from "../panels";
import { Button } from "../ui/button";
import { AlertStatus } from "../signals/alert-status";
import { useTaskVisible } from "../workbench/use-task-visible";
import { EtfNetSubscriptions } from "./etf-net-subscriptions";
import { MarketBreadth } from "./market-breadth";
import { MarketPulse, useOverviewQuotes } from "./market-pulse";
import { useNow } from "../workbench/use-now";
import { phaseOf, type OverviewInput } from "./overview-model";

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
 * 大盘总览：按交易者视角自上而下排列实时指数与市场宽度、
 * 宽基 ETF 净申赎（国家队指标）、今日信号、今日 RPS 强度。
 */
export function TodayOverview() {
  const visible = useTaskVisible();
  const search = useSearchParams();
  const rpsTarget = search.get("rank") === "concept" ? "concept" : "industry";
  const [rpsPeriod, setRpsPeriod] = useState<(typeof rpsPeriods)[number]>(1);
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
  const status = api.status.useQuery(undefined, {
    enabled: visible,
    staleTime: 30000,
    refetchInterval: visible ? 30000 : false,
    select: ({ coverage }) => ({ coverage }),
  });
  const directory = api.securityNames.useQuery(undefined, {
    enabled: visible,
    staleTime: 60000,
  });
  const monitorSummary = api.monitorWorkspaceSummary.useQuery(undefined, {
    enabled: visible,
    staleTime: 30000,
  });
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
  const intraday = api.intradayStatus.useQuery(
    { offset: 0 },
    { enabled: visible, refetchInterval: visible ? 15000 : false },
  );
  const cls = api.clsReviewSchedule.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 60000 : false,
  });
  const industry = api.industryRpsPage.useQuery(
    { period: rpsPeriod, page: 0 },
    { enabled: visible && rpsTarget === "industry" },
  );
  const concept = api.conceptRpsPage.useQuery(
    { period: rpsPeriod, page: 0 },
    { enabled: visible && rpsTarget === "concept" },
  );
  // Hooks stay above the early return below.
  const quotes = useOverviewQuotes([]);
  if (now === null) return null;
  const clock = beijingClock(now);
  const schedule = intraday.data?.lastCheck?.schedule;
  const trading =
    schedule?.date === clock.date
      ? (schedule.trading as "open" | "closed" | "unknown")
      : "unknown";
  const session = marketSession(now, trading);
  const input: OverviewInput = {
    now,
    date: clock.date,
    minutes: clock.minutes,
    intraday: intraday.data && {
      config: intraday.data.config,
      lastCheck: intraday.data.lastCheck,
      worker: intraday.data.worker,
      runs: intraday.data.runs,
      unconfirmed: 0,
    },
    coverage: status.data?.coverage ?? null,
    channels: [],
    failedDeliveries: 0,
  };
  const phase = phaseOf(input);
  const names = directory.data ?? {};
  const signals = signalPage.data?.items ?? [];
  const sectorQuery = rpsTarget === "industry" ? industry : concept;
  const sectors = sectorQuery.data;
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

      {/* 1. 指数与市场涨跌家数 */}
      <MarketPulse
        bySymbol={quotes.bySymbol}
        source={quotes.source}
        fetchedAt={quotes.fetchedAt}
        isFetching={quotes.isFetching}
        onRefresh={quotes.refetch}
        error={quotes.error}
      />
      <MarketBreadth />

      {/* 2. 宽基 ETF 净申赎 */}
      <EtfNetSubscriptions />

      {/* 3. 今日信号 */}
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
                  <Link
                    href={`/scan?symbol=${encodeURIComponent(s.symbol)}`}
                    className="hover:underline"
                  >
                    <SecurityCell
                      name={name(s.symbol)}
                      code={s.symbol.toUpperCase()}
                      extra={
                        s.close === undefined
                          ? undefined
                          : `收 ${formatNumber(s.close, 2)}`
                      }
                    />
                  </Link>
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

      {/* 4. 今日 RPS 强度 */}
      <Panel
        icon={Ranking}
        title="今日 RPS 强度"
        meta={
          sectors?.day
            ? `RPS${rpsPeriod} · 截至 ${sectors.day.date.slice(5)}`
            : `RPS${rpsPeriod}`
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              label="RPS 周期"
              value={String(rpsPeriod)}
              onChange={(value) =>
                setRpsPeriod(Number(value) as (typeof rpsPeriods)[number])
              }
              options={rpsPeriods.map((period) => ({
                value: String(period),
                label: `RPS${period}`,
              }))}
            />
            <Segmented
              label="RPS 口径"
              value={rpsTarget}
              onChange={setRpsTarget}
              options={[
                { value: "industry", label: "行业" },
                { value: "concept", label: "概念" },
              ]}
            />
          </div>
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
              sectorQuery.isLoading ? "正在读取板块 RPS…" : "尚未计算板块 RPS"
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

      {!cls.data?.config.enabled && cls.data && (
        <p className="flex items-center gap-2 text-[13px] text-nc-text-4">
          <Newspaper size={13} />{" "}
          财联社盘前报告扫描未启用，可在财联社复盘中配置报告目录。
        </p>
      )}
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
