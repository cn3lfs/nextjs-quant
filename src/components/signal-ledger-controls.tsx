"use client";
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
    <div>
      {date && (
        <button
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
        </button>
      )}
      <p role="status">{message}</p>
    </div>
  );
}
