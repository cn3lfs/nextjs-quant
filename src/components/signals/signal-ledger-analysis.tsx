"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";
import { useTaskVisible } from "../workbench/use-task-visible";
import { archiveStamp } from "../research/archive-evidence";
import { SignalLedgerSummaryTable } from "./signal-ledger-summary-table";
import { SignalInformationView } from "./signal-information-view";
import { LedgerError } from "./ledger-fields";
import { LedgerRules } from "./signal-ledger-view";

export function LedgerAnalysisPanel() {
  const visible = useTaskVisible(),
    query = api.ledgerAnalysis.useQuery(undefined, {
      enabled: visible,
      staleTime: 30000,
    });
  const [page, setPage] = useState(0),
    data = query.data;
  return (
    <div className="min-w-0 space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <strong>全部历史样本 · 不跟随列表筛选</strong>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void query.refetch()}
        >
          刷新全样本分析
        </Button>
      </div>
      <LedgerError
        message={query.error?.message}
        onRetry={() => void query.refetch()}
        stale={!!data}
      />
      {query.isLoading && <p>正在计算全样本分析…</p>}
      {data && (
        <>
          <p>
            样本{data.sampleCount}条 · {data.from ?? "无"}至{data.to ?? "无"} ·
            读取于{archiveStamp(data.readAt)}
          </p>
          <LedgerRules />
          <div className="max-w-full overflow-x-auto">
            <SignalLedgerSummaryTable groups={data.groups} />
          </div>
          <SignalInformationView
            computed={data.information}
            page={page + 1}
            onPageChange={(value) => setPage(value - 1)}
          />
        </>
      )}
    </div>
  );
}
