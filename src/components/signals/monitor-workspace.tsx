"use client";
import { useEffect, useRef, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { api } from "~/trpc/react";
import {
  monitorPageSchema,
  signalPageSchema,
  deliveryPageSchema,
} from "~/lib/strategy-facts/monitor-workspace";
import { monitorSaveSchema } from "~/lib/strategy-facts/monitor-workspace-actions";
import {
  editMonitorDraft,
  newMonitorDraft,
  monitorDraftInput,
  savedMonitorDraft,
  monitorSessionDrafts,
  type MonitorDraft,
} from "~/lib/strategy-facts/monitor-workspace-draft";
import { useTaskVisible } from "../workbench/use-task-visible";
import { PageGrid, Panel } from "../panels";
import { Button } from "../ui/button";
import {
  MonitorFiltersForm,
  type MonitorFilters,
  type MonitorTab,
} from "./monitor-filters";
import { MonitorDetail, type MonitorDetailValue } from "./monitor-detail";
import { SignalStats } from "./signal-stats";
import { MonitorEditor } from "./monitor-editor";
import {
  MonitorPages,
  MonitorError,
  MonitorEvidence,
  deliveryLabels,
  monitorTime,
} from "./monitor-workspace-fields";
const blankFilters = (): Record<MonitorTab, MonitorFilters> => ({
  monitors: { query: "" },
  signals: { query: "" },
  deliveries: { query: "" },
});
const schemas = {
  monitors: monitorPageSchema,
  signals: signalPageSchema,
  deliveries: deliveryPageSchema,
};
const kinds = {
  monitors: "monitor",
  signals: "signal",
  deliveries: "delivery",
} as const;
const labels = { monitors: "订阅", signals: "信号", deliveries: "投递" };
export function MonitorWorkspace({
  watchlist,
}: {
  watchlist: readonly string[];
}) {
  const visible = useTaskVisible(),
    live = useRef(visible),
    utils = api.useUtils();
  live.current = visible;
  const [ready, setReady] = useState(false),
    [tab, setTab] = useState<MonitorTab>("monitors");
  const [filters, setFilters] = useState(blankFilters),
    [draftFilters, setDraftFilters] = useState(blankFilters);
  const [pages, setPages] = useState<
    Record<MonitorTab, (string | undefined)[]>
  >({ monitors: [undefined], signals: [undefined], deliveries: [undefined] });
  const [selected, setSelected] = useState<Record<MonitorTab, string>>({
    monitors: "",
    signals: "",
    deliveries: "",
  });
  const [drafts, setDrafts] = useState<Record<string, MonitorDraft>>({}),
    [editing, setEditing] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({}),
    [notice, setNotice] = useState("");
  const [reloadValue, setReloadValue] = useState<MonitorDetailValue | null>(
    null,
  );
  const focus = useRef<HTMLButtonElement | null>(null),
    scroll = useRef(0);
  useEffect(() => {
    const read = () => {
      try {
        const url = new URL(location.href),
          target = url.searchParams.get("monitorTab");
        const current: MonitorTab =
          target === "signals" || target === "deliveries" ? target : "monitors";
        const raw = JSON.parse(url.searchParams.get("monitorFilters") ?? "{}"),
          value = schemas[current].parse(raw);
        const id = url.searchParams.get("monitorRecord") ?? "";
        if (id.length > 200) throw new Error("记录ID无效");
        setTab(current);
        setFilters((previous) => ({ ...previous, [current]: value }));
        setDraftFilters((previous) => ({ ...previous, [current]: value }));
        setSelected((previous) => ({ ...previous, [current]: id }));
        const stored = sessionStorage.getItem(
            `monitor-pages:${current}:${JSON.stringify(value)}`,
          ),
          positions: unknown = stored ? JSON.parse(stored) : null;
        if (
          Array.isArray(positions) &&
          positions.length > 0 &&
          positions.length < 10000 &&
          positions.every(
            (p) => p == null || (typeof p === "string" && p.length <= 2048),
          )
        )
          setPages((previous) => ({
            ...previous,
            [current]: positions.map((p) => p ?? undefined),
          }));
      } catch (cause) {
        setErrors((previous) => ({
          ...previous,
          query: cause instanceof Error ? cause.message : "查询参数无效",
        }));
      }
      setReady(true);
    };
    read();
    window.addEventListener("popstate", read);
    return () => {
      window.removeEventListener("popstate", read);
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (!ready || location.pathname !== "/signals") return;
    const url = new URL(location.href);
    url.searchParams.set("monitorTab", tab);
    url.searchParams.set("monitorFilters", JSON.stringify(filters[tab]));
    if (selected[tab]) url.searchParams.set("monitorRecord", selected[tab]);
    else url.searchParams.delete("monitorRecord");
    history.replaceState(history.state, "", url);
    try {
      sessionStorage.setItem(
        `monitor-pages:${tab}:${JSON.stringify(filters[tab])}`,
        JSON.stringify(pages[tab]),
      );
    } catch {
      /* Page state remains in memory. */
    }
  }, [ready, tab, filters, pages, selected]);
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem("monitor-workspace-drafts-v1");
      if (saved) setDrafts(monitorSessionDrafts.parse(JSON.parse(saved)));
    } catch {
      setErrors((previous) => ({
        ...previous,
        storage: "会话草稿无法读取，请核对后重新填写。",
      }));
    }
  }, []);
  useEffect(() => {
    if (!ready) return;
    try {
      sessionStorage.setItem(
        "monitor-workspace-drafts-v1",
        JSON.stringify(drafts),
      );
    } catch {
      setErrors((previous) => ({
        ...previous,
        storage: "会话存储不可用，草稿仅保留在当前页面。",
      }));
    }
  }, [ready, drafts]);
  useEffect(() => {
    if (!Object.values(drafts).some((draft) => draft.dirty)) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [drafts]);
  const summary = api.monitorWorkspaceSummary.useQuery(undefined, {
    enabled: visible && ready,
    refetchInterval: visible ? 15000 : false,
  });
  const channels = api.channels.useQuery(undefined, {
    enabled: visible && ready,
  });
  const monitorPage = api.monitorWorkspacePage.useQuery(
    { ...filters.monitors, cursor: pages.monitors.at(-1) },
    {
      enabled: visible && ready && tab === "monitors",
      placeholderData: keepPreviousData,
      refetchInterval: visible && tab === "monitors" ? 10000 : false,
    },
  );
  const signalPage = api.signalWorkspacePage.useQuery(
    { ...filters.signals, cursor: pages.signals.at(-1) },
    {
      enabled: visible && ready && tab === "signals",
      placeholderData: keepPreviousData,
      refetchInterval:
        visible && tab === "signals" && pages.signals.length === 1
          ? 10000
          : false,
    },
  );
  const deliveryPage = api.deliveryWorkspacePage.useQuery(
    { ...filters.deliveries, cursor: pages.deliveries.at(-1) },
    {
      enabled: visible && ready && tab === "deliveries",
      placeholderData: keepPreviousData,
      refetchInterval:
        visible &&
        tab === "deliveries" &&
        (summary.data?.activeDeliveries ?? 0) > 0
          ? 4000
          : false,
    },
  );
  const lastSignalCounts = useRef("");
  useEffect(() => {
    if (tab !== "signals" || !selected.signals || !visible) return;
    const row = signalPage.data?.items.find(
      (value) => value.id === selected.signals,
    );
    if (!row) return;
    const key = selected.signals + JSON.stringify(row.deliveries);
    if (
      lastSignalCounts.current &&
      lastSignalCounts.current !== key &&
      lastSignalCounts.current.startsWith(selected.signals)
    )
      void utils.signalWorkspaceDetail.invalidate(selected.signals);
    lastSignalCounts.current = key;
  }, [signalPage.data, selected.signals, tab, visible, utils]);
  const active =
    tab === "monitors"
      ? monitorPage
      : tab === "signals"
        ? signalPage
        : deliveryPage;
  async function changed() {
    await Promise.all([
      utils.monitorWorkspaceSummary.invalidate(undefined, {
        refetchType: "none",
      }),
      utils.monitorWorkspacePage.invalidate(undefined, { refetchType: "none" }),
      utils.signalWorkspacePage.invalidate(undefined, { refetchType: "none" }),
      utils.deliveryWorkspacePage.invalidate(undefined, {
        refetchType: "none",
      }),
    ]);
    if (live.current) {
      void summary.refetch();
      void active.refetch();
    }
  }
  const save = api.monitorWorkspaceSave.useMutation({
    gcTime: 0,
    onMutate: () => ({
      key: editing ?? "new",
      revision: drafts[editing ?? "new"]?.revision ?? 0,
    }),
    onSuccess: (value, _variables, context) => {
      if (context)
        setDrafts((previous) => {
          const draft = previous[context.key];
          return draft
            ? {
                ...previous,
                [context.key]: savedMonitorDraft(
                  draft,
                  context.revision,
                  value,
                ),
              }
            : previous;
        });
      if (context)
        setErrors((previous) => ({ ...previous, [context.key]: "" }));
      setNotice(
        `已保存订阅“${value.name}”${value.enabled ? "，将重新建立基线" : "，当前暂停"}。`,
      );
      void changed();
    },
    onError: (cause, _variables, context) =>
      setErrors((previous) => ({
        ...previous,
        [context?.key ?? "new"]: cause.message,
      })),
  });
  function back() {
    setEditing(null);
    setSelected((previous) => ({ ...previous, [tab]: "" }));
    requestAnimationFrame(() => {
      focus.current?.focus();
      window.scrollTo({ top: scroll.current });
      if (!focus.current?.isConnected)
        document
          .querySelector<HTMLInputElement>('input[aria-label="历史关键词"]')
          ?.focus();
    });
  }
  function select(id: string, button: HTMLButtonElement) {
    focus.current = button;
    scroll.current = window.scrollY;
    setEditing(null);
    setSelected((previous) => ({ ...previous, [tab]: id }));
  }
  useEffect(() => {
    if (!visible) return;
    const close = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !document.querySelector('[role="dialog"]') &&
        (selected[tab] || editing)
      ) {
        event.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [visible, selected, tab, editing]);
  function apply(value: MonitorFilters) {
    const parsed = schemas[tab].safeParse(value);
    if (!parsed.success) {
      setErrors((previous) => ({
        ...previous,
        query: parsed.error.issues[0]?.message ?? "筛选无效",
      }));
      return;
    }
    if (
      JSON.stringify(parsed.data) === JSON.stringify(filters[tab]) &&
      pages[tab].length === 1
    )
      void active.refetch();
    setFilters((previous) => ({ ...previous, [tab]: parsed.data }));
    setPages((previous) => ({ ...previous, [tab]: [undefined] }));
    setSelected((previous) => ({ ...previous, [tab]: "" }));
    setErrors((previous) => ({ ...previous, query: "" }));
  }
  function edit(value: MonitorDetailValue) {
    setDrafts((previous) =>
      previous[value.id]?.dirty
        ? previous
        : { ...previous, [value.id]: editMonitorDraft(value) },
    );
    setReloadValue(null);
    setEditing(value.id);
  }
  async function reloadDraft() {
    if (!editing || editing === "new") return;
    try {
      const value = await utils.monitorWorkspaceDetail.fetch(editing);
      if (!value) throw new Error("订阅不存在");
      setReloadValue(value);
      setDrafts((previous) => ({
        ...previous,
        [editing]: {
          ...previous[editing]!,
          expectedVersion: value.configurationVersion,
        },
      }));
      setErrors((previous) => ({ ...previous, [editing]: "" }));
      setNotice("已读取最新配置，请对照下方服务端配置核对草稿后再保存。");
    } catch (cause) {
      setErrors((previous) => ({
        ...previous,
        [editing]: cause instanceof Error ? cause.message : "读取失败",
      }));
    }
  }
  const currentDraft = editing ? drafts[editing] : undefined;
  function saveDraft() {
    if (!currentDraft || !editing) return;
    const parsed = monitorSaveSchema.safeParse(
      monitorDraftInput(currentDraft, watchlist),
    );
    if (!parsed.success) {
      setErrors((previous) => ({
        ...previous,
        [editing]: parsed.error.issues[0]?.message ?? "配置无效",
      }));
      return;
    }
    save.mutate(parsed.data);
  }
  const hasDetail = !!selected[tab] || !!editing;
  return (
    <PageGrid>
      <Panel
        title="策略监控与通知"
        note="订阅配置、规则触发与消息投递分别记录。先核对原因，再决定操作。"
      >
        {errors.storage && <p role="alert">{errors.storage}</p>}
        <MonitorError
          error={summary.error}
          retry={() => void summary.refetch()}
        />
        <SignalStats summary={summary.data} />
        <p className="text-xs text-nc-text-3">
          今日按北京时间创建日期统计；暂停证券按订阅证券实例计数，包含已暂停订阅的核验状态。更新时间：
          {monitorTime(summary.data?.assessedAt)}
        </p>
        {notice && (
          <p role="status" className="py-2 text-sm">
            {notice}
          </p>
        )}
        <div role="tablist" aria-label="监控工作区" className="mt-3 flex gap-2">
          {(Object.keys(labels) as MonitorTab[]).map((key) => (
            <Button
              key={key}
              role="tab"
              aria-selected={tab === key}
              tabIndex={tab === key ? 0 : -1}
              onKeyDown={(event) => {
                const keys = Object.keys(labels) as MonitorTab[];
                const index = keys.indexOf(key);
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % keys.length
                    : event.key === "ArrowLeft"
                      ? (index + keys.length - 1) % keys.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? keys.length - 1
                          : -1;
                if (next < 0) return;
                event.preventDefault();
                setTab(keys[next]!);
                setEditing(null);
                const tabs =
                  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                    '[role="tab"]',
                  );
                tabs?.[next]?.focus();
              }}
              variant={tab === key ? "default" : "outline"}
              onClick={() => {
                setTab(key);
                setEditing(null);
              }}
            >
              {labels[key]}
            </Button>
          ))}
        </div>
      </Panel>
      {/* Match panels.css: below 1240px, selection replaces the single-column list. */}
      <Panel
        title={`${labels[tab]}历史`}
        span={5}
        className={hasDetail ? "max-[1240px]:hidden" : undefined}
      >
        <MonitorFiltersForm
          tab={tab}
          value={draftFilters[tab]}
          channels={channels.data ?? []}
          onChange={(patch) =>
            setDraftFilters((previous) => ({
              ...previous,
              [tab]: { ...previous[tab], ...patch },
            }))
          }
          onSubmit={() => apply(draftFilters[tab])}
          onReset={() => {
            setDraftFilters((previous) => ({
              ...previous,
              [tab]: { query: "" },
            }));
            apply({ query: "" });
          }}
        />
        <MonitorError
          error={active.error}
          retry={() => void active.refetch()}
        />
        {errors.query && (
          <p role="alert" className="text-sm text-nc-bad">
            {errors.query}
          </p>
        )}
        <p className="py-2 text-xs text-nc-text-3">
          已应用关键词：{filters[tab].query || "全部"} · 按创建时间倒序 ·
          每页20条
        </p>
        <p className="break-all text-xs text-nc-text-3">
          {Object.entries(filters[tab])
            .filter(
              ([key, value]) =>
                key !== "query" &&
                key !== "cursor" &&
                value !== undefined &&
                value !== "",
            )
            .map(([key, value]) => {
              const names: Record<string, string> = {
                from: "开始日期",
                to: "结束日期",
                enabled: "订阅状态",
                strategy: "策略",
                symbol: "证券",
                monitorId: "订阅ID",
                signalId: "信号ID",
                channelId: "渠道",
                status: "投递状态",
                kind: "消息类型",
              };
              const text =
                key === "enabled"
                  ? value
                    ? "已启用"
                    : "已暂停"
                  : key === "status"
                    ? deliveryLabels[value as keyof typeof deliveryLabels]
                    : key === "channelId"
                      ? (channels.data?.find((channel) => channel.id === value)
                          ?.name ?? String(value))
                      : String(value);
              return `${names[key] ?? key}：${text}`;
            })
            .join(" · ")}
        </p>
        {active.isFetching && (
          <p role="status" className="text-xs">
            正在更新列表{active.data ? "，暂时显示上次结果" : ""}…
          </p>
        )}
        {tab === "monitors" && (
          <Button
            className="mb-3"
            onClick={() => {
              setDrafts((previous) =>
                previous.new && (previous.new.dirty || save.isPending)
                  ? previous
                  : { ...previous, new: newMonitorDraft() },
              );
              setReloadValue(null);
              setErrors((previous) => ({ ...previous, new: "" }));
              setEditing("new");
            }}
          >
            新建订阅{drafts.new?.dirty ? "（继续草稿）" : ""}
          </Button>
        )}
        <div
          aria-label={`${labels[tab]}列表`}
          className="max-h-[65vh] space-y-2 overflow-y-auto"
        >
          {tab === "monitors" &&
            monitorPage.data?.items.map((row) => (
              <Button
                key={row.id}
                variant="outline"
                disabled={active.isPlaceholderData}
                className="h-auto w-full justify-start whitespace-normal p-3 text-left"
                onClick={(event) => select(row.id, event.currentTarget)}
              >
                <span className="min-w-0">
                  <strong className="block">
                    {row.name}
                    {drafts[row.id]?.dirty ? " · 未保存草稿" : ""}
                  </strong>
                  <span className="block text-xs">
                    {row.enabled ? "已启用" : "已暂停"} · {row.strategyName} ·{" "}
                    {row.symbols.join("、")}
                  </span>
                  <span className="block text-xs text-nc-text-3">
                    最近检查 {monitorTime(row.lastCheck)}
                    {row.error ? ` · ${row.error}` : ""}
                  </span>
                </span>
              </Button>
            ))}
          {tab === "signals" &&
            signalPage.data?.items.map((row) => (
              <Button
                key={row.id}
                variant="outline"
                disabled={active.isPlaceholderData}
                className="h-auto w-full justify-start whitespace-normal p-3 text-left"
                onClick={(event) => select(row.id, event.currentTarget)}
              >
                <span className="min-w-0">
                  <strong className="block">
                    {row.symbol.toUpperCase()} · {row.strategyName}
                  </strong>
                  <span className="block text-xs">
                    {row.date} · {row.period} · {row.source}
                  </span>
                  <span className="block text-xs">
                    {Object.entries(row.deliveries)
                      .filter(([, count]) => count > 0)
                      .map(
                        ([status, count]) =>
                          `${deliveryLabels[status as keyof typeof deliveryLabels]} ${count}`,
                      )
                      .join(" / ") || "未找到投递记录"}
                  </span>
                </span>
              </Button>
            ))}
          {tab === "deliveries" &&
            deliveryPage.data?.items.map((row) => (
              <Button
                key={row.id}
                variant="outline"
                disabled={active.isPlaceholderData}
                className="h-auto w-full justify-start whitespace-normal p-3 text-left"
                onClick={(event) => select(row.id, event.currentTarget)}
              >
                <span className="min-w-0">
                  <strong className="block break-words">{row.title}</strong>
                  <span className="block text-xs">
                    {deliveryLabels[row.status]} · {monitorTime(row.createdAt)}
                    {row.manualRetry ? " · 人工重发" : ""}
                  </span>
                  <span className="block text-xs text-nc-text-3">
                    {channels.data?.find(
                      (channel) => channel.id === row.channelId,
                    )?.name ?? row.channelId}
                    {row.error ? ` · ${row.error}` : ""}
                  </span>
                </span>
              </Button>
            ))}
        </div>
        {active.isSuccess && !active.data.items.length && (
          <p className="py-4 text-sm">
            当前条件下没有{labels[tab]}记录，可重置筛选。
          </p>
        )}
        <MonitorPages
          page={pages[tab].length}
          more={active.data?.hasMore ?? false}
          busy={active.isFetching}
          previous={() =>
            setPages((previous) => ({
              ...previous,
              [tab]: previous[tab].slice(0, -1),
            }))
          }
          next={() => {
            if (active.data?.nextCursor)
              setPages((previous) => ({
                ...previous,
                [tab]: [...previous[tab], active.data.nextCursor ?? undefined],
              }));
          }}
        />
      </Panel>
      <Panel
        title={editing ? "订阅配置" : "记录详情"}
        span={7}
        className="min-w-0"
      >
        {editing && currentDraft ? (
          <>
            <MonitorEditor
              draft={currentDraft}
              channels={channels.data ?? []}
              watchlist={watchlist}
              busy={save.isPending}
              error={errors[editing]}
              onChange={(patch) =>
                setDrafts((previous) => ({
                  ...previous,
                  [editing]: {
                    ...previous[editing]!,
                    ...patch,
                    dirty: true,
                    revision: (previous[editing]?.revision ?? 0) + 1,
                  },
                }))
              }
              onSave={saveDraft}
              onClose={back}
              onReload={currentDraft.id ? () => void reloadDraft() : undefined}
            />
            {reloadValue && reloadValue.id === currentDraft.id && (
              <MonitorEvidence
                value={reloadValue}
                label="最新服务端配置（核对草稿）"
              />
            )}
          </>
        ) : selected[tab] ? (
          <MonitorDetail
            key={`${tab}:${selected[tab]}`}
            kind={kinds[tab]}
            id={selected[tab]}
            onBack={back}
            onEdit={edit}
            onChanged={() => void changed()}
            onRelated={(signalId) => {
              setFilters((previous) => ({
                ...previous,
                deliveries: { query: "", signalId },
              }));
              setDraftFilters((previous) => ({
                ...previous,
                deliveries: { query: "", signalId },
              }));
              setPages((previous) => ({
                ...previous,
                deliveries: [undefined],
              }));
              setSelected((previous) => ({ ...previous, deliveries: "" }));
              setTab("deliveries");
            }}
          />
        ) : (
          <p className="text-sm text-nc-text-3">
            选择一条记录查看完整证据，或在订阅页创建监控。
          </p>
        )}
      </Panel>
    </PageGrid>
  );
}
