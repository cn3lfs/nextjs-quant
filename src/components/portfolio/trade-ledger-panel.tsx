"use client";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { api } from "~/trpc/react";
import { saveTrade } from "~/app/trade-ledger/actions";
import {
  tradeWorkspacePageSchema,
  type TradeWorkspaceInput,
} from "~/lib/portfolio/trade-workspace";
import {
  newTradeDraft,
  editTradeDraft,
  tradeDraftInput,
  submittedTradeDraft,
  savedTradeDraft,
  tradeDraftSessionSchema,
  type TradeDraft,
  type TradeAttempt,
} from "~/lib/portfolio/trade-workspace-draft";
import type { TradeInput } from "~/lib/portfolio/trade-ledger";
import { chinaClock } from "~/lib/strategy-facts/notification-policy";
import { useTaskVisible } from "../workbench/use-task-visible";
import { PageGrid, Panel } from "../panels";
import { Button } from "../ui/button";
import { TradePositions } from "./trade-positions";
import { TradeComparison } from "./trade-comparison";
import { TradeEntryEditor } from "./trade-entry-editor";
import { TradeWorkspaceDetail } from "./trade-workspace-detail";
import { TradeMockPanel } from "./trade-mock-panel";
import {
  TradeInputField,
  TradeSelect,
  TradeError,
  tradeNumber,
  downloadTradeFile,
} from "./trade-workspace-fields";

const tabs = ["positions", "history", "adjustments", "comparison"] as const;
type Tab = (typeof tabs)[number];
const labels: Record<Tab, string> = {
  positions: "持仓",
  history: "交易历史",
  adjustments: "除权依据",
  comparison: "信号比较",
};
const readOptions = {
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  retry: false,
};
const blankFilters = {
  query: "",
  symbol: "",
  from: "",
  to: "",
  side: "all",
  linked: "all",
};
const sessionKey = "trade-workspace-draft-v1";
export function TradeLedgerPanel() {
  const visible = useTaskVisible(),
    live = useRef(visible),
    utils = api.useUtils();
  live.current = visible;
  const [ready, setReady] = useState(false),
    [tab, setTab] = useState<Tab>("positions");
  const [filter, setFilter] = useState<TradeWorkspaceInput>({ query: "" }),
    [form, setForm] = useState(blankFilters);
  const [pages, setPages] = useState<(string | undefined)[]>([undefined]);
  const historyPageCount = useRef(pages.length);
  historyPageCount.current = pages.length;
  const [adjustmentPages, setAdjustmentPages] = useState<
    (string | undefined)[]
  >([undefined]);
  const [adjustmentSymbol, setAdjustmentSymbol] = useState("");
  const [positionPage, setPositionPage] = useState(1),
    [positionQuery, setPositionQuery] = useState(""),
    [positionForm, setPositionForm] = useState("");
  const [selected, setSelected] = useState({ history: "", adjustments: "" });
  const [editing, setEditing] = useState(false),
    [mockOpen, setMockOpen] = useState(false);
  const [draft, setDraft] = useState<TradeDraft | null>(null),
    [attempt, setAttempt] = useState<TradeAttempt | null>(null);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [filterError, setFilterError] = useState("");
  const [exporting, setExporting] = useState(false),
    [exportError, setExportError] = useState("");
  const saveLock = useRef(false),
    focus = useRef<HTMLElement | null>(null),
    scroll = useRef(0);
  const activeTab = useRef(tab);
  activeTab.current = tab;
  const env = api.tradeWorkspaceEnvironment.useQuery(undefined, {
    ...readOptions,
    enabled: visible,
  });
  useEffect(() => {
    const read = () => {
      const url = new URL(location.href),
        nextTab =
          tabs.find((value) => value === url.searchParams.get("view")) ??
          "positions";
      setTab(nextTab);
      try {
        const parsed = tradeWorkspacePageSchema.parse(
          JSON.parse(url.searchParams.get("tradeFilter") ?? "{}"),
        );
        const { cursor: _cursor, version: _version, ...filters } = parsed;
        setFilter(filters);
        setForm({
          query: filters.query,
          symbol: filters.symbol ?? "",
          from: filters.from ?? "",
          to: filters.to ?? "",
          side: filters.side ?? "all",
          linked:
            filters.linked === undefined
              ? "all"
              : filters.linked
                ? "yes"
                : "no",
        });
      } catch {
        setFilter({ query: "" });
        setForm(blankFilters);
        setFilterError("地址中的筛选无效，已恢复默认条件。");
      }
      const id = url.searchParams.get("record") ?? "";
      setSelected({
        history:
          nextTab === "history" && z.string().uuid().safeParse(id).success
            ? id
            : "",
        adjustments:
          nextTab === "adjustments" && /^[a-f0-9]{64}$/.test(id) ? id : "",
      });
      const symbol = url.searchParams.get("adjustmentSymbol") ?? "";
      setAdjustmentSymbol(/^(sh|sz|bj)\d{6}$/.test(symbol) ? symbol : "");
      setPages([undefined]);
      setAdjustmentPages([undefined]);
      try {
        const saved = z
          .object({
            url: z.string(),
            pages: z.array(z.string().max(2048).nullable()).min(1).max(1000),
            adjustmentPages: z
              .array(z.string().max(2048).nullable())
              .min(1)
              .max(1000),
            positionPage: z.number().int().min(1),
            positionQuery: z.string().max(100),
          })
          .parse(
            JSON.parse(
              sessionStorage.getItem("trade-workspace-view") ?? "null",
            ),
          );
        if (saved.url === url.pathname + url.search) {
          setPages(saved.pages.map((value) => value ?? undefined));
          setAdjustmentPages(
            saved.adjustmentPages.map((value) => value ?? undefined),
          );
          setPositionPage(saved.positionPage);
          setPositionQuery(saved.positionQuery);
          setPositionForm(saved.positionQuery);
        }
      } catch {
        /* URL still restores the primary view without session storage. */
      }
      setReady(true);
    };
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !env.data) return;
    restored.current = true;
    try {
      const raw = sessionStorage.getItem(sessionKey);
      if (raw) {
        const saved = tradeDraftSessionSchema.parse(JSON.parse(raw));
        setDraft(saved.draft);
        setAttempt(saved.attempt);
        if (saved.draft.dirty) setNotice("已恢复本次会话的未保存草稿。");
        return;
      }
    } catch {
      setNotice("上次草稿无法校验，未自动使用；请重新核对输入。");
    }
    setDraft(newTradeDraft(env.data.today));
  }, [env.data]);
  useEffect(() => {
    if (!draft) return;
    try {
      sessionStorage.setItem(
        sessionKey,
        JSON.stringify({ schemaVersion: 1, draft, attempt }),
      );
    } catch {
      setNotice("会话存储不可用，请在离开前保存或保留输入。");
    }
  }, [draft, attempt]);
  const selectedId =
    tab === "history"
      ? selected.history
      : tab === "adjustments"
        ? selected.adjustments
        : "";
  const hasDetail = editing || !!selectedId;
  useEffect(() => {
    if ((!editing && !selectedId) || !live.current) return;
    const frame = requestAnimationFrame(() => {
      const element = document.querySelector<HTMLElement>(
        editing ? '[aria-label="本地交易草稿"]' : '[aria-label="账本记录详情"]',
      );
      element?.focus({ preventScroll: true });
      element?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [editing, selectedId]);
  useEffect(() => {
    if (!ready) return;
    const url = new URL(location.href);
    url.searchParams.set("view", tab);
    url.searchParams.set("tradeFilter", JSON.stringify(filter));
    if (selectedId) url.searchParams.set("record", selectedId);
    else url.searchParams.delete("record");
    if (adjustmentSymbol)
      url.searchParams.set("adjustmentSymbol", adjustmentSymbol);
    else url.searchParams.delete("adjustmentSymbol");
    history.replaceState(history.state, "", url);
    try {
      sessionStorage.setItem(
        "trade-workspace-view",
        JSON.stringify({
          url: url.pathname + url.search,
          pages,
          adjustmentPages,
          positionPage,
          positionQuery,
        }),
      );
    } catch {
      /* no evidence or draft is stored in the URL */
    }
  }, [
    ready,
    tab,
    filter,
    selectedId,
    adjustmentSymbol,
    pages,
    adjustmentPages,
    positionPage,
    positionQuery,
  ]);
  useEffect(() => {
    if (!draft?.dirty && attempt?.state !== "pending") return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const leave = (event: MouseEvent) => {
      const anchor = (event.target as Element).closest?.("a[href]");
      if (!anchor || event.defaultPrevented || event.ctrlKey || event.metaKey)
        return;
      const target = new URL((anchor as HTMLAnchorElement).href, location.href);
      if (
        target.pathname !== location.pathname &&
        !window.confirm(
          "有未保存的交易草稿。离开后可在本次会话恢复，仍要离开吗？",
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", leave, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", leave, true);
    };
  }, [draft?.dirty, attempt?.state]);
  const positions = api.tradeWorkspacePositions.useQuery(
    { page: positionPage, query: positionQuery },
    { ...readOptions, enabled: visible && ready },
  );
  const historyQuery = api.tradeWorkspacePage.useQuery(
    { ...filter, cursor: pages.at(-1) },
    { ...readOptions, enabled: visible && ready && tab === "history" },
  );
  const adjustments = api.tradeWorkspaceAdjustments.useQuery(
    { symbol: adjustmentSymbol || undefined, cursor: adjustmentPages.at(-1) },
    { ...readOptions, enabled: visible && ready && tab === "adjustments" },
  );
  const comparison = api.tradeWorkspaceComparison.useQuery(undefined, {
    ...readOptions,
    enabled: visible && ready && tab === "comparison",
    gcTime: 0,
  });
  async function changed(tradeWritten = false) {
    await Promise.all([
      utils.tradeWorkspacePositions.invalidate(undefined, {
        refetchType: "none",
      }),
      utils.tradeWorkspaceAdjustments.invalidate(undefined, {
        refetchType: "none",
      }),
      ...(tradeWritten
        ? [
            utils.tradeWorkspacePage.invalidate(undefined, {
              refetchType: "none",
            }),
            utils.tradeWorkspaceComparison.invalidate(undefined, {
              refetchType: "none",
            }),
          ]
        : []),
    ]);
    // A local append invalidates every history cursor, including an inactive tab.
    if (tradeWritten) setPages([undefined]);
    if (!live.current) return;
    void positions.refetch();
    if (activeTab.current === "history" && tradeWritten) {
      if (historyPageCount.current > 1 && tradeWritten) setPages([undefined]);
      else void historyQuery.refetch();
    }
    if (activeTab.current === "adjustments") void adjustments.refetch();
    if (activeTab.current === "comparison" && tradeWritten)
      void comparison.refetch();
  }
  const remember = () => {
    focus.current = document.activeElement as HTMLElement;
    scroll.current = window.scrollY;
  };
  const back = () => {
    setEditing(false);
    if (tab === "history" || tab === "adjustments")
      setSelected((p) => ({ ...p, [tab]: "" }));
    requestAnimationFrame(() => {
      window.scrollTo({ top: scroll.current });
      if (focus.current?.isConnected)
        focus.current.focus({ preventScroll: true });
      else
        document
          .querySelector<HTMLElement>(`[data-trade-tab="${tab}"]`)
          ?.focus({ preventScroll: true });
    });
  };
  const openRecord = (kind: "history" | "adjustments", id: string) => {
    remember();
    setEditing(false);
    setTab(kind);
    setSelected((p) => ({ ...p, [kind]: id }));
  };
  const related = (symbol: string) => {
    remember();
    setEditing(false);
    setTab("adjustments");
    setAdjustmentSymbol(symbol);
    setAdjustmentPages([undefined]);
    setSelected((p) => ({ ...p, adjustments: "" }));
  };
  const newDraft = () => {
    if (draft?.dirty && !window.confirm("放弃当前未保存输入，新增下一笔交易？"))
      return;
    setDraft(newTradeDraft(chinaClock(Date.now()).date));
    setError("");
    setEditing(true);
  };
  async function submit(input: TradeInput) {
    if (saveLock.current) return;
    saveLock.current = true;
    setBusy(true);
    setError("");
    setAttempt({ input, state: "pending" });
    try {
      const id = await saveTrade(input);
      setDraft((current) => (current ? savedTradeDraft(current, id) : current));
      setAttempt({ input, state: "saved" });
      await changed(true);
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "保存结果未确认，请用同一编号重试";
      setAttempt({ input, state: "unknown", error: message });
      if (currentDraft.current?.id === input.id) setError(message);
    } finally {
      saveLock.current = false;
      setBusy(false);
    }
  }
  const save = () => {
    if (!draft || saveLock.current) return;
    try {
      const input = tradeDraftInput(draft);
      setDraft(submittedTradeDraft(draft));
      void submit(input);
    } catch (e) {
      setError(e instanceof Error ? e.message : "输入无效，请核对");
    }
  };
  async function exportHistory(format: "json" | "csv") {
    if (exporting || !historyQuery.data) return;
    setExporting(true);
    setExportError("");
    const input = {
      filters: { ...filter, version: historyQuery.data.version },
      format,
    };
    try {
      const result = await utils.tradeWorkspaceExport.fetch(input, {
        staleTime: 0,
        gcTime: 0,
      });
      downloadTradeFile(result.filename, result.mime, result.content);
      setNotice(`已导出全部匹配交易 ${result.count} 笔。`);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "导出失败，可重试");
    } finally {
      utils.tradeWorkspaceExport.reset(input);
      setExporting(false);
    }
  }
  const applyFilters = () => {
    const result = tradeWorkspacePageSchema.safeParse({
      query: form.query,
      symbol: form.symbol || undefined,
      from: form.from || undefined,
      to: form.to || undefined,
      side: form.side === "all" ? undefined : form.side,
      linked: form.linked === "all" ? undefined : form.linked === "yes",
    });
    if (!result.success) {
      setFilterError(result.error.issues[0]?.message ?? "筛选无效");
      return;
    }
    setFilterError("");
    setFilter(result.data);
    setPages([undefined]);
    setSelected((previous) => ({ ...previous, history: "" }));
  };
  const summary = positions.data?.summary;
  return (
    <PageGrid>
      <Panel
        title="本地交易账本"
        span={12}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (tab === "positions") void positions.refetch();
                if (tab === "history") {
                  if (pages.length > 1) setPages([undefined]);
                  else void historyQuery.refetch();
                }
                if (tab === "adjustments") {
                  if (adjustmentPages.length > 1)
                    setAdjustmentPages([undefined]);
                  else void adjustments.refetch();
                }
                if (tab === "comparison") void comparison.refetch();
              }}
            >
              刷新当前视图
            </Button>
            <Button
              size="sm"
              disabled={!draft}
              onClick={() => {
                remember();
                if (draft?.saved)
                  setDraft(newTradeDraft(chinaClock(Date.now()).date));
                setEditing(true);
              }}
            >
              新增本地交易 / 恢复草稿
            </Button>
          </div>
        }
      >
        <p className="text-xs text-nc-text-3">
          本地账本为事实来源；只追加、离线核算。实验参数，非历史实际费用。模拟盘操作独立且默认关闭。
        </p>
        {positions.isFetching && (
          <p role="status" className="my-2 text-xs text-nc-text-3">
            正在核算完整持仓；交易历史可独立查询，已有摘要尚未更新。
          </p>
        )}
        {tab !== "positions" && (
          <TradeError
            error={positions.error?.message}
            onRetry={() => void positions.refetch()}
          />
        )}
        {summary && (
          <dl
            aria-label="全部持仓摘要"
            className="my-4 grid grid-cols-4 gap-4 max-sm:grid-cols-2"
          >
            <div>
              <dt>全部持仓</dt>
              <dd>{summary.holdings}只</dd>
            </div>
            <div>
              <dt>完整账本交易</dt>
              <dd>{summary.trades}笔</dd>
            </div>
            <div>
              <dt>总市值</dt>
              <dd>{tradeNumber(summary.marketValue)}</dd>
              {summary.missingQuotes > 0 && (
                <small>
                  缺{summary.missingQuotes}只行情；已知部分
                  {tradeNumber(summary.knownMarketValue)}
                </small>
              )}
            </div>
            <div>
              <dt>浮动盈亏</dt>
              <dd>{tradeNumber(summary.floating)}</dd>
              {summary.unknownFloating > 0 && (
                <small>{summary.unknownFloating}只缺少核对依据</small>
              )}
            </div>
          </dl>
        )}
        {positions.data && (
          <p className="text-xs text-nc-text-3">
            摘要为完整持仓口径，与历史筛选分开。读取时间：
            {positions.dataUpdatedAt
              ? new Date(positions.dataUpdatedAt).toLocaleTimeString("zh-CN", {
                  timeZone: "Asia/Shanghai",
                })
              : "—"}
          </p>
        )}
        {notice && (
          <p role="status" className="my-2 text-sm">
            {notice}
          </p>
        )}
        <TradeError
          error={env.error?.message}
          onRetry={() => void env.refetch()}
        />
        <div
          role="tablist"
          aria-label="账本视图"
          className="mt-4 flex flex-wrap gap-2"
        >
          {tabs.map((value, index) => (
            <Button
              key={value}
              role="tab"
              aria-selected={tab === value}
              tabIndex={tab === value ? 0 : -1}
              data-trade-tab={value}
              size="sm"
              variant={tab === value ? "default" : "outline"}
              onClick={() => {
                setTab(value);
                setEditing(false);
              }}
              onKeyDown={(event) => {
                let next = index;
                if (event.key === "ArrowRight")
                  next = (index + 1) % tabs.length;
                else if (event.key === "ArrowLeft")
                  next = (index + tabs.length - 1) % tabs.length;
                else if (event.key === "Home") next = 0;
                else if (event.key === "End") next = tabs.length - 1;
                else return;
                event.preventDefault();
                setTab(tabs[next]!);
                setEditing(false);
                document
                  .querySelector<HTMLElement>(
                    `[data-trade-tab="${tabs[next]}"]`,
                  )
                  ?.focus();
              }}
            >
              {labels[value]}
            </Button>
          ))}
        </div>
      </Panel>
      <Panel
        title={labels[tab]}
        span={hasDetail ? 5 : 12}
        className={hasDetail ? "min-w-0 max-[1240px]:hidden" : "min-w-0"}
      >
        <div hidden={tab !== "positions"}>
          <form
            className="mb-4 flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setPositionQuery(positionForm.trim());
              setPositionPage(1);
            }}
          >
            <TradeInputField
              label="持仓证券检索"
              value={positionForm}
              onChange={setPositionForm}
            />
            <Button type="submit" size="sm" variant="outline">
              查询持仓
            </Button>
          </form>
          <TradePositions
            data={positions.data}
            fetching={positions.isFetching}
            error={positions.error?.message}
            page={positionPage}
            onPage={setPositionPage}
            onRetry={() => void positions.refetch()}
            onRelated={related}
            onChanged={() => void changed()}
          />
        </div>
        {tab === "history" && (
          <div className="space-y-4">
            <form
              className="grid grid-cols-2 gap-3 max-sm:grid-cols-1"
              onSubmit={(event) => {
                event.preventDefault();
                applyFilters();
              }}
            >
              {(
                [
                  ["query", "备注、证券或交易ID"],
                  ["symbol", "精确证券代码"],
                  ["from", "交易起始日期"],
                  ["to", "交易截止日期"],
                ] as const
              ).map(([key, label]) => (
                <TradeInputField
                  key={key}
                  label={label}
                  type={key === "from" || key === "to" ? "date" : "text"}
                  value={form[key]}
                  onChange={(value) => setForm((p) => ({ ...p, [key]: value }))}
                />
              ))}
              <TradeSelect
                label="方向筛选"
                value={form.side}
                onChange={(value) => setForm((p) => ({ ...p, side: value }))}
                options={[
                  { value: "all", label: "全部方向" },
                  { value: "buy", label: "买入" },
                  { value: "sell", label: "卖出" },
                ]}
              />
              <TradeSelect
                label="关联状态筛选"
                value={form.linked}
                onChange={(value) => setForm((p) => ({ ...p, linked: value }))}
                options={[
                  { value: "all", label: "全部关联状态" },
                  { value: "yes", label: "已关联信号" },
                  { value: "no", label: "未关联信号" },
                ]}
              />
              <div className="col-span-full flex flex-wrap gap-2">
                <Button type="submit" size="sm">
                  查询交易
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setForm(blankFilters);
                    setFilter({ query: "" });
                    setPages([undefined]);
                    setFilterError("");
                  }}
                >
                  重置筛选
                </Button>
                {(["json", "csv"] as const).map((format) => (
                  <Button
                    key={format}
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={
                      exporting || !historyQuery.data || historyQuery.isFetching
                    }
                    onClick={() => void exportHistory(format)}
                  >
                    导出筛选全集 {format.toUpperCase()}
                  </Button>
                ))}
              </div>
            </form>
            <TradeError
              error={filterError || historyQuery.error?.message}
              onRetry={() => void historyQuery.refetch()}
            />
            <TradeError error={exportError} />
            {historyQuery.error?.message.includes("账本已更新") && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPages([undefined])}
              >
                从第一页重新检索
              </Button>
            )}
            <p className="text-xs text-nc-text-3">
              已应用：{filter.symbol ?? "全部证券"} · {filter.from ?? "最早"}至
              {filter.to ?? "最新"} ·{" "}
              {filter.side === "buy"
                ? "买入"
                : filter.side === "sell"
                  ? "卖出"
                  : "全部方向"}{" "}
              ·{" "}
              {filter.linked === undefined
                ? "全部关联"
                : filter.linked
                  ? "已关联"
                  : "未关联"}{" "}
              · 关键词 {filter.query || "无"}
            </p>
            {historyQuery.isFetching && <p role="status">正在读取交易历史…</p>}
            {historyQuery.data && (
              <p>
                筛选全部匹配 {historyQuery.data.summary.count}笔；买入{" "}
                {historyQuery.data.summary.buys} / 卖出{" "}
                {historyQuery.data.summary.sells}；实验费用合计{" "}
                {tradeNumber(historyQuery.data.summary.fees)}
              </p>
            )}
            <div aria-label="交易历史列表" className="space-y-2">
              {historyQuery.data?.items.map((row) => (
                <Button
                  key={row.id}
                  data-trade-row={row.id}
                  className="h-auto w-full justify-start whitespace-normal p-3 text-left"
                  variant={selected.history === row.id ? "default" : "outline"}
                  onClick={() => openRecord("history", row.id)}
                >
                  <span className="min-w-0 break-words">
                    <strong>
                      {row.date} · {row.symbol} ·{" "}
                      {row.side === "buy" ? "买入" : "卖出"}
                    </strong>
                    <br />
                    {row.quantity}股 × {tradeNumber(row.price)} · 费用
                    {tradeNumber(row.fees)}
                    <br />
                    {row.signalId ? "已关联信号" : "手动交易"} · {row.note}
                  </span>
                </Button>
              ))}
              {!historyQuery.isFetching &&
                !historyQuery.error &&
                historyQuery.data?.items.length === 0 && (
                  <p>没有匹配的交易，可重置筛选或新增本地交易。</p>
                )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={pages.length === 1 || historyQuery.isFetching}
                onClick={() => setPages((p) => p.slice(0, -1))}
              >
                上一页交易
              </Button>
              <span>第{pages.length}页</span>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  !historyQuery.data?.nextCursor || historyQuery.isFetching
                }
                onClick={() =>
                  setPages((p) => [...p, historyQuery.data!.nextCursor!])
                }
              >
                下一页交易
              </Button>
            </div>
          </div>
        )}
        {tab === "adjustments" && (
          <div className="space-y-3">
            <p>
              完整除权依据归档 · {adjustmentSymbol || "全部证券"} · 共
              {adjustments.data?.count ?? "—"}条
            </p>
            {adjustmentSymbol && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setAdjustmentSymbol("");
                  setAdjustmentPages([undefined]);
                }}
              >
                查看全部证券依据
              </Button>
            )}
            <TradeError
              error={adjustments.error?.message}
              onRetry={() => void adjustments.refetch()}
            />
            {adjustments.isFetching && <p role="status">正在读取除权依据…</p>}
            <div aria-label="除权依据列表" className="space-y-2">
              {adjustments.data?.items.map((row) => (
                <Button
                  key={row.id}
                  data-trade-row={row.id}
                  variant="outline"
                  className="h-auto w-full justify-start whitespace-normal p-3 text-left"
                  onClick={() => openRecord("adjustments", row.id)}
                >
                  {row.symbol} · {row.date} · {row.name} · 成本
                  {tradeNumber(row.beforeCost)} → {tradeNumber(row.afterCost)}
                </Button>
              ))}
              {!adjustments.isFetching &&
                !adjustments.error &&
                adjustments.data?.items.length === 0 && (
                  <p>暂无匹配除权依据；缺少归档不代表已核对无除权。</p>
                )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={
                  adjustmentPages.length === 1 || adjustments.isFetching
                }
                onClick={() => setAdjustmentPages((p) => p.slice(0, -1))}
              >
                上一页依据
              </Button>
              <span>第{adjustmentPages.length}页</span>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  !adjustments.data?.nextCursor || adjustments.isFetching
                }
                onClick={() =>
                  setAdjustmentPages((p) => [
                    ...p,
                    adjustments.data!.nextCursor!,
                  ])
                }
              >
                下一页依据
              </Button>
            </div>
          </div>
        )}
        {tab === "comparison" && (
          <TradeComparison
            data={comparison.data}
            fetching={comparison.isFetching}
            error={comparison.error?.message}
            onRetry={() => void comparison.refetch()}
          />
        )}
      </Panel>
      {hasDetail && (
        <Panel
          title={editing ? "本地交易草稿" : "原始记录与依据"}
          span={7}
          className="min-w-0"
        >
          <div
            onKeyDown={(event) => {
              if (
                event.key === "Escape" &&
                !/^(INPUT|TEXTAREA|SELECT)$/.test(
                  (event.target as HTMLElement).tagName,
                )
              ) {
                event.preventDefault();
                back();
              }
            }}
          >
            {editing && draft ? (
              <TradeEntryEditor
                draft={draft}
                attempt={attempt}
                busy={busy}
                visible={visible}
                error={error}
                onChange={(patch) => {
                  setDraft((current) =>
                    current ? editTradeDraft(current, patch) : current,
                  );
                  setError("");
                }}
                onSave={save}
                onRetry={() => {
                  if (attempt) void submit(attempt.input);
                }}
                onNew={newDraft}
                onLocate={(id) => openRecord("history", id)}
                onClose={back}
              />
            ) : selectedId ? (
              <TradeWorkspaceDetail
                key={`${tab}:${selectedId}`}
                id={selectedId}
                kind={tab === "adjustments" ? "adjustment" : "trade"}
                visible={visible}
                onBack={back}
                onAdjustments={related}
                onChanged={() => void changed()}
              />
            ) : null}
          </div>
        </Panel>
      )}
      <Panel title="模拟盘（独立操作）" span={12}>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setMockOpen(!mockOpen)}
        >
          {mockOpen ? "收起" : "展开"}同花顺模拟盘
        </Button>
        <p className="mt-2 text-xs text-nc-text-3">
          展开不开户、不下单；查询与确认均需单独操作，本地交易不自动同步。
        </p>
        {mockOpen && (
          <TradeMockPanel
            enabled={env.data?.mockEnabled ?? false}
            input={() => {
              if (!draft) throw new Error("请先填写本地交易草稿");
              return tradeDraftInput(draft);
            }}
            onChanged={() => {
              void utils.tradeWorkspaceEnvironment.invalidate(undefined, {
                refetchType: "none",
              });
              if (live.current) void env.refetch();
            }}
          />
        )}
      </Panel>
    </PageGrid>
  );
}
