"use client";
import { Article } from "@phosphor-icons/react/ssr";
import { api } from "~/trpc/react";
import { Panel, PanelEmpty } from "../panels";
import { ReportCard } from "../workbench/reports";
import { stamp } from "../workbench/shared";

/**
 * Newest general research report for the loaded security, read from the same
 * report history the archive pages through. Shows nothing it cannot find.
 */
export function LatestReport({ symbol }: { symbol: string | undefined }) {
  const names = api.securityNames.useQuery(undefined, { staleTime: 60000 });
  const history = api.reportHistory.useQuery(
    { cursor: undefined },
    { enabled: !!symbol, refetchInterval: 10000 },
  );
  const item = history.data?.items.find(
    (entry) => entry.securityContext?.symbol === symbol,
  );
  const detail = api.archivedReport.useQuery(item?.id ?? "", {
    enabled: !!item,
    staleTime: Infinity,
  });
  return (
    <Panel
      span={8}
      icon={Article}
      title="最新研究"
      meta={item ? stamp(item.createdAt) : "当前证券"}
    >
      {!symbol ? (
        <PanelEmpty>先在行情图表加载一只证券</PanelEmpty>
      ) : history.isLoading || detail.isLoading ? (
        <PanelEmpty>正在读取研究报告…</PanelEmpty>
      ) : history.error || detail.error ? (
        <PanelEmpty>
          报告读取失败：{(history.error ?? detail.error)!.message}
        </PanelEmpty>
      ) : detail.data ? (
        <ReportCard
          report={detail.data}
          securityContext={detail.data.securityContext}
          names={names.data ?? {}}
        />
      ) : (
        <PanelEmpty>
          最近的报告里没有 {symbol.toUpperCase()}
          。开始研究后，结果会写入研究档案并显示在这里。
        </PanelEmpty>
      )}
    </Panel>
  );
}
