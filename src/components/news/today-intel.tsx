"use client";
import Link from "next/link";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";
import { usePanelVisible } from "../workbench/keep-alive";

export function TodayIntel({ all = false }: { all?: boolean }) {
  const visible = usePanelVisible();
  const query = api.todayIntel.useQuery(undefined, {
    enabled: visible,
    retry: false,
  });
  return (
    <section
      aria-label="持仓与计划情报"
      className="space-y-3 rounded border bg-nc-card p-4"
    >
      <h2 className="text-lg font-semibold">持仓与计划情报</h2>
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
          <p className="text-xs text-nc-text-3">{query.data.notice}</p>
          {query.data.events.length === 0 && (
            <p>今日已有存档中暂无匹配新闻。</p>
          )}
          {query.data.events.slice(0, all ? 100 : 6).map((e) => (
            <details key={e.id}>
              <summary>
                {new Date(e.publishedAt).toLocaleTimeString("zh-CN")} ·{" "}
                {e.title}
              </summary>
              <p className="whitespace-pre-wrap text-sm">{e.preview}</p>
              <Link href={e.href} className="text-sm underline">
                在情报查看原文
              </Link>
            </details>
          ))}
          {!all && query.data.events.length > 6 && (
            <p>
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
