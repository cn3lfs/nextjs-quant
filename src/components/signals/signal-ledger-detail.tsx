"use client";
import { api } from "~/trpc/react";
import { Panel } from "../panels";
import { Button } from "../ui/button";
import { useTaskVisible } from "../workbench/use-task-visible";
import { ArchiveEvidence, ArchiveText } from "../research/archive-evidence";
import { useArchiveDownload } from "../research/use-archive-download";
import { LedgerError } from "./ledger-fields";
import { SignalLedgerView } from "./signal-ledger-view";

export function LedgerDetail({
  id,
  onBack,
}: {
  id: string;
  onBack: () => void;
}) {
  const visible = useTaskVisible();
  const query = api.ledgerDetail.useQuery(id, {
    enabled: visible,
    gcTime: 0,
    staleTime: 0,
  });
  const download = useArchiveDownload();
  return (
    <Panel
      title="信号依据"
      aria-label="信号依据"
      actions={
        <Button size="sm" variant="outline" onClick={onBack}>
          返回信号列表
        </Button>
      }
    >
      {query.isLoading && <p>正在读取完整依据…</p>}
      <LedgerError
        message={query.error?.message}
        onRetry={() => void query.refetch()}
        stale={!!query.data}
      />
      {query.data && (
        <>
          <SignalLedgerView
            rows={[
              { ...query.data.signal, notifications: query.data.notifications },
            ]}
            runs={[]}
          />
          <ArchiveEvidence title="完整JSON依据">
            {() => <ArchiveText text={JSON.stringify(query.data, null, 2)} />}
          </ArchiveEvidence>
          <Button
            className="mt-3"
            size="sm"
            onClick={() =>
              download.save(
                () => JSON.stringify(query.data, null, 2),
                `${query.data!.signal.symbol}-${query.data!.signal.observedDate}-ledger.json`,
                "application/json",
              )
            }
          >
            导出完整信号依据
          </Button>
          {download.error && <p role="alert">{download.error}</p>}
        </>
      )}
    </Panel>
  );
}
