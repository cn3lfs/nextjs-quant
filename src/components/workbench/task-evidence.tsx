"use client";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";
export function TaskEvidence({ id }: { id: string }) {
  const query = api.taskEvidence.useQuery(id);
  const exportEvidence = api.exportTaskEvidence.useMutation({
    onSuccess: (value) => {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(value, null, 2)], {
          type: "application/json",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `本地任务-${id}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
  });
  if (query.error)
    return <p role="alert">结果摘要读取失败：{query.error.message}</p>;
  if (!query.data) return null;
  return (
    <section aria-label="任务结果摘要" className="space-y-2 rounded border p-3">
      <h3>任务结果摘要</h3>
      <dl>
        {query.data.fields.map((f) => (
          <div key={f.label} className="flex flex-wrap gap-3 text-sm">
            <dt>{f.label}</dt>
            <dd className="break-all">{f.value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-nc-text-3">{query.data.boundary}</p>
      <Button
        variant="outline"
        disabled={exportEvidence.isPending}
        onClick={() => exportEvidence.mutate(id)}
      >
        导出冻结输入与结果
      </Button>
      {exportEvidence.error && (
        <p role="alert">{exportEvidence.error.message}</p>
      )}
    </section>
  );
}
