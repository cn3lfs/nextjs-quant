"use client";
import { formatNumber as displayNumber } from "trading-strategy-core/format-number";

import { Bank } from "@phosphor-icons/react/ssr";
import Link from "next/link";
import { api } from "~/trpc/react";
import { Panel, PanelEmpty, Pill } from "../panels";
import { Button } from "../ui/button";
import { usePanelVisible } from "../workbench/keep-alive";

const pct = (value: number | null | undefined, digits = 3) =>
  value == null ? "—" : displayNumber(value, digits) + "%";
const bp = (value: number | null) =>
  value == null
    ? "—"
    : (value > 0 ? "+" : "") + Math.round(value * 100) + " BP";
const diff = (a?: number | null, b?: number | null) =>
  a == null || b == null ? null : a - b;
const regimeLabels = {
  recovery: "复苏",
  overheat: "过热",
  stagflation: "滞胀",
  recession: "衰退",
  unknown: "数据不足",
} as const;
type Regime = keyof typeof regimeLabels;
const regimeTones = {
  recovery: "ok",
  overheat: "warn",
  stagflation: "bad",
  recession: "idle",
  unknown: "idle",
} as const satisfies Record<Regime, "ok" | "warn" | "bad" | "idle">;
const macroSeriesLabels = {
  "gdp-yoy": "GDP",
  "cpi-yoy": "CPI",
  "ppi-yoy": "PPI",
  "pmi-mfg": "PMI",
  "bond-1y": "国债1Y",
  "bond-10y": "国债10Y",
  fr007: "FR007",
  "lpr-1y": "LPR",
} as const;

function Row({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <span className="shrink-0 text-[13px] text-nc-text-3">{label}</span>
      <span className="text-right text-sm font-medium tabular-nums">
        {value}
        {note && (
          <small className="mt-1 block text-[13px] font-normal text-nc-text-3">
            {note}
          </small>
        )}
      </span>
    </div>
  );
}

/** Source dates stay separate from the futures chart and the query cache age. */
export function MacroRatesPanel() {
  const visible = usePanelVisible();
  const query = api.macroRates.useQuery(undefined, {
    enabled: visible,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 60 * 60000,
  });
  const utils = api.useUtils();
  const pit = api.macroPitSummary.useQuery(undefined, {
    enabled: visible,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 60 * 60000,
  });
  const sync = api.macroPitSync.useMutation({
    onSuccess: () => utils.macroPitSummary.invalidate(),
  });
  const regime = pit.data?.macroClock.regime;
  const data = query.data;
  const treasury = data?.treasury ?? [];
  const latestTreasury = treasury.at(-1);
  const priorTreasury = treasury.at(-21);
  const repo = data?.repo ?? [];
  const latestRepo = repo.at(-1);
  const recentRepo = repo.slice(-20);
  const averageFr007 = recentRepo.length
    ? recentRepo.reduce((sum, value) => sum + value.fr007, 0) /
      recentRepo.length
    : null;
  const latestLpr = data?.lpr.at(-1);
  return (
    <Panel icon={Bank} title="宏观利率" meta="独立缓存1小时，源日期分别显示">
      {query.error && (
        <div
          role="alert"
          className="mb-3 flex flex-wrap items-center gap-3 text-nc-bad"
        >
          宏观利率读取失败：{query.error.message}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
          >
            重试宏观数据
          </Button>
        </div>
      )}
      {!data && !query.error && <PanelEmpty>正在读取宏观利率…</PanelEmpty>}
      {data && (
        <div aria-busy={query.isFetching}>
          {query.error && (
            <p className="mb-3 text-[13px] text-nc-warn">
              下方保留上次读取结果，请按各来源日期判断。
            </p>
          )}
          <div className="nc-macro-groups">
            <section className="nc-macro-group">
              <h4>中国国债收益率</h4>
              <p className="text-[13px] text-nc-text-3">
                中债国债曲线 · {latestTreasury?.date ?? "日期未取得"}
              </p>
              <Row
                label="1年"
                value={pct(latestTreasury?.["1y"])}
                note={
                  "较20条记录前 " +
                  bp(diff(latestTreasury?.["1y"], priorTreasury?.["1y"]))
                }
              />
              <Row
                label="10年"
                value={pct(latestTreasury?.["10y"])}
                note={
                  "较20条记录前 " +
                  bp(diff(latestTreasury?.["10y"], priorTreasury?.["10y"]))
                }
              />
              <Row
                label="30年"
                value={pct(latestTreasury?.["30y"])}
                note={
                  "较20条记录前 " +
                  bp(diff(latestTreasury?.["30y"], priorTreasury?.["30y"]))
                }
              />
              <Row
                label="10Y−1Y利差"
                value={bp(
                  diff(latestTreasury?.["10y"], latestTreasury?.["1y"]),
                )}
              />
              <p className="text-[13px] text-nc-text-3">
                比较源记录，不保证连续20个交易日；记录不足留空。
              </p>
            </section>
            <section className="nc-macro-group">
              <h4>回购定盘利率</h4>
              <p className="text-[13px] text-nc-text-3">
                中国货币网 · {latestRepo?.date ?? "日期未取得"}
              </p>
              <Row label="FR007" value={pct(latestRepo?.fr007, 2)} />
              <Row label="FR001" value={pct(latestRepo?.fr001, 2)} />
              <Row
                label={"最近" + recentRepo.length + "条FR007均值"}
                value={pct(averageFr007, 2)}
              />
              <p className="text-[13px] text-nc-text-3">
                最多取20条可读记录，不将条数冒充交易日数。
              </p>
            </section>
            <section className="nc-macro-group">
              <h4>贷款市场报价利率</h4>
              <p className="text-[13px] text-nc-text-3">
                东方财富 · 发布月份 {latestLpr?.date.slice(0, 7) ?? "未取得"}
              </p>
              <Row label="LPR 1年" value={pct(latestLpr?.lpr1y, 2)} />
              <Row label="LPR 5年" value={pct(latestLpr?.lpr5y, 2)} />
            </section>
          </div>
          {data.failures.length > 0 && (
            <p role="status" className="mt-3 text-[13px] text-nc-warn">
              部分来源未能读取：
              {data.failures
                .map((item) => item.part + "（" + item.message + "）")
                .join("；")}
            </p>
          )}
        </div>
      )}
      <section
        className="mt-4 rounded-lg bg-nc-inset p-3"
        aria-label="宏观择时 PIT 状态"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-[13px] font-semibold text-nc-text">
            宏观择时 PIT 状态
          </h4>
          {regime && (
            <Pill tone={regimeTones[regime]}>{regimeLabels[regime]}</Pill>
          )}
          {pit.data && (
            <span className="text-[13px] text-nc-text-3">
              截止 {pit.data.asOf}
            </span>
          )}
        </div>
        {pit.isPending && !pit.data ? (
          <p className="mt-1 text-[13px] text-nc-text-3" role="status">
            正在读取宏观 PIT…
          </p>
        ) : pit.isError ? (
          <p role="alert" className="mt-1 text-[13px] text-nc-bad">
            宏观 PIT 读取失败：{pit.error.message}
          </p>
        ) : pit.data ? (
          <>
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-nc-text-3">
              {pit.data.series.map((item) => (
                <li
                  key={item.seriesId}
                  className={item.count === 0 ? "text-nc-warn" : undefined}
                >
                  {macroSeriesLabels[item.seriesId]}
                  <span className="ml-1 tabular-nums text-nc-text-2">
                    {item.count}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[13px] text-nc-text-3">
              {pit.data.macroClock.reason}
            </p>
          </>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={sync.isPending}
            onClick={() => sync.mutate(undefined)}
          >
            {sync.isPending ? "同步中…" : "同步宏观历史"}
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link href="/?ticketSource=etf_rotation&etfStrategy=macro-clock#rebalance-tickets">
              去作战室生成宏观时钟调仓单
            </Link>
          </Button>
        </div>
        {sync.isSuccess && (
          <p role="status" className="mt-1 text-[13px] text-nc-text-3">
            已同步 {sync.data.synced.length} 条序列
            {sync.data.failures.length
              ? `，${sync.data.failures.length} 条失败`
              : "，全部成功"}
            。
          </p>
        )}
        {sync.isError && (
          <p role="alert" className="mt-1 text-[13px] text-nc-bad">
            同步失败：{sync.error.message}
          </p>
        )}
      </section>
    </Panel>
  );
}
