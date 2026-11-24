import { useState } from "react";
import { GridTable, Panel, PanelEmpty, Pill } from "~/components/panels";
import { Button } from "~/components/ui/button";
import type { FactorCompositeRecord } from "~/server/db/factor-composite-repository";
import { num, stamp } from "./alpha-format";

export function AlphaComposites({
  records,
  currentId,
  pending,
  busy,
  error,
  canGoBack,
  canGoNext,
  onBack,
  onNext,
  onRetry,
  onNew,
  onLoad,
  onDelete,
}: {
  records: FactorCompositeRecord[];
  currentId: string;
  pending: boolean;
  busy: boolean;
  error?: string;
  canGoBack: boolean;
  canGoNext: boolean;
  onBack: () => void;
  onNext: () => void;
  onRetry: () => void;
  onNew: () => void;
  onLoad: (record: FactorCompositeRecord) => void;
  onDelete: (id: string) => void;
}) {
  const [deleting, setDeleting] = useState<FactorCompositeRecord>();
  return (
    <Panel
      title="已保存组合"
      span={4}
      actions={
        <Button size="sm" variant="outline" disabled={busy} onClick={onNew}>
          新建组合
        </Button>
      }
      bodyClassName="space-y-2"
    >
      {pending && <PanelEmpty>正在读取组合…</PanelEmpty>}
      {error && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-nc-up">
            {error}
          </p>
          <Button size="sm" variant="outline" onClick={onRetry}>
            重试读取
          </Button>
        </div>
      )}
      {!pending && (!error || records.length > 0) && (
        <GridTable
          label="已保存组合"
          rows={records}
          rowKey={(row) => row.id}
          empty="暂无已保存组合。"
          columns={[
            {
              key: "name",
              header: "组合 / 更新时间",
              width: "1.2fr",
              cell: (row) => (
                <div>
                  <div className="flex flex-wrap items-center gap-1">
                    <strong className="break-all font-medium">
                      {row.name}
                    </strong>
                    {row.id === currentId && <Pill tone="accent">当前</Pill>}
                  </div>
                  <span className="text-xs text-nc-text-3 tabular-nums">
                    {stamp(row.updatedAt)}
                  </span>
                </div>
              ),
            },
            {
              key: "summary",
              header: "最近一次评估",
              cell: ({ latestEvalSummary: summary }) =>
                summary ? (
                  <div className="space-y-0.5 text-xs tabular-nums">
                    {typeof summary.details?.horizon === "number" && (
                      <div>T+{summary.details.horizon}</div>
                    )}
                    <div>RankIC {num(summary.rankIC)}</div>
                    <div>ICIR {num(summary.icir, 2)}</div>
                  </div>
                ) : (
                  <span className="text-nc-text-3">尚无摘要</span>
                ),
            },
            {
              key: "actions",
              header: "操作",
              width: "5.5rem",
              cell: (row) => (
                <div className="flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    aria-label={`加载 ${row.name}`}
                    onClick={() => {
                      setDeleting(undefined);
                      onLoad(row);
                    }}
                  >
                    加载
                  </Button>
                  <Button
                    size="sm"
                    variant="plain"
                    disabled={busy}
                    aria-label={`删除 ${row.name}`}
                    onClick={() => setDeleting(row)}
                  >
                    删除
                  </Button>
                </div>
              ),
            },
          ]}
        />
      )}
      {deleting && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-nc-inset p-2">
          <p className="text-sm">确认删除「{deleting.name}」？</p>
          <Button
            size="sm"
            variant="danger"
            disabled={busy}
            onClick={() => {
              onDelete(deleting.id);
              setDeleting(undefined);
            }}
          >
            确认删除
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDeleting(undefined)}
          >
            取消
          </Button>
        </div>
      )}
      {(canGoBack || canGoNext) && (
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!canGoBack || pending}
            onClick={onBack}
          >
            上一页
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canGoNext || pending}
            onClick={onNext}
          >
            下一页
          </Button>
        </div>
      )}
    </Panel>
  );
}
