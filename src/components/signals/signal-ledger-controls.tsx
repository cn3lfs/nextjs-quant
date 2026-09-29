"use client";

import { Button } from "~/components/ui/button";
import { useState, useTransition } from "react";
import { cancelLedger } from "~/app/signal-ledger/actions";
export function SignalLedgerControls({
  date,
  onChanged,
}: {
  date?: string;
  onChanged: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  return (
    <div
      className={
        date || message
          ? "mb-[var(--nc-gap)] flex flex-wrap items-center gap-3"
          : "hidden"
      }
    >
      {date && (
        <Button
          variant="danger"
          size="sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              try {
                const result = await cancelLedger(date);
                setMessage(
                  {
                    requested: "取消已请求，等待后台结束当前步骤。",
                    "already-requested": "已请求取消，仍在等待后台确认。",
                    finished: "任务已结束，无需取消。",
                    "not-found": "任务不存在，请刷新任务状态。",
                  }[result.outcome],
                );
                onChanged();
              } catch {
                setMessage("取消失败，请重试。");
              }
            })
          }
        >
          取消台账任务（{date}）
        </Button>
      )}
      <p role="status" className="m-0 text-[12px] text-nc-text-3">
        {message}
      </p>
    </div>
  );
}
