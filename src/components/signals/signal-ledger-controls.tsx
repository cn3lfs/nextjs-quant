"use client";

import { Button } from "~/components/ui/button";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cancelLedger } from "~/app/signal-ledger/actions";
export function SignalLedgerControls({ date }: { date?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [router]);
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
                await cancelLedger(date);
                setMessage("已请求取消，正在结束当前步骤。");
                router.refresh();
              } catch {
                setMessage("取消失败，请重试。");
              }
            })
          }
        >
          取消当日台账任务
        </Button>
      )}
      <p role="status" className="m-0 text-[12px] text-nc-text-3">
        {message}
      </p>
    </div>
  );
}
