"use client";

import { useState } from "react";
import type { RouterOutputs } from "~/trpc/react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../ui/dialog";
import { deliverySourceLabels } from "./trade-review-import";

export function TradeReviewBatches({
  batches,
  busy,
  onRevoke,
}: {
  batches: RouterOutputs["deliveryBatches"];
  busy: boolean;
  onRevoke: (id: string) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState<(typeof batches)[number] | null>(
    null,
  );
  return (
    <section className="space-y-3" aria-label="导入批次">
      <h2 className="text-xl font-semibold">导入批次</h2>
      <p className="text-sm text-muted-foreground">
        成交/现金流为文件识别笔数，包含因重复而跳过的记录。
      </p>
      {!batches.length && <p>尚无导入批次。</p>}
      {batches.map((batch) => (
        <div
          key={batch.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
        >
          <div>
            <p className="font-medium">
              {batch.fileName} · {batch.account} ·{" "}
              {deliverySourceLabels[batch.source]}
            </p>
            <p className="text-sm text-muted-foreground">
              {new Date(batch.importedAt).toLocaleString("zh-CN")} · 成交{" "}
              {batch.statistics.fills} 笔 / 现金流 {batch.statistics.cashFlows}{" "}
              笔
            </p>
          </div>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setSelected(batch)}
          >
            撤销
          </Button>
        </div>
      ))}
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open && !busy) setSelected(null);
        }}
      >
        <DialogContent showCloseButton={!busy}>
          <DialogTitle>确认撤销导入批次</DialogTitle>
          <DialogDescription>
            {selected?.fileName} · {selected?.account}
            。撤销只影响该批次，其他批次不受影响。该批次写入的成交和现金流会删除，复盘将重新计算。
          </DialogDescription>
          <div className="flex justify-end gap-3">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setSelected(null)}
            >
              取消
            </Button>
            <Button
              disabled={busy}
              onClick={async () => {
                if (selected && (await onRevoke(selected.id)))
                  setSelected(null);
              }}
            >
              {busy ? "正在撤销…" : "确认撤销"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
