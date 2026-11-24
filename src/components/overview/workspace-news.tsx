"use client";

import { Newspaper } from "@phosphor-icons/react/ssr";
import Link from "next/link";
import { useState } from "react";
import { api, type RouterInputs } from "~/trpc/react";
import { Panel, Pill, Segmented, StateBanner } from "../panels";
import { useScreenVisible } from "../workbench/use-task-visible";

const sources = [
  { value: "holdings", label: "持仓" },
  { value: "watchlist", label: "自选" },
  { value: "candidates", label: "候选" },
] as const;
type Scope = (typeof sources)[number]["value"];
type NewsInput = RouterInputs["workspaceNews"];
const securityLimit = 500;
const newsClock = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function newsSecurities(symbols: readonly string[]) {
  return [
    ...new Set(
      symbols.map((value) =>
        value
          .trim()
          .normalize("NFKC")
          .toLowerCase()
          .replace(/^(\d{6})\.(sh|sz|bj)$/, "$2$1"),
      ),
    ),
  ]
    .filter((value) => /^(sh|sz|bj)\d{6}$/.test(value))
    .sort();
}

export function WorkspaceNews({
  holdings,
  candidates,
  candidateTotal,
  names,
}: {
  holdings: readonly string[] | null;
  candidates: readonly string[];
  candidateTotal: number;
  names: Readonly<Record<string, string>> | undefined;
}) {
  const [scope, setScope] = useState<Scope>("holdings");
  const visible = useScreenVisible();
  const watchlist = api.watchlistGroups.useQuery(undefined, {
    enabled: visible && scope === "watchlist",
    staleTime: 90_000,
    retry: false,
  });
  const symbols =
    scope === "holdings"
      ? holdings
      : scope === "candidates"
        ? candidates
        : (watchlist.data?.groups.flatMap((group) => group.symbols) ?? null);
  const securities = newsSecurities(symbols ?? []);
  const input: NewsInput = {
    [scope]: securities.slice(0, securityLimit).map((symbol) => ({
      symbol,
      name: names?.[symbol]?.trim().slice(0, 100) || undefined,
    })),
  };
  // Pass one scope so its newest matches get their own result limit.
  const enabled = visible && securities.length > 0;
  const news = api.workspaceNews.useQuery(input, {
    enabled,
    staleTime: 90_000,
    refetchInterval: enabled ? 90_000 : false,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  const watchlistError = scope === "watchlist" ? watchlist.error : null;

  return (
    <Panel
      icon={Newspaper}
      title="精准快讯"
      id="workspace-news"
      meta="财联社 · 最近 7 日 · 每 90 秒刷新"
      actions={
        <Link href="/intel" prefetch={false} className="text-sub underline">
          全部情报 →
        </Link>
      }
      note="按证券名称或代码匹配。"
      bodyClassName="space-y-3"
    >
      <Segmented
        label="快讯匹配范围"
        options={sources}
        value={scope}
        onChange={setScope}
      />
      {watchlistError ? (
        <StateBanner
          state="error"
          title="自选列表读取失败"
          action={{ label: "重试", onClick: () => void watchlist.refetch() }}
        >
          {watchlistError.message}
        </StateBanner>
      ) : symbols === null ? (
        <p className="text-sub text-nc-text-3" role="status">
          {scope === "holdings"
            ? "持仓尚未核对，快讯匹配待更新。"
            : "正在读取自选分组…"}
        </p>
      ) : securities.length === 0 ? (
        <StateBanner state="empty" title="此范围内暂无 A 股证券" />
      ) : news.isError ? (
        <StateBanner
          state="error"
          title="财联社快讯读取失败"
          action={{ label: "重试", onClick: () => void news.refetch() }}
        >
          {news.error.message}
        </StateBanner>
      ) : !news.data ? (
        <p className="text-sub text-nc-text-3" role="status">
          正在匹配快讯…
        </p>
      ) : news.data.items.length === 0 ? (
        <StateBanner state="empty" title="最近 7 日暂无匹配快讯" />
      ) : (
        <ul
          className="max-h-88 divide-y divide-nc-border-soft overflow-y-auto"
          aria-label="匹配快讯"
        >
          {news.data.items.map((item) => (
            <li key={item.id} className="space-y-1 py-2">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <time
                  dateTime={item.publishedAt}
                  className="text-sub tabular-nums text-nc-text-4"
                >
                  {newsClock.format(new Date(item.publishedAt))}
                </time>
                <Link
                  href={item.href}
                  prefetch={false}
                  className="min-w-0 font-medium text-nc-text hover:underline [overflow-wrap:anywhere]"
                >
                  {item.title || "查看快讯"}
                </Link>
              </div>
              {item.preview && item.preview !== item.title && (
                <p className="line-clamp-2 text-sub text-nc-text-3 [overflow-wrap:anywhere]">
                  {item.preview}
                </p>
              )}
              <div className="flex flex-wrap gap-1">
                {item.matches.map((match) => (
                  <Pill key={match.symbol} tone="accent">
                    {match.name ? `${match.name} · ` : ""}
                    {match.symbol.toUpperCase()}
                  </Pill>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      {scope === "candidates" && candidates.length < candidateTotal && (
        <p className="text-sub text-nc-text-4">
          匹配首页快照中的 {candidates.length} 条候选，共 {candidateTotal} 条。
        </p>
      )}
      {securities.length > securityLimit && (
        <p className="text-sub text-nc-text-4">
          当前范围有 {securities.length} 个证券，按代码匹配前 {securityLimit}{" "}
          个。
        </p>
      )}
    </Panel>
  );
}
