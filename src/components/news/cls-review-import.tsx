"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ClsError } from "./cls-review-fields";
import { ClsReviewText } from "./cls-review-text";
export function ClsReviewImport({
  visible,
  imported,
  currentReportId,
}: {
  visible: boolean;
  currentReportId: string;
  imported: (id: string, origin: string) => void;
}) {
  const utils = api.useUtils();
  const [path, setPath] = useState(""),
    [previewPath, setPreviewPath] = useState("");
  const preview = api.clsReviewPreview.useQuery(previewPath, {
    enabled: visible && !!previewPath,
    retry: false,
    gcTime: 0,
  });
  const save = api.clsReviewImport.useMutation({
    gcTime: 0,
    onMutate: () => ({ origin: currentReportId }),
    onSuccess: (value, _, context) => {
      void utils.clsReviewReportPage.invalidate(undefined, {
        refetchType: "none",
      });
      void utils.clsReviewSummary.invalidate(undefined, {
        refetchType: "none",
      });
      imported(value.id, context?.origin ?? currentReportId);
    },
  });
  return (
    <section className="space-y-3" aria-label="导入报告">
      <p className="text-sm text-nc-text-3">
        只读导入现有
        Markdown；预览后文件变化须重新预览。报告时间不能替代实际盘前选样时间。
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (path.trim() === previewPath) void preview.refetch();
          else setPreviewPath(path.trim());
        }}
      >
        <label className="min-w-64 flex-1 text-sm">
          报告文件完整路径
          <Input
            required
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
        </label>
        <Button disabled={preview.isFetching}>预览报告</Button>
      </form>
      <ClsError error={preview.error} retry={() => void preview.refetch()} />
      <ClsError error={save.error} />
      {preview.data && (
        <div className="space-y-2 rounded border border-nc-border-soft p-3">
          <strong>{preview.data.report.title}</strong>
          <p className="text-sm">
            报告日期：{preview.data.report.reportDate ?? "未识别"} ·{" "}
            {preview.data.report.sections.length} 个章节
          </p>
          {preview.data.report.warnings.map((warning) => (
            <p key={warning} className="text-sm text-nc-warn">
              {warning}
            </p>
          ))}
          <details>
            <summary>核对原文</summary>
            <ClsReviewText
              key={preview.data.report.hash}
              text={preview.data.report.markdown}
              label="预览原文"
            />
          </details>
          {path.trim() !== previewPath && (
            <p role="status">路径已变化，请重新预览。</p>
          )}
          <Button
            disabled={
              path.trim() !== previewPath ||
              preview.isFetching ||
              !!preview.error ||
              save.isPending
            }
            onClick={() =>
              save.mutate({
                path: previewPath,
                hash: preview.data!.report.hash,
              })
            }
          >
            {save.isPending ? "正在导入…" : "导入此版本"}
          </Button>
        </div>
      )}
    </section>
  );
}
