"use client";
import Link from "next/link";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";
import { MethodologyPopover } from "../panels";
import { usePanelVisible } from "../workbench/keep-alive";
import { NewsTime } from "./news-time";

const intelSources = { position: "持仓", plan: "未完成计划" } as const;
const intelMethodology = [
  {
    label: "匹配范围",
    detail: "仅按已保存持仓及未完成计划的名称/代码匹配本地新闻。",
  },
  {
    label: "摘要口径",
    detail: "摘要为原文节选，不表示已核实利好利空。",
  },
  {
    label: "显示上限",
    detail: "最多显示最近100条。",
  },
] as const;

export function TodayIntel({ all = false }: { all?: boolean }) {
  const visible = usePanelVisible();
  const query = api.todayIntel.useQuery(undefined, {
    enabled: visible,
    retry: false,
  });
  return (
    <section
      aria-label="持仓与计划情报"
      className="space-y-2.5 rounded border border-nc-border bg-nc-card p-3"
    >
      <div className="flex items-center gap-1.5">
        <h2 className="text-lg font-semibold">持仓与计划情报</h2>
        <MethodologyPopover title="情报口径" items={intelMethodology} />
      </div>
      {query.isLoading && <p role="status">正在读取已有新闻…</p>}
      {query.error && (
        <p role="status">
          相关新闻暂不可读取：{query.error.message}{" "}
          <Link href="/system" className="underline">
            检查新闻存档
          </Link>
          <Button variant="plain" onClick={() => void query.refetch()}>
            重试
          </Button>
        </p>
      )}
      {query.data && (
        <>
          {query.data.events.length === 0 && (
            <p className="text-sm text-nc-text-3">暂无持仓/计划关联快讯</p>
          )}
          {query.data.events.slice(0, all ? 100 : 6).map((e) => (
            <article
              key={e.id}
              className="space-y-1 rounded border border-nc-border-soft p-2.5 text-sm"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <NewsTime value={e.publishedAt} short />
                {e.matches.map((m) => (
                  <span
                    key={m.symbol}
                    className="rounded bg-nc-inset px-1.5 py-0.5 text-xs text-nc-text-2"
                  >
                    {m.name ? `${m.name}（${m.symbol}）` : m.symbol}
                    <span className="text-nc-text-3">
                      {" "}
                      · {m.sources.map((source) => intelSources[source]).join("、")}
                    </span>
                  </span>
                ))}
              </div>
              <Link
                href={e.href}
                className="block break-words font-medium hover:underline"
              >
                {e.title}
              </Link>
            </article>
          ))}
          {!all && query.data.events.length > 6 && (
            <p className="text-sm">
              另有 {query.data.events.length - 6} 条，
              <Link href="/intel?tab=related" className="underline">
                查看全部相关情报
              </Link>
            </p>
          )}
        </>
      )}
    </section>
  );
}
