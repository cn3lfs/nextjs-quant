"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import { Button } from "./ui/button";
import { usePanelVisible } from "./workbench/keep-alive";
import { RpsStatus } from "./rps-status";

/** Data container; the display component receives data and remains independently renderable. */
export function RpsControls() {
  const visible = usePanelVisible();
  const [message, setMessage] = useState("");
  const query = api.rpsStatus.useQuery(undefined, {
    enabled: visible,
    refetchInterval: 2000,
  });
  const onSuccess = () => {
    setMessage("请求已处理");
    void query.refetch();
  };
  const onError = (error: { message: string }) => setMessage(error.message);
  const start = api.rpsStart.useMutation({ onSuccess, onError });
  const cancel = api.rpsCancel.useMutation({ onSuccess, onError });
  const running = query.data?.progress?.status === "running";
  return (
    <section className="space-y-4" aria-label="个股RPS数据管理">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={
            running || start.isPending || query.isPending || query.isError
          }
          onClick={() => start.mutate({ mode: "backfill", days: 250 })}
        >
          回填最近250个交易日
        </Button>
        <Button
          disabled={
            running || start.isPending || query.isPending || query.isError
          }
          onClick={() => start.mutate({ mode: "forward", days: 1 })}
        >
          计算今日（15:05后）
        </Button>
        <Button
          variant="outline"
          disabled={!running || cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          取消任务
        </Button>
      </div>
      {message && <p role="status">{message}</p>}
      {query.isPending && <p role="status">读取RPS任务状态…</p>}
      {query.isError && (
        <div role="alert">
          读取失败：{query.error.message}
          <Button variant="outline" onClick={() => void query.refetch()}>
            重试
          </Button>
        </div>
      )}
      {query.data && <RpsStatus latest={query.data.latest} />}
    </section>
  );
}
