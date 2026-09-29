"use client";
import { useEffect, useRef, useState } from "react";
import { Notebook, ListBullets } from "@phosphor-icons/react/ssr";
import { api } from "~/trpc/react";
import {
  ledgerHistorySchema,
  type LedgerHistoryInput,
} from "~/lib/strategy-facts/signal-ledger-query";
import { PageGrid, Panel } from "../panels";
import { Button } from "../ui/button";
import { useTaskVisible } from "../workbench/use-task-visible";
import { archiveStamp } from "../research/archive-evidence";
import { SignalLedgerControls } from "./signal-ledger-controls";
import {
  LedgerInput,
  LedgerSelect,
  LedgerPaging,
  LedgerError,
  LedgerOptional,
  ledgerStrategyName,
  ledgerRunLabels,
} from "./ledger-fields";
import { LedgerDetail } from "./signal-ledger-detail";
import { LedgerHistoryPanels } from "./signal-ledger-history-panels";
import { LedgerAnalysisPanel } from "./signal-ledger-analysis";

type Cursor = NonNullable<LedgerHistoryInput["cursor"]>;
const storageKey = (filter: LedgerHistoryInput) =>
  `ledger-pages:${JSON.stringify(filter)}`;
function remember(key: string, value: unknown) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Optional restoration must not block reading. */
  }
}
export function SignalLedgerWorkspace() {
  const visible = useTaskVisible(),
    utils = api.useUtils();
  const [ready, setReady] = useState(false),
    [filter, setFilter] = useState<LedgerHistoryInput>({ horizon: 5 }),
    [draft, setDraft] = useState<LedgerHistoryInput>({ horizon: 5 });
  const [pages, setPages] = useState<(Cursor | undefined)[]>([undefined]),
    [selected, setSelected] = useState<string | null>(null),
    [error, setError] = useState("");
  const [advanced, setAdvanced] = useState(false),
    [analysis, setAnalysis] = useState(false),
    [history, setHistory] = useState(false),
    [decisions, setDecisions] = useState(false);
  const scroll = useRef(0),
    [returnId, setReturnId] = useState<string | null>(null),
    previousRun = useRef<string | undefined>(undefined);
  useEffect(() => {
    function read() {
      const url = new URL(window.location.href),
        raw = url.searchParams.get("ledger");
      let parsed: LedgerHistoryInput = { horizon: 5 };
      try {
        parsed = ledgerHistorySchema.parse(raw ? JSON.parse(raw) : {});
        delete parsed.cursor;
      } catch {
        setError("无效查询条件已重置，请重新查询");
      }
      setFilter(parsed);
      setDraft(parsed);
      setSelected(url.searchParams.get("signal"));
      let saved: unknown = null;
      try {
        saved = JSON.parse(
          sessionStorage.getItem(storageKey(parsed)) ?? "null",
        );
        const back = JSON.parse(
          sessionStorage.getItem("ledger-return") ?? "null",
        ) as { id?: string; scroll?: number } | null;
        if (
          back?.id === url.searchParams.get("signal") &&
          typeof back?.scroll === "number" &&
          Number.isFinite(back.scroll)
        )
          scroll.current = back.scroll;
      } catch {
        /* URL works with unavailable or damaged storage. */
      }
      setPages(
        Array.isArray(saved) &&
          saved.length &&
          saved.length <= 1000 &&
          saved.every(
            (cursor) =>
              cursor === null ||
              ledgerHistorySchema.safeParse({ ...parsed, cursor }).success,
          )
          ? saved.map((cursor) => cursor ?? undefined)
          : [undefined],
      );
      setReady(true);
    }
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  const summary = api.ledgerSummary.useQuery(undefined, {
    enabled: visible,
    refetchInterval: (query) => (query.state.data?.activeDate ? 3000 : 30000),
  });
  const query = api.ledgerHistory.useQuery(
    { ...filter, cursor: pages.at(-1) },
    { enabled: visible && ready && !selected, refetchOnWindowFocus: true },
  );
  const calendar = api.ledgerCalendar.useQuery(undefined, {
    enabled: visible && ready,
    staleTime: 60000,
  });
  useEffect(() => {
    if (
      !selected &&
      query.data &&
      !query.isFetching &&
      !query.data.rows.length &&
      pages.length > 1
    ) {
      const next = pages.slice(0, -1);
      setPages(next);
      remember(storageKey(filter), next);
    }
  }, [selected, query.data, query.isFetching, pages, filter]);
  useEffect(() => {
    const signature = summary.data
      ? `${summary.data.run?.date}:${summary.data.run?.status}`
      : undefined;
    if (signature && previousRun.current && signature !== previousRun.current) {
      void utils.ledgerHistory.invalidate();
      void utils.ledgerAnalysis.invalidate();
      void utils.ledgerRuns.invalidate();
      void utils.ledgerDetail.invalidate();
      void utils.ledgerRunDetail.invalidate();
      void utils.ledgerDecisions.invalidate();
    }
    if (signature) previousRun.current = signature;
  }, [summary.data, utils]);
  useEffect(() => {
    if (visible && ready && !selected) void query.refetch();
  }, [visible, ready, selected]);
  useEffect(() => {
    if (!returnId || selected || query.isFetching || !query.data) return;
    const frame = requestAnimationFrame(() => {
      const target = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          "button[data-ledger-signal]",
        ),
      ).find((button) => button.dataset.ledgerSignal === returnId);
      target?.focus({ preventScroll: true });
      window.scrollTo(0, scroll.current);
      setReturnId(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [returnId, selected, query.isFetching, query.data]);
  function navigate(signal: string | null, applied = filter) {
    const url = new URL(window.location.href);
    url.searchParams.set("ledger", JSON.stringify(applied));
    if (signal) url.searchParams.set("signal", signal);
    else url.searchParams.delete("signal");
    window.history.pushState(null, "", url);
    setSelected(signal);
  }
  function apply(input: LedgerHistoryInput) {
    const parsed = ledgerHistorySchema.safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "条件无效");
      return;
    }
    const { cursor: _, ...next } = parsed.data;
    setFilter(next);
    setDraft(next);
    setPages([undefined]);
    setError("");
    setReturnId(null);
    remember(storageKey(next), [null]);
    navigate(null, next);
  }
  function changePages(next: (Cursor | undefined)[]) {
    setPages(next);
    remember(storageKey(filter), next);
  }
  function open(id: string) {
    scroll.current = window.scrollY;
    remember("ledger-return", { id, scroll: scroll.current });
    navigate(id);
  }
  const current = summary.data?.run;
  return (
    <PageGrid>
      <Panel
        icon={Notebook}
        title="信号台账"
        meta="全市场本地A股日线向前观察 · 非策略业绩 · 落库不代表推送"
        actions={
          <Button
            size="sm"
            onClick={() => {
              void summary.refetch();
              if (!selected) void query.refetch();
              else void utils.ledgerDetail.invalidate(selected);
            }}
          >
            刷新台账
          </Button>
        }
      >
        <LedgerError
          message={summary.error?.message}
          stale={!!summary.data}
          onRetry={() => void summary.refetch()}
        />
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <span>
            {summary.data?.activeDate ? "当前任务：" : "最近任务："}
            {current
              ? `${current.date} · ${ledgerRunLabels[current.status]} · 已扫描 ${current.scanned}/${current.total}`
              : summary.isLoading
                ? "正在读取…"
                : "尚无记录"}
          </span>
          <span>GBBQ覆盖：{current?.actionCoverageEnd ?? "未知"}</span>
          <span>状态读取：{archiveStamp(summary.data?.readAt)}</span>
        </div>
        <p className="mt-2 text-xs text-nc-text-3">
          {summary.data?.activeDate
            ? "任务运行中，每3秒更新状态；结果在任务状态变化后刷新。"
            : "任务状态每30秒检查；历史列表不自动轮询。"}
        </p>
        <SignalLedgerControls
          date={summary.data?.activeDate ?? undefined}
          onChanged={() => void summary.refetch()}
        />
      </Panel>
      {selected ? (
        <LedgerDetail
          id={selected}
          onBack={() => {
            setReturnId(selected);
            navigate(null);
          }}
        />
      ) : (
        <Panel icon={ListBullets} title="信号记录" aria-label="信号记录">
          <form
            className="grid grid-cols-2 gap-3 md:grid-cols-4"
            onSubmit={(event) => {
              event.preventDefault();
              apply(draft);
            }}
          >
            <LedgerInput
              label="观察开始日期"
              type="date"
              value={draft.from}
              onChange={(value) =>
                setDraft({ ...draft, from: value || undefined })
              }
            />
            <LedgerInput
              label="观察结束日期"
              type="date"
              value={draft.to}
              onChange={(value) =>
                setDraft({ ...draft, to: value || undefined })
              }
            />
            <LedgerInput
              label="证券代码"
              value={draft.symbol}
              onChange={(value) =>
                setDraft({ ...draft, symbol: value || undefined })
              }
            />
            <LedgerSelect
              label="策略"
              value={draft.strategy}
              onChange={(value) =>
                setDraft({
                  ...draft,
                  strategy:
                    (value as LedgerHistoryInput["strategy"]) || undefined,
                })
              }
              options={[
                { value: "all", label: "全部策略" },
                { value: "czsc", label: "缠论" },
                { value: "dual-breakout", label: "双突破" },
              ]}
            />
            <LedgerSelect
              label="信号方向"
              value={draft.direction}
              onChange={(value) =>
                setDraft({
                  ...draft,
                  direction:
                    (value as LedgerHistoryInput["direction"]) || undefined,
                })
              }
              options={[
                { value: "all", label: "全部方向" },
                { value: "long", label: "向上" },
                { value: "short", label: "向下" },
              ]}
            />
            <LedgerInput
              label="原始质量"
              value={draft.quality}
              onChange={(value) =>
                setDraft({ ...draft, quality: value || undefined })
              }
            />
            <div className="col-span-2 flex flex-wrap items-end gap-2">
              <Button type="submit" size="sm">
                查询信号
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => apply({ horizon: 5 })}
              >
                全部历史
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-expanded={advanced}
                onClick={() => setAdvanced(!advanced)}
              >
                更多筛选
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!calendar.data?.from || !calendar.data.to}
                onClick={() => {
                  if (calendar.data?.from && calendar.data.to)
                    apply({
                      ...draft,
                      from: calendar.data.from,
                      to: calendar.data.to,
                    });
                }}
              >
                最近30交易日
              </Button>
            </div>
            {advanced && (
              <>
                <LedgerSelect
                  label="结果期限"
                  value={String(draft.horizon ?? 5)}
                  onChange={(value) =>
                    setDraft({
                      ...draft,
                      horizon: Number(value) as 5 | 10 | 20,
                    })
                  }
                  options={[5, 10, 20].map((value) => ({
                    value: String(value),
                    label: `T+${value}`,
                  }))}
                />
                <LedgerSelect
                  label="结果状态"
                  value={draft.state}
                  onChange={(value) =>
                    setDraft({
                      ...draft,
                      state:
                        (value as LedgerHistoryInput["state"]) || undefined,
                    })
                  }
                  options={[
                    { value: "all", label: "全部结果" },
                    { value: "pending", label: "待观察" },
                    { value: "valid", label: "已固定·有效" },
                    { value: "blank", label: "已固定·留空" },
                  ]}
                />
              </>
            )}
          </form>
          <LedgerError
            message={calendar.error?.message}
            onRetry={() => void calendar.refetch()}
          />
          {!calendar.data?.from && !calendar.isLoading && (
            <p className="mt-2 text-xs text-nc-text-3">
              没有足够的已知交易日期，最近30交易日不可用；可手动指定日期。
            </p>
          )}
          <p className="mt-3 break-words text-xs text-nc-text-2">
            已应用：{filter.from ?? "全部历史"} 至 {filter.to ?? "最新记录"} ·{" "}
            {filter.symbol ?? "全部证券"} ·{" "}
            {filter.strategy ? ledgerStrategyName(filter.strategy) : "全部策略"}{" "}
            ·{" "}
            {filter.direction === "long"
              ? "向上"
              : filter.direction === "short"
                ? "向下"
                : "全部方向"}{" "}
            · 质量{filter.quality ?? "不限"} · T+{filter.horizon ?? 5} ·{" "}
            {filter.state === "pending"
              ? "待观察"
              : filter.state === "valid"
                ? "已固定·有效"
                : filter.state === "blank"
                  ? "已固定·留空"
                  : "全部结果"}
          </p>
          <LedgerError
            message={error || query.error?.message}
            stale={!!query.data}
            onRetry={() => {
              setError("");
              void query.refetch();
            }}
          />
          <p role="status" className="my-3 text-sm">
            {query.isLoading
              ? "正在读取信号…"
              : query.data
                ? `匹配 ${query.data.total} 条 · 待观察 ${query.data.pending} · 有效 ${query.data.valid} · 留空 ${query.data.blank}（T+${query.data.horizon}）`
                : "尚未读取信号"}
            {query.isFetching && !query.isLoading ? " · 更新中" : ""}
          </p>
          {query.data && (
            <p className="text-xs text-nc-text-3">
              匹配信号中仍有未固定期限：{query.data.pendingSignals}条。读取于
              {archiveStamp(query.data.readAt)}；结果状态发生变化时请刷新。
            </p>
          )}
          {query.data?.rows.length === 0 && (
            <p className="my-4">
              {query.data.totalAll
                ? "当前筛选没有匹配信号，请调整条件。"
                : "尚无向前信号记录。交易日15:05后保持应用运行并准备当日日线；不补录历史。"}
            </p>
          )}
          <div className="mt-3 space-y-2">
            {query.data?.rows.map((row) => (
              <article
                key={row.id}
                className="grid grid-cols-2 gap-2 rounded border border-nc-border p-3 text-sm lg:grid-cols-6"
              >
                <div>
                  <strong>{row.symbol.toUpperCase()}</strong>
                  <div className="text-xs">{row.observedDate}</div>
                </div>
                <div>
                  {ledgerStrategyName(row.strategy)} ·{" "}
                  {row.direction === "long" ? "向上" : "向下"}
                  <div className="text-xs">
                    质量 {row.quality} · 评分 {row.score}
                  </div>
                </div>
                {([5, 10, 20] as const).map((h) => {
                  const out = row.outcomes.find((value) => value.horizon === h);
                  return (
                    <div key={h}>
                      <div className="text-xs text-nc-text-3">T+{h}</div>
                      <span>
                        {!out?.settled
                          ? "待观察"
                          : out.returnPct === null
                            ? "已固定·留空"
                            : `${out.returnPct.toFixed(2)}%`}
                      </span>
                    </div>
                  );
                })}
                <Button
                  size="sm"
                  variant="outline"
                  data-ledger-signal={row.id}
                  onClick={() => open(row.id)}
                >
                  查看依据
                </Button>
              </article>
            ))}
          </div>
          <LedgerPaging
            page={pages.length}
            next={!!query.data?.nextCursor}
            busy={query.isFetching}
            total={query.data?.total ?? 0}
            label="信号"
            onPrevious={() => changePages(pages.slice(0, -1))}
            onNext={() => {
              if (query.data?.nextCursor)
                changePages([...pages, query.data.nextCursor]);
            }}
          />
        </Panel>
      )}
      <LedgerOptional
        title="全样本分析"
        open={analysis}
        onToggle={() => setAnalysis(!analysis)}
      >
        <LedgerAnalysisPanel />
      </LedgerOptional>
      <LedgerOptional
        title="每日任务历史"
        open={history}
        onToggle={() => setHistory(!history)}
      >
        <LedgerHistoryPanels kind="runs" />
      </LedgerOptional>
      <LedgerOptional
        title="投递决策历史"
        open={decisions}
        onToggle={() => setDecisions(!decisions)}
      >
        <LedgerHistoryPanels kind="decisions" />
      </LedgerOptional>
    </PageGrid>
  );
}
