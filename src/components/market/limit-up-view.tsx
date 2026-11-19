"use client";
import { formatNumber as displayNumber } from "trading-strategy-core/format-number";

import { useEffect, useState } from "react";
import { Fire, Stairs, Tag } from "@phosphor-icons/react/ssr";
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
import { useNow } from "../workbench/use-now";
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
import { LimitDailyTrend } from "./limit-daily-trend";
import { LimitIntradayTrend } from "./limit-intraday-trend";
import { BrowseSource } from "./open-chart";

const poolLabels: Record<Pool, string> = {
  zt: "涨停",
  zb: "炸板",
  dt: "跌停",
  yzt: "昨日涨停",
};
type PoolSort = "original" | "change" | "streak" | "firstSeal";
type ConceptFilter = { code: string; name: string };
type PoolFilter = {
  page: number;
  industry: string;
  height: number | null;
  sort: PoolSort;
  concept: ConceptFilter | null;
};
const blankPoolFilter = (): PoolFilter => ({
  page: 1,
  industry: "",
  height: null,
  sort: "original",
  concept: null,
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
  v == null ? "—" : `${displayNumber(v / 1e8, 2)}亿`;
const pct = (v: number | null, suffix = "%") =>
  v == null ? "—" : `${displayNumber(v, 1)}${suffix}`;
const beijingTime = (epoch: number | null) =>
  epoch == null
    ? "—"
    : new Date(epoch).toLocaleString("zh-CN", {
        hour12: false,
        timeZone: "Asia/Shanghai",
      });

/** 首封时间只接受 00–23:00–59:00–59；缺值或非法值视为未知，排在末尾。 */
export function firstSealSeconds(value: string | null): number | null {
  if (!value) return null;
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, h, m, s] = match;
  const hours = Number(h),
    minutes = Number(m),
    seconds = Number(s);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

/** 同一 symbol 只保留首次出现，避免概念人数与表格家数重复计算。 */
function uniqueRows(rows: readonly LimitPoolRow[]): LimitPoolRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.symbol)) return false;
    seen.add(row.symbol);
    return true;
  });
}

/** 有效首封时间升序；同秒保留来源顺序；未知时间保留并排在末尾。 */
export function sortRowsByFirstSeal(
  rows: readonly LimitPoolRow[],
): LimitPoolRow[] {
  return rows
    .map((row, index) => ({
      row,
      index,
      seal: firstSealSeconds(row.firstSeal),
    }))
    .sort((a, b) => {
      if (a.seal === null || b.seal === null)
        return a.seal === b.seal ? a.index - b.index : a.seal === null ? 1 : -1;
      return a.seal - b.seal || a.index - b.index;
    })
    .map((entry) => entry.row);
}

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
      cell: (r) => (
        <span className="tabular-nums">{displayNumber(r.price, 2)}</span>
      ),
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
      cell: (r) =>
        pool === "zt"
          ? firstSealSeconds(r.firstSeal) === null
            ? "—"
            : (r.firstSeal ?? "—")
          : pool === "dt"
            ? (r.lastSeal ?? "—")
            : (r.firstSeal ?? "—"),
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
  const now = useNow(60000);
  const date =
    useLimitUpStore((s) => s.date) ??
    (now === null
      ? ""
      : new Date(now + 8 * 3600000).toISOString().slice(0, 10));
  const setDate = useLimitUpStore((s) => s.setDate);
  const pool = useLimitUpStore((s) => s.pool);
  const setPool = useLimitUpStore((s) => s.setPool);
  const [dateDraft, setDateDraft] = useState(date);
  const [poolFilters, setPoolFilters] = useState(blankPoolFilters);
  const [conceptOpen, setConceptOpen] = useState(false);
  useEffect(() => {
    setPoolFilters(blankPoolFilters());
    // 切日清概念；历史日期不展示概念分布，也不保留展开状态。
    setConceptOpen(false);
    if (date) setDateDraft((draft) => draft || date);
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
  /** 普通切池保留各池分页与筛选记忆，只清离开池的概念。 */
  function selectPool(next: Pool) {
    if (next === pool) return;
    const leaving = pool;
    setPool(next);
    setPoolFilters((previous) => ({
      ...previous,
      [leaving]: { ...previous[leaving], concept: null },
    }));
  }
  /** 换行业时清概念；高度筛选也归零，沿用 R8 的整行业回看。 */
  function drillIndustry(patch: Partial<PoolFilter>) {
    setPool("zt");
    changePoolFilter({ ...patch, concept: null }, "zt");
  }
  /** 点概念：切回涨停池，清行业和高度，使概念人数与打开表一致。 */
  function openConcept(concept: ConceptFilter) {
    setPool("zt");
    changePoolFilter(
      { concept, industry: "", height: null, sort: "firstSeal" },
      "zt",
    );
  }
  const query = api.limitSentiment.useQuery(
    { date },
    {
      enabled: visible && now !== null,
      refetchInterval: date === today() ? 60000 : false,
      retry: false,
    },
  );
  const data = query.data;
  const s = data?.stats;
  // IndexedDB 里可能残留没有 intraday 的旧响应，日期相同也不能直接挂图。
  const intraday = data?.date === date ? data.intraday : undefined;
  // 概念成员只在用户展开时读取；键含四池 fetchedAt，行情刷新后随原有
  // 刷新重取，不新建定时器。刷新期间新键没有旧分布可冒充。
  const conceptQuery = api.limitConcepts.useQuery(
    { date, fetchedAt: data?.fetchedAt ?? 0 },
    {
      enabled:
        visible &&
        conceptOpen &&
        date === today() &&
        data?.date === date &&
        data?.available === true,
      retry: false,
      refetchInterval: false,
    },
  );
  const conceptData = conceptQuery.data;
  // 条件表达式内直接收窄 conceptData，避免用布尔变量丢失非空判断。
  const conceptMembers =
    current.concept !== null &&
    !conceptQuery.isError &&
    conceptData?.status === "ready"
      ? new Set(
          conceptData.concepts.find(
            (concept) => concept.code === current.concept!.code,
          )?.symbols ?? [],
        )
      : null;
  const conceptReady = conceptMembers !== null;
  // 选中概念但成员未真实完成时，表格不展示“筛选后 0 家”。
  const conceptUnavailable = current.concept !== null && !conceptReady;
  const conceptStatusText = !current.concept
    ? null
    : conceptQuery.isError
      ? `概念成员读取失败：${conceptQuery.error.message}`
      : (conceptData?.message ??
        (conceptQuery.isLoading
          ? "正在读取本机概念名单…"
          : !conceptOpen
            ? "概念分布已收起；展开后重新读取本机概念名单。"
            : "概念成员尚未同步；请刷新行情后重试。"));
  const poolRows = uniqueRows(data?.pools[pool] ?? []);
  const filtered = conceptUnavailable
    ? []
    : poolRows.filter(
        (row) =>
          (!current.industry || row.industry === current.industry) &&
          (current.height === null || row.streak === current.height) &&
          (!current.concept || (conceptMembers?.has(row.symbol) ?? false)),
      );
  const firstSealSort = pool === "zt" && current.sort === "firstSeal";
  const rows = firstSealSort ? sortRowsByFirstSeal(filtered) : [...filtered];
  if (!firstSealSort && current.sort !== "original")
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
  const missingSeal = firstSealSort
    ? rows.filter((row) => firstSealSeconds(row.firstSeal) === null).length
    : 0;
  const poolMeta = conceptUnavailable
    ? `概念 ${current.concept?.name ?? ""} · 概念成员未就绪`
    : `筛选后 ${rows.length} / ${poolRows.length} 只${current.industry ? ` · ${current.industry}` : ""}${current.height !== null ? ` · ${current.height}板` : ""}${current.concept ? ` · 概念 ${current.concept.name}` : ""}${firstSealSort ? " · 首封时间升序" : ""}${missingSeal ? ` · ${missingSeal} 只缺首封时间，已排末尾` : ""}`;
  const pageCount = Math.max(1, Math.ceil(rows.length / 50));
  // 概念浏览按家数降序；同数沿用服务端稳定源顺序。
  const conceptRows =
    conceptData?.status === "ready"
      ? conceptData.concepts
          .map((concept, index) => ({ concept, index }))
          .sort(
            (a, b) =>
              b.concept.symbols.length - a.concept.symbols.length ||
              a.index - b.index,
          )
          .map((entry) => entry.concept)
      : [];
  const page = Math.min(current.page, pageCount);
  // Client wall-clock dates must not enter server or hydration markup.
  if (now === null) return <p role="status">正在确定查询日期…</p>;
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
      {intraday && intraday.date === date && (
        <LimitIntradayTrend date={date} intraday={intraday} />
      )}
      <LimitDailyTrend date={date} visible={visible} />
      {data?.available && (
        <>
          <BrowseSource
            label={`${poolLabels[pool]}池`}
            symbols={rows.map((r) => r.symbol)}
          >
            <TablePanel
              span={12}
              title={`${poolLabels[pool]}池`}
              meta={poolMeta}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <Segmented
                    label="涨停板池"
                    value={pool}
                    onChange={selectPool}
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
                      {pool === "zt" && (
                        <SelectItem value="firstSeal">首封时间升序</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  {(current.industry ||
                    current.height !== null ||
                    current.concept) && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        changePoolFilter({
                          industry: "",
                          height: null,
                          concept: null,
                        })
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
              empty={
                conceptUnavailable ? (
                  <span className="flex flex-col items-start gap-2 text-left">
                    <span role="alert">{conceptStatusText}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={query.isFetching}
                      onClick={() => {
                        if (!conceptOpen) setConceptOpen(true);
                        else void query.refetch();
                      }}
                    >
                      {conceptOpen ? "刷新行情" : "展开概念分布"}
                    </Button>
                  </span>
                ) : current.concept && conceptReady && rows.length === 0 ? (
                  "该概念当前没有涨停成分。"
                ) : (
                  "当前筛选下无成分，可清除筛选或切换证券池。"
                )
              }
            >
              {!conceptUnavailable && (
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
              )}
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
                  aria-label={`打开${i.name}行业涨停，按首封时间升序`}
                  onClick={() =>
                    drillIndustry({
                      industry: i.name,
                      sort: "firstSeal",
                      height: null,
                    })
                  }
                >
                  {i.name}
                </Button>
              ),
              value: `${i.count} 家`,
              pct: (i.count / data.industries[0]!.count) * 100,
            }))}
          />
          {date === today() && (
            <Panel
              span={12}
              icon={Tag}
              title="涨停概念分布"
              actions={
                <Button
                  variant="outline"
                  size="sm"
                  aria-expanded={conceptOpen}
                  aria-controls="limit-concept-distribution"
                  onClick={() => setConceptOpen((open) => !open)}
                >
                  {conceptOpen ? "收起" : "展开概念分布"}
                </Button>
              }
              note="数据：东方财富已确认涨停池 ∩ 本机通达信当前概念成分。同一证券可属于多个概念；有映射与未覆盖按证券去重。只读本机名单，不请求上游四池。"
            >
              <div id="limit-concept-distribution">
                {!conceptOpen ? (
                  <p className="m-0 text-sm text-nc-text-3">
                    展开后读取一次本机概念名单；不展开不读取，也不会新建定时刷新。
                  </p>
                ) : conceptQuery.isLoading ? (
                  <PanelEmpty>正在读取本机概念名单…</PanelEmpty>
                ) : conceptQuery.isError ? (
                  <p role="alert" className="m-0 text-[13px] text-nc-bad">
                    读取失败：{conceptQuery.error.message}
                  </p>
                ) : !conceptData ? (
                  <PanelEmpty>正在读取…</PanelEmpty>
                ) : (
                  <>
                    <p role="status" className="m-0 text-sm text-nc-text-2">
                      {conceptData.status === "ready"
                        ? `涨停 ${conceptData.limitUp} 只 · 有概念映射 ${conceptData.mapped} 只 · 未覆盖 ${conceptData.uncovered} 只`
                        : conceptData.message}
                    </p>
                    <p className="mb-2 mt-1 text-[12px] text-nc-text-3">
                      四池读取于 {beijingTime(conceptData.poolFetchedAt)}
                      {" · "}本机概念名单读取于{" "}
                      {beijingTime(conceptData.blocksObservedAt)}
                    </p>
                    {conceptData.status === "ready" &&
                      (conceptRows.length === 0 ? (
                        <p className="m-0 text-[13px] text-nc-text-3">
                          {conceptData.limitUp === 0
                            ? "当日已确认涨停池为空，暂无概念映射。"
                            : "概念名单存在，但当日涨停没有命中任何概念。"}
                        </p>
                      ) : (
                        <div
                          role="group"
                          aria-label="涨停概念分布列表"
                          className="grid max-h-64 grid-cols-2 gap-1 overflow-y-auto pr-1 md:grid-cols-3"
                        >
                          {conceptRows.map((concept) => {
                            const active =
                              current.concept?.code === concept.code;
                            return (
                              <Button
                                key={concept.code}
                                variant={active ? "default" : "outline"}
                                size="sm"
                                className="justify-between!"
                                aria-pressed={active}
                                aria-label={`筛选${concept.name}概念涨停，按首封时间升序`}
                                onClick={() =>
                                  openConcept({
                                    code: concept.code,
                                    name: concept.name,
                                  })
                                }
                              >
                                <span className="min-w-0 truncate">
                                  {concept.name}
                                </span>
                                <span className="tabular-nums">
                                  {concept.symbols.length} 只
                                </span>
                              </Button>
                            );
                          })}
                        </div>
                      ))}
                  </>
                )}
              </div>
            </Panel>
          )}
        </>
      )}
    </PageGrid>
  );
}
