"use client";
import { useEffect, useState } from "react";
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
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../ui/select";
import { ChartSymbolLink } from "./chart-symbol-link";
import { BrowseSource } from "./open-chart";

const poolLabels: Record<Pool, string> = {
  zt: "涨停",
  zb: "炸板",
  dt: "跌停",
  yzt: "昨日涨停",
};
type PoolFilter = {
  page: number;
  industry: string;
  height: number | null;
  sort: "original" | "change" | "streak";
};
const blankPoolFilter = (): PoolFilter => ({
  page: 1,
  industry: "",
  height: null,
  sort: "original",
});
const blankPoolFilters = (): Record<Pool, PoolFilter> => ({
  zt: blankPoolFilter(),
  zb: blankPoolFilter(),
  dt: blankPoolFilter(),
  yzt: blankPoolFilter(),
});
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
      key: "price",
      header: "价格",
      align: "right",
      cell: (r) => <span className="tabular-nums">{r.price.toFixed(2)}</span>,
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
  const [dateDraft, setDateDraft] = useState(date);
  const [poolFilters, setPoolFilters] = useState(blankPoolFilters);
  useEffect(() => {
    setPoolFilters(blankPoolFilters());
  }, [date]);
  const current = poolFilters[pool];
  function changePoolFilter(patch: Partial<PoolFilter>, target: Pool = pool) {
    setPoolFilters((previous) => ({
      ...previous,
      [target]: { ...previous[target], page: 1, ...patch },
    }));
  }
  function drill(patch: Partial<PoolFilter>) {
    setPool("zt");
    changePoolFilter(patch, "zt");
  }
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
  const rows = (data?.pools[pool] ?? []).filter(
    (row) =>
      (!current.industry || row.industry === current.industry) &&
      (current.height === null || row.streak === current.height),
  );
  if (current.sort !== "original")
    rows.sort((a, b) => {
      const left = current.sort === "change" ? a.changePct : a.streak,
        right = current.sort === "change" ? b.changePct : b.streak;
      return left == null
        ? right == null
          ? 0
          : 1
        : right == null
          ? -1
          : right - left;
    });
  const pageCount = Math.max(1, Math.ceil(rows.length / 50));
  const page = Math.min(current.page, pageCount);
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
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (dateDraft && dateDraft <= today()) setDate(dateDraft);
            }}
          >
            <Input
              type="date"
              value={dateDraft}
              max={today()}
              required
              onChange={(e) => setDateDraft(e.target.value)}
              className="h-7 w-[150px]"
              aria-label="交易日"
            />
            <Button
              size="sm"
              type="submit"
              disabled={!dateDraft || dateDraft > today()}
            >
              查询日期
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              刷新
            </Button>
          </form>
        }
        note="数据：东方财富涨停板行情中心（push2ex，串行限流）。晋级率 = 昨日涨停今日仍在涨停池的占比。"
      >
        <p className="mb-3 text-sm text-nc-text-3" role="status">
          已查询 {date}
          {dateDraft !== date ? " · 日期已修改，查询后生效" : ""}
          {query.dataUpdatedAt
            ? ` · 读取于 ${new Date(query.dataUpdatedAt).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}`
            : ""}
        </p>
        {query.isError ? (
          <p role="alert" className="m-0 text-[13px] text-nc-bad">
            读取失败：{query.error.message}
            {data ? "；下方保留上次读取的成分，并非本次刷新结果。" : ""}
          </p>
        ) : !data ? (
          <PanelEmpty>正在读取…</PanelEmpty>
        ) : !data.available ? (
          <PanelEmpty>{date} 非交易日或尚无数据</PanelEmpty>
        ) : (
          <StatCards
            items={[
              { label: "炸板率", value: pct(s!.breakRate) },
              { label: "最高连板", value: `${s!.maxHeight} 板` },
              { label: "晋级率", value: pct(s!.promotionRate) },
              { label: "涨停", value: s!.limitUp, tone: "bad" },
              { label: "炸板", value: s!.broken, tone: "warn" },
              { label: "跌停", value: s!.limitDown, tone: "neutral" },
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
          <BrowseSource
            label={`${poolLabels[pool]}池`}
            symbols={rows.map((r) => r.symbol)}
          >
            <TablePanel
              span={12}
              title={`${poolLabels[pool]}池`}
              meta={`筛选后 ${rows.length} / ${data.pools[pool].length} 只${current.industry ? ` · ${current.industry}` : ""}${current.height !== null ? ` · ${current.height}板` : ""}`}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <Segmented
                    label="涨停板池"
                    value={pool}
                    onChange={setPool}
                    options={(Object.keys(poolLabels) as Pool[]).map((k) => ({
                      value: k,
                      label: `${poolLabels[k]} ${data.pools[k].length}`,
                    }))}
                  />
                  <Select
                    value={current.sort}
                    onValueChange={(value) =>
                      changePoolFilter({ sort: value as PoolFilter["sort"] })
                    }
                  >
                    <SelectTrigger aria-label="当前池排序">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="original">来源顺序</SelectItem>
                      <SelectItem value="change">涨跌幅降序</SelectItem>
                      <SelectItem value="streak">
                        {pool === "dt" ? "连续跌停" : "连板数"}降序
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {(current.industry || current.height !== null) && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        changePoolFilter({ industry: "", height: null })
                      }
                    >
                      清除成分筛选
                    </Button>
                  )}
                </div>
              }
              columns={columns(pool)}
              rows={rows.slice((page - 1) * 50, page * 50)}
              rowKey={(r) => r.symbol}
              minWidth={960}
              empty="当前筛选下无成分，可清除筛选或切换证券池。"
            >
              <nav
                aria-label="当前证券池分页"
                className="mt-4 flex flex-wrap items-center justify-between gap-2"
              >
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 1}
                  onClick={() => changePoolFilter({ page: page - 1 })}
                >
                  上一页
                </Button>
                <span className="text-sm text-nc-text-3">
                  第 {page} / {pageCount} 页 · 每页50只
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === pageCount}
                  onClick={() => changePoolFilter({ page: page + 1 })}
                >
                  下一页
                </Button>
              </nav>
            </TablePanel>
          </BrowseSource>
          <Panel span={8} icon={Stairs} title="连板梯队">
            {data.ladder.length === 0 ? (
              <PanelEmpty>无涨停</PanelEmpty>
            ) : (
              <div className="flex flex-col gap-1 text-[13px]">
                {data.ladder.map((l) => (
                  <div key={l.height} className="flex gap-3">
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`筛选${l.height}连板涨停股`}
                      onClick={() => drill({ height: l.height })}
                    >
                      {l.height} 板 · {l.count}
                    </Button>
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
              name: (
                <Button
                  variant="plain"
                  size="sm"
                  onClick={() => drill({ industry: i.name })}
                >
                  {i.name}
                </Button>
              ),
              value: `${i.count} 家`,
              pct: (i.count / data.industries[0]!.count) * 100,
            }))}
          />
        </>
      )}
    </PageGrid>
  );
}
