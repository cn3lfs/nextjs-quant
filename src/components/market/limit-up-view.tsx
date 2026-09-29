"use client";
import { Fire, Stairs } from "@phosphor-icons/react/ssr";
import type { LimitPoolRow } from "~/server/data-sources/eastmoney/em-limit-pool";
import {
  useLimitUpStore,
  type LimitPool as Pool,
} from "~/lib/stores/limit-up-store";
import { api } from "~/trpc/react";
import {
  BarsPanel,
  PageGrid,
  Panel,
  PanelEmpty,
  Pill,
  Segmented,
  StatCards,
  TablePanel,
  changeTone,
  signedPercent,
  toneText,
  type Column,
} from "../panels";
import { usePanelVisible } from "../workbench/keep-alive";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ChartSymbolLink } from "./chart-symbol-link";
import { BrowseSource } from "./open-chart";

const poolLabels: Record<Pool, string> = {
  zt: "涨停",
  zb: "炸板",
  dt: "跌停",
  yzt: "昨日涨停",
};
const today = () =>
  new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const yi = (v: number | null) =>
  v == null ? "—" : `${(v / 1e8).toFixed(2)}亿`;
const pct = (v: number | null, suffix = "%") =>
  v == null ? "—" : `${v.toFixed(1)}${suffix}`;

function columns(pool: Pool): Column<LimitPoolRow>[] {
  const base: Column<LimitPoolRow>[] = [
    {
      key: "name",
      header: "证券",
      width: "1.6fr",
      cell: (r) => <ChartSymbolLink symbol={r.symbol} name={r.name} />,
    },
    {
      key: "chg",
      header: pool === "yzt" ? "今日涨跌" : "涨跌幅",
      align: "right",
      cell: (r) => (
        <span className={toneText[changeTone(r.changePct)]}>
          {signedPercent(r.changePct)}
        </span>
      ),
    },
    {
      key: "streak",
      header: pool === "dt" ? "连续跌停" : pool === "yzt" ? "昨连板" : "连板",
      align: "right",
      width: "70px",
      cell: (r) => (pool === "zb" ? (r.stat ?? "—") : (r.streak ?? "—")),
    },
    {
      key: "seal",
      header: pool === "yzt" ? "昨首封" : pool === "dt" ? "末次封板" : "首封",
      width: "80px",
      cell: (r) => (pool === "dt" ? r.lastSeal : r.firstSeal) ?? "—",
    },
  ];
  if (pool === "zt" || pool === "dt")
    base.push({
      key: "fund",
      header: "封单",
      align: "right",
      cell: (r) => yi(r.sealFund),
    });
  if (pool !== "yzt")
    base.push({
      key: "breaks",
      header: pool === "dt" ? "开板" : "炸板",
      align: "right",
      width: "60px",
      cell: (r) => r.breaks ?? "—",
    });
  base.push(
    {
      key: "turnover",
      header: "换手",
      align: "right",
      width: "70px",
      cell: (r) => pct(r.turnover),
    },
    {
      key: "cap",
      header: "流通市值",
      align: "right",
      cell: (r) => yi(r.floatCap),
    },
    { key: "industry", header: "行业", cell: (r) => r.industry || "—" },
  );
  return base;
}

/** 打板情绪：东方财富涨停板行情中心四池 + 炸板率、连板梯队、晋级率。 */
export function LimitUpView() {
  const visible = usePanelVisible();
  const date = useLimitUpStore((s) => s.date) ?? today();
  const setDate = useLimitUpStore((s) => s.setDate);
  const pool = useLimitUpStore((s) => s.pool);
  const setPool = useLimitUpStore((s) => s.setPool);
  const query = api.limitSentiment.useQuery(
    { date },
    {
      enabled: visible,
      refetchInterval: date === today() ? 60000 : false,
      retry: false,
    },
  );
  const data = query.data;
  const s = data?.stats;
  return (
    <PageGrid>
      <Panel
        span={12}
        icon={Fire}
        title="打板情绪"
        tag={
          data ? (
            <Pill tone={data.final ? "idle" : "warn"}>
              {data.final ? "历史定稿" : "当日 · 60 秒刷新"}
            </Pill>
          ) : undefined
        }
        actions={
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={date}
              max={today()}
              onChange={(e) => e.target.value && setDate(e.target.value)}
              className="h-7 w-[150px]"
              aria-label="交易日"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              刷新
            </Button>
          </div>
        }
        note="数据：东方财富涨停板行情中心（push2ex，串行限流）。晋级率 = 昨日涨停今日仍在涨停池的占比。"
      >
        {query.isError ? (
          <p role="alert" className="m-0 text-[12px] text-nc-bad">
            读取失败：{query.error.message}
          </p>
        ) : !data ? (
          <PanelEmpty>正在读取…</PanelEmpty>
        ) : !data.available ? (
          <PanelEmpty>{date} 非交易日或尚无数据</PanelEmpty>
        ) : (
          <StatCards
            items={[
              { label: "涨停", value: s!.limitUp, tone: "bad" },
              { label: "炸板", value: s!.broken, tone: "warn" },
              { label: "跌停", value: s!.limitDown, tone: "ok" },
              { label: "炸板率", value: pct(s!.breakRate) },
              { label: "最高连板", value: `${s!.maxHeight} 板` },
              { label: "晋级率", value: pct(s!.promotionRate) },
              {
                label: "昨涨停今均涨",
                value: signedPercent(s!.yesterdayAvgChange),
                tone: changeTone(s!.yesterdayAvgChange),
              },
            ]}
          />
        )}
      </Panel>
      {data?.available && (
        <>
          <Panel span={8} icon={Stairs} title="连板梯队">
            {data.ladder.length === 0 ? (
              <PanelEmpty>无涨停</PanelEmpty>
            ) : (
              <div className="flex flex-col gap-1 text-[12px]">
                {data.ladder.map((l) => (
                  <div key={l.height} className="flex gap-3">
                    <strong className="w-[64px] shrink-0 text-nc-bad">
                      {l.height} 板 · {l.count}
                    </strong>
                    <span className="min-w-0 text-muted-foreground">
                      {l.names.join("、")}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
          <BarsPanel
            span={4}
            title="涨停行业分布"
            items={data.industries.map((i) => ({
              key: i.name,
              name: i.name,
              value: `${i.count} 家`,
              pct: (i.count / data.industries[0]!.count) * 100,
            }))}
          />
          <BrowseSource
            label={`${poolLabels[pool]}池`}
            symbols={data.pools[pool].map((r) => r.symbol)}
          >
            <TablePanel
              span={12}
              title={`${poolLabels[pool]}池`}
              meta={`${data.pools[pool].length} 只`}
              actions={
                <Segmented
                  label="涨停板池"
                  value={pool}
                  onChange={setPool}
                  options={(Object.keys(poolLabels) as Pool[]).map((k) => ({
                    value: k,
                    label: `${poolLabels[k]} ${data.pools[k].length}`,
                  }))}
                />
              }
              columns={columns(pool)}
              rows={data.pools[pool]}
              rowKey={(r) => r.symbol}
              minWidth={880}
            />
          </BrowseSource>
        </>
      )}
    </PageGrid>
  );
}
