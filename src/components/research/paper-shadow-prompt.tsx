"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import { useScreenVisible } from "../workbench/use-task-visible";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";

/** Shared Today/Lab governance prompt; reading never enables observation. */
export function PaperShadowPrompt() {
  const visible = useScreenVisible();
  const [revision, setRevision] = useState<string | null>(null);
  const utils = api.useUtils();
  const query = api.paperShadowScanning.useQuery(undefined, {
    enabled: visible,
  });
  const enable = api.enablePaperShadowScanning.useMutation({
    onSuccess: async () => {
      setRevision(null);
      await Promise.all([
        utils.paperShadowScanning.invalidate(),
        utils.strategyLab.invalidate(),
        utils.strategyLabDetail.invalidate(),
        utils.todayWorkspace.invalidate(),
      ]);
    },
  });
  if (query.error)
    return (
      <p role="alert">
        纸面候选扫描状态读取失败：{query.error.message}{" "}
        <Button onClick={() => void query.refetch()}>重试</Button>
      </p>
    );
  if (!query.data?.pending) return null;
  const snapshot = query.data;
  return (
    <section className="space-y-2 rounded-lg border bg-nc-card p-4">
      <p>纸面候选仍在研究中；{snapshot.pending} 个尚未启用影子扫描。</p>
      <Button
        onClick={() => {
          enable.reset();
          setRevision(snapshot.revision);
        }}
      >
        启用 {snapshot.pending} 个纸面候选的影子扫描
      </Button>
      <Dialog
        open={revision !== null}
        onOpenChange={(open) => {
          if (!open) setRevision(null);
        }}
      >
        <DialogContent>
          <DialogTitle>确认启用纸面候选的影子扫描</DialogTitle>
          <DialogDescription>
            从当前时点观察并生成研究候选，保留已有前推记录。影子候选未晋级；此操作不改变全局提醒模式、订阅或模拟镜像。
          </DialogDescription>
          <ul className="max-h-48 overflow-auto text-sm">
            {snapshot.candidates
              .filter((c) => c.available && !c.active && !c.live)
              .map((c) => (
                <li key={`${c.id}:${c.version}`}>
                  {c.id} v{c.version} · 研究中 / 影子
                </li>
              ))}
          </ul>
          {enable.error && (
            <p role="alert">
              {enable.error.message}{" "}
              <Button
                variant="outline"
                onClick={() =>
                  void query.refetch().then((result) => {
                    if (result.data) {
                      setRevision(result.data.revision);
                      enable.reset();
                    }
                  })
                }
              >
                重新核对
              </Button>
            </p>
          )}
          <Button
            disabled={enable.isPending}
            onClick={() => {
              if (revision) enable.mutate({ revision, confirmed: true });
            }}
          >
            确认启用影子扫描
          </Button>
        </DialogContent>
      </Dialog>
    </section>
  );
}
