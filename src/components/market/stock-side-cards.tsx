"use client";
import { useState } from "react";
import { cn } from "~/lib/common/classnames";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";

/*
 * 行情图表右栏的事件时间线与资金面。数据来自东方财富数据中心，服务端串行限流并缓存
 * 30 分钟；这里只在右栏可见时查询，不轮询。
 */
const queryOptions = {
  retry: false,
  refetchOnWindowFocus: false,
  staleTime: 30 * 60000,
} as const;
const yi = (v: number | null) => (v == null ? "—" : `${(v / 1e8).toFixed(2)}亿`);
const toneClass = {
  positive: "text-nc-bad",
  negative: "text-nc-ok",
  neutral: "text-nc-text-2",
} as const;
const typeLabels = {
  forecast: "预告",
  survey: "调研",
  holder: "增减持",
  buyback: "回购",
  pledge: "质押",
  unlock: "解禁",
} as const;

function Section({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-nc-border-soft pt-2">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[12px] font-medium">{title}</span>
        {meta && <span className="text-[10.5px] text-nc-text-4">{meta}</span>}
      </div>
      {children}
    </div>
  );
}

function Failure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <p role="alert" className="text-[12px] text-nc-bad">
      {message}
      <Button size="sm" variant="outline" className="ml-2" onClick={onRetry}>
        重试
      </Button>
    </p>
  );
}

export function StockEventsSection({ symbol }: { symbol: string }) {
  const [all, setAll] = useState(false);
  const query = api.stockEvents.useQuery(symbol, queryOptions);
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const data = query.data;
  const events = data?.events ?? [];
  return (
    <Section title="事件时间线" meta={data ? `${data.since} 起 · 含未来解禁` : undefined}>
      {query.error ? (
        <Failure message={`事件读取失败：${query.error.message}`} onRetry={() => void query.refetch()} />
      ) : !data ? (
        <p role="status" className="text-[12px] text-nc-text-3">正在读取事件…</p>
      ) : (
        <>
          {events.length === 0 && (
            <p className="text-[12px] text-nc-text-3">近一年无记录事件</p>
          )}
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {(all ? events : events.slice(0, 8)).map((e, i) => (
              <li key={`${e.date}-${e.type}-${i}`} className="text-[12px]" title={e.detail ?? undefined}>
                <span className={cn("tabular-nums", e.date > today ? "text-nc-warn" : "text-nc-text-4")}>
                  {e.date.slice(2)}
                </span>{" "}
                <span className="text-nc-text-4">[{typeLabels[e.type]}]</span>{" "}
                <span className={toneClass[e.tone]}>{e.title}</span>
              </li>
            ))}
          </ul>
          {events.length > 8 && (
            <Button size="sm" variant="plain" className="mt-1 px-0 text-[11px]" onClick={() => setAll(!all)}>
              {all ? "收起" : `展开全部 ${events.length} 条`}
            </Button>
          )}
          {data.failures.length > 0 && (
            <p className="mt-1 text-[10.5px] text-nc-warn">
              未能读取：{data.failures.map((f) => typeLabels[f.type]).join("、")}
            </p>
          )}
        </>
      )}
    </Section>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-[1px]">
      <span className="shrink-0 text-[11px] text-nc-text-4">{label}</span>
      <span className={cn("truncate text-right text-[12px] tabular-nums", tone)}>{value}</span>
    </div>
  );
}

export function CapitalSection({ symbol }: { symbol: string }) {
  const query = api.capitalProfile.useQuery(symbol, queryOptions);
  const data = query.data;
  const [m0] = data?.margin ?? [];
  const m5 = data?.margin[5];
  const netBuy5 = data?.margin.slice(0, 5).reduce((a, m) => a + (m.financingNetBuy ?? 0), 0) ?? null;
  const [h0] = data?.holders ?? [];
  const recentBlocks = data?.blockTrades.slice(0, 3) ?? [];
  const [lhb] = data?.billboard ?? [];
  const signTone = (v: number | null) => (v == null || v === 0 ? undefined : v > 0 ? "text-nc-bad" : "text-nc-ok");
  return (
    <Section title="资金面" meta={m0 ? `两融 ${m0.date}` : undefined}>
      {query.error ? (
        <Failure message={`资金面读取失败：${query.error.message}`} onRetry={() => void query.refetch()} />
      ) : !data ? (
        <p role="status" className="text-[12px] text-nc-text-3">正在读取资金面…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-4">
            <Row label="融资余额" value={yi(m0?.financingBalance ?? null)} />
            <Row label="占流通市值" value={m0?.financingRatio == null ? "—" : `${m0.financingRatio.toFixed(2)}%`} />
            <Row label="5日融资净买" value={m0 ? yi(netBuy5) : "—"} tone={signTone(netBuy5)} />
            <Row
              label="较5日前"
              value={m0 && m5 ? yi((m0.financingBalance ?? 0) - (m5.financingBalance ?? 0)) : "—"}
            />
            <Row label="股东户数" value={h0?.count == null ? "—" : h0.count.toLocaleString("zh-CN")} />
            <Row
              label="户数环比"
              value={h0?.changePct == null ? "—" : `${h0.changePct > 0 ? "+" : ""}${h0.changePct.toFixed(2)}%`}
              tone={signTone(h0?.changePct == null ? null : -h0.changePct)}
            />
          </div>
          {h0 && <p className="m-0 text-[10.5px] text-nc-text-4">户数截至 {h0.date}；户数下降通常意味筹码集中</p>}
          {recentBlocks.length > 0 && (
            <div className="mt-1.5">
              <span className="text-[11px] text-nc-text-4">大宗交易（180 天 {data.blockTrades.length} 笔）</span>
              {recentBlocks.map((b, i) => (
                <Row
                  key={`${b.date}-${i}`}
                  label={b.date.slice(2)}
                  value={`${yi(b.amount)} · 溢价 ${b.premiumPct?.toFixed(2) ?? "—"}%`}
                  tone={signTone(b.premiumPct)}
                />
              ))}
            </div>
          )}
          {lhb && (
            <div className="mt-1.5" title={lhb.reason ?? undefined}>
              <span className="text-[11px] text-nc-text-4">龙虎榜（一年 {data.billboard.length} 次）</span>
              <Row label={lhb.date.slice(2)} value={`净买入 ${yi(lhb.netBuy)}`} tone={signTone(lhb.netBuy)} />
            </div>
          )}
          {data.failures.length > 0 && (
            <p className="mt-1 text-[10.5px] text-nc-warn">
              部分数据未能读取：{data.failures.map((f) => f.message).join("；")}
            </p>
          )}
        </>
      )}
    </Section>
  );
}
