"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Books } from "@phosphor-icons/react/ssr";
import { api } from "~/trpc/react";
import {
  archiveKinds,
  archiveKindLabels,
  archiveCursorSchema,
  archiveHistoryInput,
  type ArchiveCursor,
  type ArchiveFilter,
} from "~/lib/research/workflow/archive-history";
import {
  archiveSearch,
  parseArchiveSearch,
} from "~/lib/research/workflow/archive-navigation";
import {
  archivedNameHint,
  securityDisplayName,
} from "~/lib/market/security-display";
import { Panel } from "../panels";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { SecuritySelect } from "../market/security-select";
import { usePanelVisible } from "./keep-alive";
import { archiveStamp as stamp } from "../research/archive-evidence";

const sessionKey = "quant-research-archive-navigation-v1";
export function ArchiveList({ names }: { names: Record<string, string> }) {
  const visible = usePanelVisible();
  const [ready, setReady] = useState(false);
  const [filter, setFilter] = useState<ArchiveFilter>({});
  const [draft, setDraft] = useState<ArchiveFilter>({});
  const [cursors, setCursors] = useState<(ArchiveCursor | undefined)[]>([
    undefined,
  ]);
  const [error, setError] = useState("");
  const restore = useRef<{ id: string; scroll: number } | null>(null);
  const history = api.researchArchiveHistory.useQuery(
    { ...filter, cursor: cursors.at(-1) },
    {
      enabled: ready && visible,
      staleTime: 0,
      refetchOnWindowFocus: true,
      retry: false,
    },
  );
  useEffect(() => {
    if (!visible) return;
    function readLocation() {
      if (window.location.pathname !== "/reports") return;
      const next = parseArchiveSearch(window.location.search);
      setFilter(next);
      setDraft(next);
      setCursors([undefined]);
      try {
        const stored = JSON.parse(
          sessionStorage.getItem(sessionKey) ?? "null",
        ) as {
          search?: string;
          cursors?: unknown[];
          id?: string;
          scroll?: number;
        } | null;
        if (
          stored?.search === archiveSearch(next) &&
          Array.isArray(stored.cursors) &&
          stored.cursors.length <= 500
        ) {
          const parsed = stored.cursors.map((c) =>
            c === null ? undefined : archiveCursorSchema.parse(c),
          );
          if (parsed.length && parsed[0] === undefined) setCursors(parsed);
          if (
            typeof stored.id === "string" &&
            typeof stored.scroll === "number"
          )
            restore.current = { id: stored.id, scroll: stored.scroll };
        }
      } catch {
        /* A stale session bookmark must never prevent opening the archive. */
      }
      setReady(true);
    }
    readLocation();
    window.addEventListener("popstate", readLocation);
    return () => window.removeEventListener("popstate", readLocation);
  }, [visible]);
  useEffect(() => {
    if (!visible || !history.data || !restore.current) return;
    const saved = restore.current;
    restore.current = null;
    const frame = requestAnimationFrame(() => {
      document
        .getElementById(`archive-${saved.id}`)
        ?.focus({ preventScroll: true });
      window.scrollTo({ top: saved.scroll });
    });
    return () => cancelAnimationFrame(frame);
  }, [visible, history.data]);
  useEffect(() => {
    if (!ready || !visible) return;
    try {
      const previous = JSON.parse(sessionStorage.getItem(sessionKey) ?? "null");
      const search = archiveSearch(filter);
      sessionStorage.setItem(
        sessionKey,
        JSON.stringify({
          search,
          cursors,
          id: previous?.search === search ? previous.id : "",
          scroll: previous?.search === search ? previous.scroll : 0,
        }),
      );
    } catch {
      /* Session storage is optional; in-memory navigation still works. */
    }
  }, [ready, visible, filter, cursors]);
  function apply(next: ArchiveFilter) {
    const parsed = archiveHistoryInput.safeParse(next);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "筛选无效");
      return;
    }
    const query = archiveSearch(parsed.data);
    window.history.replaceState(
      null,
      "",
      `/reports${query ? `?${query}` : ""}`,
    );
    setFilter(parsed.data);
    setDraft(parsed.data);
    setCursors([undefined]);
    setError("");
    restore.current = null;
    try {
      sessionStorage.removeItem(sessionKey);
    } catch {}
  }
  function bookmark(id: string) {
    try {
      sessionStorage.setItem(
        sessionKey,
        JSON.stringify({
          search: archiveSearch(filter),
          cursors,
          id,
          scroll: window.scrollY,
        }),
      );
    } catch {}
  }
  return (
    <Panel
      icon={Books}
      title="研究报告"
      meta={
        history.data
          ? `匹配 ${history.data.filteredTotal} 份 · 第 ${cursors.length} 页`
          : "四类研究档案"
      }
      note="检索通用研究、CAN SLIM、缠论与威科夫报告。生成时间与证据数据时点分别显示。"
      actions={
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={!ready || history.isFetching}
            onClick={() => void history.refetch()}
          >
            刷新当前页
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setCursors([undefined]);
              if (cursors.length === 1) void history.refetch();
            }}
          >
            回到最新
          </Button>
        </>
      }
    >
      <form
        className="mb-4 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          apply(draft);
        }}
      >
        <fieldset className="flex flex-wrap gap-4">
          <legend className="mb-1 text-sm">报告类型</legend>
          {archiveKinds.map((kind) => (
            <label key={kind} className="flex items-center gap-1 text-sm">
              <Checkbox
                aria-label={archiveKindLabels[kind]}
                checked={(draft.kinds ?? archiveKinds).includes(kind)}
                onCheckedChange={(checked) => {
                  const kinds = draft.kinds ?? [...archiveKinds];
                  setDraft({
                    ...draft,
                    kinds:
                      checked === true
                        ? [...kinds, kind]
                        : kinds.filter((k) => k !== kind),
                  });
                }}
              />
              {archiveKindLabels[kind]}
            </label>
          ))}
        </fieldset>
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <label className="min-w-0 flex-1 text-sm">
            标题或报告 ID
            <Input
              value={draft.keyword ?? ""}
              maxLength={100}
              placeholder="输入后按 Enter 查询"
              onChange={(e) => setDraft({ ...draft, keyword: e.target.value })}
            />
          </label>
          <div className="min-w-0 max-w-full space-y-1">
            <span className="text-sm">
              关联证券{" "}
              {draft.symbol ? securityDisplayName(draft.symbol, names) : "全部"}
            </span>
            <SecuritySelect
              symbol={draft.symbol ?? ""}
              period="day"
              disabled={false}
              captureKeys={false}
              label="档案关联证券"
              placeholder="选择证券名称或代码"
              onSelect={(symbol) => setDraft({ ...draft, symbol })}
            />
            {draft.symbol && (
              <Button
                type="button"
                size="sm"
                variant="plain"
                onClick={() => setDraft({ ...draft, symbol: undefined })}
              >
                清除证券
              </Button>
            )}
          </div>
          <label className="text-sm">
            生成日期从（北京时间）
            <Input
              type="date"
              value={draft.from ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, from: e.target.value || undefined })
              }
            />
          </label>
          <label className="text-sm">
            至
            <Input
              type="date"
              value={draft.to ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, to: e.target.value || undefined })
              }
            />
          </label>
          <div className="flex flex-wrap gap-2 sm:col-span-2 xl:col-span-4">
            <Button type="submit">查询</Button>
            <Button type="button" variant="outline" onClick={() => apply({})}>
              清空条件
            </Button>
          </div>
        </div>
      </form>
      <p className="mb-2 text-sm text-nc-text-3">
        已应用：
        {(filter.kinds ?? archiveKinds)
          .map((k) => archiveKindLabels[k])
          .join("、")}
        {filter.keyword ? ` · 关键词“${filter.keyword}”` : ""}
        {filter.symbol ? ` · ${filter.symbol.toUpperCase()}` : ""}
        {filter.from || filter.to
          ? ` · ${filter.from ?? "不限"} 至 ${filter.to ?? "不限"}`
          : ""}
        ；关键词仅匹配标题或 ID。
      </p>
      {error && <p role="alert">{error}</p>}
      {(!ready || history.isPending) && !history.data && (
        <p role="status">正在读取报告列表…</p>
      )}
      {history.isFetching && history.data && (
        <p role="status">正在更新，现有列表仍可阅读…</p>
      )}
      {history.error && (
        <p role="alert">
          {history.data ? "刷新未成功，以下是上次结果。" : "档案读取失败："}
          {history.error.message}{" "}
          <Button variant="outline" onClick={() => void history.refetch()}>
            重试列表
          </Button>
        </p>
      )}
      {history.data && (
        <>
          {!history.data.items.length && (
            <p>
              {history.data.filteredTotal
                ? "当前页已没有报告，可回到上一页或最新报告。"
                : Object.values(filter).some(Boolean)
                  ? "无匹配结果，请调整或清空条件。"
                  : "暂无四类研究报告。估值与财务质量在下方独立区域。"}
            </p>
          )}
          <ul aria-label="研究报告列表" className="divide-y divide-nc-border">
            {history.data.items.map((item) => (
              <li
                key={item.id}
                className="grid min-w-0 gap-2 py-3 sm:grid-cols-[6rem_9rem_minmax(0,1fr)_10rem]"
              >
                <span className="text-sm text-nc-text-3">
                  {archiveKindLabels[item.kind]}
                </span>
                <span
                  className="text-sm"
                  title={
                    item.securityContext
                      ? archivedNameHint(
                          item.securityContext.symbol,
                          names,
                          item.securityContext.archivedName,
                        )
                      : undefined
                  }
                >
                  {item.securityContext ? (
                    <>
                      {securityDisplayName(
                        item.securityContext.symbol,
                        names,
                        item.securityContext.archivedName,
                      )}
                      <span className="block text-xs text-nc-text-3">
                        {item.securityContext.symbol.toUpperCase()}
                      </span>
                    </>
                  ) : (
                    "未确认关联证券"
                  )}
                </span>
                <div className="min-w-0 break-words">
                  <Link
                    id={`archive-${item.id}`}
                    className="text-link break-all focus-visible:outline"
                    href={`/reports/${item.kind}/${encodeURIComponent(item.id)}?archive=${encodeURIComponent(archiveSearch(filter))}`}
                    prefetch={false}
                    onClick={() => bookmark(item.id)}
                  >
                    {item.title}
                  </Link>
                  {!item.readable && (
                    <p className="text-sm">
                      元数据不完整，打开后核对读取状态。
                    </p>
                  )}
                </div>
                <time className="text-sm text-nc-text-3">
                  {item.createdAt === null ? "时间未知" : stamp(item.createdAt)}
                </time>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={cursors.length === 1 || history.isFetching}
          onClick={() => setCursors(cursors.slice(0, -1))}
        >
          上一页报告
        </Button>
        <Button
          variant="outline"
          disabled={!history.data?.nextCursor || history.isFetching}
          onClick={() => {
            if (history.data?.nextCursor)
              setCursors([...cursors, history.data.nextCursor]);
          }}
        >
          下一页报告
        </Button>
      </div>
    </Panel>
  );
}
