"use client";
import { useEffect, useRef, useState } from "react";
import { ListChecks, Queue } from "@phosphor-icons/react/ssr";
import { api } from "~/trpc/react";
import {
  intradayHistorySchema,
  type IntradayHistoryInput,
} from "~/lib/strategy-facts/intraday-history";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../ui/select";
import { Panel } from "../panels";
import { useTaskVisible } from "../workbench/use-task-visible";
import {
  ArchiveEvidence,
  ArchiveText,
  archiveStamp,
} from "../research/archive-evidence";
import { useArchiveDownload } from "../research/use-archive-download";

type Cursor = NonNullable<IntradayHistoryInput["cursor"]>;
const stateLabels = {
  pending: "未核对",
  retry: "数据不足 · 待重试",
  settled: "已核对",
};
const batchLabels = {
  running: "执行中",
  complete: "完成",
  partial: "部分完成",
  failed: "失败",
  missed: "已错过",
};
const dayNow = () =>
  new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
function BatchReasons({
  results,
}: {
  results: { symbol: string; reason: string | null }[];
}) {
  const [page, setPage] = useState(0);
  const rows = results.filter((row) => row.reason);
  const current = Math.min(page, Math.max(0, Math.ceil(rows.length / 20) - 1));
  return (
    <div className="space-y-2">
      {rows.length === 0 ? (
        <p>没有数据失败或未完成原因。无买入信号的成功观测仍可在结果中查看。</p>
      ) : (
        <>
          <p>
            共 {rows.length} 条 · 第 {current + 1} 组
          </p>
          {rows.slice(current * 20, current * 20 + 20).map((row, index) => (
            <p key={`${row.symbol}-${index}`} className="break-words">
              {row.symbol.toUpperCase()}：{row.reason}
            </p>
          ))}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              上一组原因
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={(current + 1) * 20 >= rows.length}
              onClick={() => setPage(current + 1)}
            >
              下一组原因
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
function Choice({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Record<string, string>;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs">
      {label}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(options).map(([key, text]) => (
            <SelectItem key={key} value={key}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

export function IntradayHistoryPanel({ running }: { running: boolean }) {
  const visible = useTaskVisible();
  const utils = api.useUtils();
  const [ready, setReady] = useState(false);
  const [filter, setFilter] = useState<IntradayHistoryInput>({});
  const [draft, setDraft] = useState<IntradayHistoryInput>({});
  const [cursors, setCursors] = useState<(Cursor | undefined)[]>([undefined]);
  const [selected, setSelected] = useState<string | null>(null);
  const [returnTarget, setReturnTarget] = useState<string | null>(null);
  const [error, setError] = useState("");
  const savedScroll = useRef(0);
  useEffect(() => {
    function read() {
      const url = new URL(window.location.href);
      const raw = url.searchParams.get("preselect");
      try {
        const parsed = intradayHistorySchema.parse(
          raw ? JSON.parse(raw) : { from: dayNow(), to: dayNow() },
        );
        setFilter(parsed);
        setDraft(parsed);
        setSelected(url.searchParams.get("observation"));
        let saved: string | null = null;
        try {
          saved = sessionStorage.getItem(
            `intraday-page:${JSON.stringify(parsed)}`,
          );
          const back = JSON.parse(
            sessionStorage.getItem("intraday-return") ?? "null",
          ) as { id?: string; scroll?: number } | null;
          if (
            back?.id === url.searchParams.get("observation") &&
            typeof back?.scroll === "number" &&
            Number.isFinite(back.scroll)
          )
            savedScroll.current = back.scroll;
        } catch {
          /* The URL remains usable when browser storage is disabled. */
        }
        let pages: unknown = [];
        try {
          pages = saved ? (JSON.parse(saved) as unknown) : [];
        } catch {
          /* Ignore damaged optional pagination state. */
        }
        setCursors(
          Array.isArray(pages) &&
            pages.length &&
            pages.length <= 1000 &&
            pages.every(
              (p) =>
                p === null ||
                intradayHistorySchema.safeParse({ ...parsed, cursor: p })
                  .success,
            )
            ? pages.map((p) => p ?? undefined)
            : [undefined],
        );
      } catch {
        setFilter({ from: dayNow(), to: dayNow() });
        setDraft({ from: dayNow(), to: dayNow() });
        setCursors([undefined]);
        setError("已忽略无效的历史查询条件");
      }
      setReady(true);
    }
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  const query = api.intradayHistory.useQuery(
    { ...filter, cursor: cursors.at(-1) },
    {
      enabled: visible && ready,
      refetchInterval: running ? 5000 : false,
      refetchOnWindowFocus: true,
    },
  );
  useEffect(() => {
    if (visible && ready) void query.refetch();
  }, [running, visible, ready]);
  const storage = api.intradayStorage.useQuery(undefined, {
    enabled: visible,
    staleTime: 60000,
    refetchInterval: 60000,
  });
  function address(next: IntradayHistoryInput, id: string | null) {
    const url = new URL(window.location.href);
    url.searchParams.set("preselect", JSON.stringify(next));
    if (id) url.searchParams.set("observation", id);
    else url.searchParams.delete("observation");
    window.history.replaceState(window.history.state, "", url);
  }
  function page(next: (Cursor | undefined)[]) {
    setCursors(next);
    try {
      sessionStorage.setItem(
        `intraday-page:${JSON.stringify(filter)}`,
        JSON.stringify(next),
      );
    } catch {
      /* Storage is optional; in-memory navigation remains available. */
    }
  }
  function apply(next: IntradayHistoryInput) {
    const parsed = intradayHistorySchema.safeParse(next);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "查询条件无效");
      return;
    }
    setError("");
    setFilter(parsed.data);
    setDraft(parsed.data);
    setCursors([undefined]);
    setSelected(null);
    setReturnTarget(null);
    address(parsed.data, null);
    try {
      sessionStorage.removeItem(`intraday-page:${JSON.stringify(parsed.data)}`);
    } catch {}
  }
  function close() {
    setReturnTarget(selected);
    setSelected(null);
    address(filter, null);
  }
  useEffect(() => {
    if (!returnTarget || !query.data || query.isFetching || selected) return;
    const frame = requestAnimationFrame(() => {
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          "button[data-observation]",
        ),
      );
      const target =
        buttons.find((button) => button.dataset.observation === returnTarget) ??
        buttons[0];
      window.scrollTo(0, savedScroll.current);
      target?.focus({ preventScroll: true });
      setReturnTarget(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [returnTarget, query.data, query.isFetching, selected]);
  useEffect(() => {
    if (
      query.data?.rows.length === 0 &&
      cursors.length > 1 &&
      !query.isFetching
    ) {
      page(cursors.slice(0, -1));
    }
  }, [query.data, query.isFetching, cursors.length]);
  const stats = query.data?.stats;
  return (
    <>
      <Panel
        span={12}
        icon={ListChecks}
        title="候选与收盘核对"
        note="日期与时点均为北京时间。有信号才计入候选；数据不足会保留原因并等待重试。统计覆盖当前筛选的完整结果。"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
          >
            刷新结果
          </Button>
        }
      >
        <form
          className="grid grid-cols-2 gap-3 md:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            apply(draft);
          }}
        >
          <label className="flex min-w-0 flex-col gap-1 text-xs">
            开始日期
            <Input
              type="date"
              value={draft.from ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, from: e.target.value || undefined })
              }
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs">
            结束日期
            <Input
              type="date"
              value={draft.to ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, to: e.target.value || undefined })
              }
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs">
            证券代码
            <Input
              placeholder="如 sh600000"
              value={draft.symbol ?? ""}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  symbol: e.target.value.trim().toLowerCase() || undefined,
                })
              }
            />
          </label>
          <Choice
            label="预选时段"
            value={draft.slot ?? "all"}
            onChange={(value) =>
              setDraft({
                ...draft,
                slot: value === "all" ? undefined : (value as "noon" | "late"),
              })
            }
            options={{ all: "全部时段", noon: "午盘", late: "尾盘" }}
          />
          <Choice
            label="核对状态"
            value={draft.state ?? "all"}
            onChange={(value) =>
              setDraft({
                ...draft,
                state:
                  value === "all"
                    ? undefined
                    : (value as "pending" | "retry" | "settled"),
              })
            }
            options={{ all: "全部状态", ...stateLabels }}
          />
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={draft.signalsOnly ?? false}
              onCheckedChange={(value) =>
                setDraft({ ...draft, signalsOnly: value === true })
              }
            />
            仅有预选信号
          </label>
          <div className="col-span-2 flex flex-wrap gap-2">
            <Button type="submit">查询</Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => apply({ from: dayNow(), to: dayNow() })}
            >
              重置为今日
            </Button>
            <Button type="button" variant="outline" onClick={() => apply({})}>
              全部历史
            </Button>
          </div>
        </form>
        {filter.sessionId && (
          <p className="break-all text-xs">
            限定批次：{filter.sessionId}{" "}
            <Button
              size="sm"
              variant="outline"
              onClick={() => apply({ ...filter, sessionId: undefined })}
            >
              清除批次
            </Button>
          </p>
        )}
        {(error || query.error) && (
          <p role="alert" className="text-sm text-nc-bad">
            {error || query.error?.message}。
            {query.data ? "保留上次成功结果，可能已过期。" : ""}
          </p>
        )}
        <p role="status" className="text-sm">
          {query.isLoading
            ? "正在读取观测…"
            : !query.data
              ? "尚未取得观测结果"
              : `匹配 ${query.data?.total ?? 0} 条 · 有信号 ${stats?.candidates ?? 0} · 未核对 ${stats?.pending ?? 0} · 待重试 ${stats?.retry ?? 0} · 已核对 ${stats?.settled ?? 0}`}
          {query.isFetching && !query.isLoading ? " · 更新中" : ""}
        </p>
        <div className="space-y-2" aria-label="预选记录">
          {query.data?.rows.map((row) => (
            <article
              key={row.id}
              className="grid grid-cols-2 gap-2 rounded border border-nc-border p-3 text-sm md:grid-cols-5"
            >
              <div>
                <strong>{row.symbol.toUpperCase()}</strong>
                <div className="text-xs text-nc-text-3">
                  RPS {row.rps.toFixed(2)}
                </div>
              </div>
              <div>
                {row.signalCount
                  ? `${row.signalCount} 项预选信号`
                  : "无预选信号"}
              </div>
              <div className="text-xs">
                截止 {row.barCutoff.slice(5, 16).replace("T", " ")}
              </div>
              <div>{stateLabels[row.state]}</div>
              <Button
                size="sm"
                variant="outline"
                data-observation={row.id}
                onClick={() => {
                  savedScroll.current = window.scrollY;
                  try {
                    sessionStorage.setItem(
                      "intraday-return",
                      JSON.stringify({
                        id: row.id,
                        scroll: savedScroll.current,
                      }),
                    );
                  } catch {
                    /* Optional restoration only. */
                  }
                  setSelected(row.id);
                  address(filter, row.id);
                }}
              >
                查看依据
              </Button>
            </article>
          ))}
          {query.data?.rows.length === 0 && (
            <p className="text-sm text-nc-text-3">
              {query.data.totalAll === 0
                ? "尚无观测记录。请先确认配置和行情条件，再查看批次执行结果。"
                : "当前范围没有观测记录。可切换全部历史；缺少行情或尚未执行的原因请查看批次。"}
            </p>
          )}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            disabled={cursors.length === 1 || query.isFetching}
            onClick={() => page(cursors.slice(0, -1))}
          >
            上一页
          </Button>
          <span className="text-xs">第 {cursors.length} 页 · 每页20条</span>
          <Button
            size="sm"
            variant="outline"
            disabled={!query.data?.nextCursor || query.isFetching}
            onClick={() => page([...cursors, query.data!.nextCursor!])}
          >
            下一页
          </Button>
        </div>
        {storage.data && (
          <p className="text-xs text-nc-text-3">
            研究快照 {(storage.data.bytes / 1048576).toFixed(1)} /{" "}
            {storage.data.limitBytes / 1048576} MiB · 保留至手动清理
          </p>
        )}
        {storage.error && (
          <p role="alert" className="text-xs">
            容量信息读取失败：{storage.error.message}
          </p>
        )}
      </Panel>
      {selected && (
        <IntradayEvidence
          key={selected}
          id={selected}
          running={running}
          close={close}
          removed={() => {
            close();
            void utils.intradayHistory.invalidate();
            void utils.intradayRuns.invalidate();
            void utils.intradayStorage.invalidate();
          }}
        />
      )}
      <IntradayBatches
        running={running}
        choose={(id) => apply({ sessionId: id })}
      />
    </>
  );
}

function IntradayEvidence({
  id,
  running,
  close,
  removed,
}: {
  id: string;
  running: boolean;
  close: () => void;
  removed: () => void;
}) {
  const visible = useTaskVisible();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const query = api.intradayExport.useQuery(id, {
    enabled: visible,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  useEffect(() => {
    if (visible) void query.refetch();
  }, [running, visible]);
  const download = useArchiveDownload();
  const [confirm, setConfirm] = useState(false);
  const remove = api.intradayRemove.useMutation({ onSuccess: removed });
  const value = query.data;
  const observation = value?.observation;
  const settled = value?.attempts.find((a) => a.close.signalKeys !== null);
  const current = settled ?? value?.attempts.at(-1);
  return (
    <Panel
      span={12}
      icon={ListChecks}
      title="观测依据"
      actions={
        <Button variant="outline" size="sm" onClick={close}>
          返回结果
        </Button>
      }
    >
      <h3 ref={heading} tabIndex={-1} className="text-base">
        {observation?.snapshot.symbol.toUpperCase() ?? "观测详情"}
      </h3>
      {query.isLoading && <p role="status">正在读取依据…</p>}
      {query.error && (
        <p role="alert">
          {query.error.message}
          <Button size="sm" onClick={() => void query.refetch()}>
            重试读取
          </Button>
        </p>
      )}
      {observation && value && (
        <div className="min-w-0 space-y-3 text-sm">
          <p>
            行情来源：{observation.snapshot.source} · RPS日期：
            {observation.rpsDate} · 引擎：{observation.engineVersion}
          </p>
          <p>
            截止：{observation.barCutoff} · 捕获：
            {archiveStamp(observation.capturedAt)} · 完成：
            {archiveStamp(observation.observedAt)}
          </p>
          <p>
            当前核对：
            {!current
              ? "未核对，15:05后检查"
              : current.close.signalKeys === null
                ? `数据不足 · ${current.close.reason} · 等待后台重试`
                : observation.signals.length
                  ? "已核对，逐项结果如下"
                  : "已核对，无预选信号"}
          </p>
          {observation.signals.map((signal) => {
            const result = current?.signals.find((s) => s.key === signal.key);
            return (
              <p key={signal.key} className="break-words">
                {signal.strategy === "czsc" ? "缠论" : "双突破"} ·{" "}
                {signal.strategyVersion} ·{" "}
                {result
                  ? {
                      confirmed: "收盘成立",
                      withdrawn: "收盘撤销",
                      unavailable: "数据不足",
                    }[result.status]
                  : "未核对"}
              </p>
            );
          })}
          <ArchiveEvidence title={`历次核对（${value.attempts.length}）`}>
            {() => (
              <div>
                {value.attempts.map((attempt, index) => (
                  <p key={index}>
                    {archiveStamp(attempt.close.observedAt)} ·{" "}
                    {attempt.close.reason ?? "有效收盘证据"}
                  </p>
                ))}
              </div>
            )}
          </ArchiveEvidence>
          <ArchiveEvidence title="原始行情与完整依据">
            {() => <ArchiveText text={JSON.stringify(value, null, 2)} />}
          </ArchiveEvidence>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() =>
                download.save(
                  () => JSON.stringify(value, null, 2),
                  `${observation.snapshot.symbol}-${observation.barCutoff.slice(0, 10)}-preview.json`,
                  "application/json",
                )
              }
            >
              导出完整依据
            </Button>
            <Button
              variant="outline"
              disabled={running}
              onClick={() => setConfirm(true)}
            >
              清理记录
            </Button>
          </div>
          {download.error && <p role="alert">{download.error}</p>}
          {confirm && (
            <div role="group" aria-label="确认清理">
              <p>将永久删除此观测及收盘核对。建议先导出；批次记录保留。</p>
              <Button
                variant="danger"
                disabled={running || remove.isPending}
                onClick={() => remove.mutate(id)}
              >
                确认清理
              </Button>
              <Button variant="outline" onClick={() => setConfirm(false)}>
                取消清理
              </Button>
            </div>
          )}
          {remove.error && <p role="alert">{remove.error.message}</p>}
        </div>
      )}
    </Panel>
  );
}

function IntradayBatches({
  running,
  choose,
}: {
  running: boolean;
  choose: (id: string) => void;
}) {
  const visible = useTaskVisible();
  const [cursors, setCursors] = useState<(Cursor | undefined)[]>([undefined]);
  const [status, setStatus] = useState<
    "running" | "complete" | "partial" | "failed" | "missed" | undefined
  >();
  const [selected, setSelected] = useState<string | null>(null);
  const [range, setRange] = useState<{
    from?: string;
    to?: string;
    slot?: "noon" | "late";
  }>({});
  const [rangeDraft, setRangeDraft] = useState(range);
  const query = api.intradayRuns.useQuery(
    { ...range, status, cursor: cursors.at(-1) },
    { enabled: visible, refetchInterval: running ? 5000 : false },
  );
  useEffect(() => {
    if (visible) void query.refetch();
  }, [running, visible]);
  const detail = api.intradayRunDetail.useQuery(selected ?? "", {
    enabled: visible && !!selected,
    gcTime: 0,
    retry: false,
  });
  useEffect(() => {
    if (visible && selected) void detail.refetch();
  }, [running, visible, selected]);
  return (
    <Panel
      span={12}
      icon={Queue}
      title="批次记录"
      note="批次固定保存执行时参数。修改当前设置不会重写历史批次。"
      actions={
        <Button
          size="sm"
          variant="outline"
          onClick={() => void query.refetch()}
        >
          刷新批次
        </Button>
      }
    >
      <form
        className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          setRange(rangeDraft);
          setCursors([undefined]);
          setSelected(null);
        }}
      >
        <label className="text-xs">
          批次开始日期
          <Input
            type="date"
            value={rangeDraft.from ?? ""}
            onChange={(event) =>
              setRangeDraft({
                ...rangeDraft,
                from: event.target.value || undefined,
              })
            }
          />
        </label>
        <label className="text-xs">
          批次结束日期
          <Input
            type="date"
            value={rangeDraft.to ?? ""}
            onChange={(event) =>
              setRangeDraft({
                ...rangeDraft,
                to: event.target.value || undefined,
              })
            }
          />
        </label>
        <Choice
          label="批次时段"
          value={rangeDraft.slot ?? "all"}
          options={{ all: "全部时段", noon: "午盘", late: "尾盘" }}
          onChange={(value) =>
            setRangeDraft({
              ...rangeDraft,
              slot: value === "all" ? undefined : (value as "noon" | "late"),
            })
          }
        />
        <Button type="submit">查询批次</Button>
      </form>
      <Choice
        label="批次状态"
        value={status ?? "all"}
        options={{ all: "全部状态", ...batchLabels }}
        onChange={(value) => {
          setStatus(value === "all" ? undefined : (value as typeof status));
          setCursors([undefined]);
          setSelected(null);
        }}
      />
      {query.error && <p role="alert">{query.error.message}</p>}
      <div className="mt-3 space-y-2">
        {query.data?.rows.map((row) => (
          <div
            key={row.id}
            className="flex flex-wrap items-center gap-3 rounded border border-nc-border p-3 text-sm"
          >
            <span>
              {row.date} · {row.slot === "noon" ? "午盘" : "尾盘"} ·{" "}
              {batchLabels[row.status]}
            </span>
            <span>
              已评估 {row.evaluated}/{row.poolSize}
            </span>
            <Button size="sm" variant="outline" onClick={() => choose(row.id)}>
              查看该批观测
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSelected(selected === row.id ? null : row.id)}
            >
              配置与原因
            </Button>
            {row.error && (
              <p className="basis-full text-nc-warn">{row.error}</p>
            )}
          </div>
        ))}
      </div>
      {query.isLoading && <p role="status">正在读取批次…</p>}
      {query.data?.total === 0 && (
        <p className="text-sm">
          暂无匹配批次。尚未启用或未到窗口时不会产生预选。
        </p>
      )}
      <div className="mt-3 flex items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          disabled={cursors.length === 1 || query.isFetching}
          onClick={() => setCursors(cursors.slice(0, -1))}
        >
          上一批次页
        </Button>
        <span className="text-xs">
          {query.data?.total ?? 0}批 · 第{cursors.length}页
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={!query.data?.nextCursor || query.isFetching}
          onClick={() => setCursors([...cursors, query.data!.nextCursor!])}
        >
          下一批次页
        </Button>
      </div>
      {selected && (
        <div className="mt-3 min-w-0 rounded border border-nc-border p-3 text-sm">
          {detail.isLoading && <p>正在读取批次依据…</p>}
          {detail.error && (
            <p role="alert">
              {detail.error.message}
              <Button size="sm" onClick={() => void detail.refetch()}>
                重试批次
              </Button>
            </p>
          )}
          {detail.data && (
            <>
              <p>
                开始于 {archiveStamp(detail.data.startedAt)} · RPS来源日期{" "}
                {detail.data.pool?.rpsDay.date ??
                  detail.data.previousTradingDay}
              </p>
              <p>
                来源 {detail.data.config.source} ·{" "}
                {detail.data.config.pool?.name ?? "全沪深"} · RPS
                {detail.data.config.rpsPeriod} ≥ {detail.data.config.minimumRps}{" "}
                · 午盘{detail.data.config.noon} / 尾盘{detail.data.config.late}
              </p>
              <ArchiveEvidence title="逐证券原因">
                {() => <BatchReasons results={detail.data!.results} />}
              </ArchiveEvidence>
              <ArchiveEvidence title="参数、证券池与完整批次依据">
                {() => (
                  <ArchiveText text={JSON.stringify(detail.data, null, 2)} />
                )}
              </ArchiveEvidence>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}
