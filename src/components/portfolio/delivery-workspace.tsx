"use client";
import { useEffect, useState } from "react";
import { UploadSimple } from "@phosphor-icons/react/ssr";
import { Panel } from "../panels";
import { Button } from "../ui/button";
import { useTaskVisible } from "../workbench/use-task-visible";
import { DeliveryImportWorkspace } from "./delivery-import-workspace";
import { DeliveryBatchWorkspace } from "./delivery-batch-workspace";
export function DeliveryWorkspace({
  view: tab,
  onViewChange: setTab,
  onSaved,
  onReview,
  cashBatch,
  onReturnToCash,
  returnLabel = "返回现金核对证据",
}: {
  view: "import" | "batches";
  onViewChange: (view: "import" | "batches") => void;
  onSaved: (account: string) => Promise<void>;
  onReview: (account: string) => void;
  cashBatch?: { id: string; revision: number } | null;
  onReturnToCash?: () => void;
  /** Label of the button that returns to where the batch was opened from. */
  returnLabel?: string;
}) {
  const [batchId, setBatchId] = useState<string | null>(null);
  const [batchChange, setBatchChange] = useState({ account: "", revision: 0 });
  const [openRevision, setOpenRevision] = useState(0);
  const visible = useTaskVisible();
  useEffect(() => {
    if (!cashBatch) return;
    setBatchId(cashBatch.id);
    setOpenRevision((value) => value + 1);
    setTab("batches");
  }, [cashBatch]);
  return (
    <Panel
      icon={UploadSimple}
      title="交割单导入与核对"
      bodyClassName="space-y-4"
    >
      {cashBatch && (
        <Button variant="outline" onClick={onReturnToCash}>
          {returnLabel}
        </Button>
      )}

      <div hidden={tab !== "import"}>
        <DeliveryImportWorkspace
          active={visible && tab === "import"}
          batchChange={batchChange}
          onSaved={onSaved}
          onReview={onReview}
          onBatch={(id) => {
            setBatchId(id);
            setOpenRevision((value) => value + 1);
            setTab("batches");
          }}
        />
      </div>
      <div hidden={tab !== "batches"}>
        <DeliveryBatchWorkspace
          active={visible && tab === "batches"}
          initialId={batchId}
          openRevision={openRevision}
          onSaved={async (account) => {
            setBatchChange((value) => ({
              account,
              revision: value.revision + 1,
            }));
            await onSaved(account);
          }}
        />
      </div>
    </Panel>
  );
}
