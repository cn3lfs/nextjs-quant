"use client";

import { UploadSimple } from "@phosphor-icons/react/ssr";
import { Panel } from "../panels";
import type { RouterInputs, RouterOutputs } from "~/trpc/react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Badge } from "../ui/badge";

export const deliverySourceLabels = {
  ths: "同花顺",
  eastmoney: "东方财富",
  tdx: "通达信",
  generic: "通用",
} as const;
export type DeliveryDraft = RouterInputs["deliveryPreview"];
export type DeliveryPreview = RouterOutputs["deliveryPreview"];

export function TradeReviewPreview({
  preview,
  busy,
  onConfirm,
}: {
  preview: DeliveryPreview;
  busy: boolean;
  onConfirm: () => void;
}) {
  const { summary, mapping } = preview;
  return (
    <Card>
      <CardHeader>
        <CardTitle>导入预览 · {preview.fileName}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p>
          账户：{preview.account} · 来源：{deliverySourceLabels[preview.source]}
        </p>
        <p className="font-semibold">
          将写入 {summary.new} 行 / 已存在 {summary.duplicate} 行 / 冲突{" "}
          {summary.conflict} 行 / 待核对 {summary.unresolved} 行 / 异常{" "}
          {summary.anomalies} 笔
        </p>
        <section aria-label="列映射结果" className="space-y-2">
          <h3 className="font-medium">列映射结果</h3>
          <p>
            {Object.entries(mapping.columns)
              .map(([field, index]) => `第 ${index! + 1} 列 → ${field}`)
              .join("；") || "无可识别列"}
          </p>
          <p>
            费用参与列：
            {Object.entries(mapping.feeColumns)
              .map(
                ([field, indices]) =>
                  `${field}：${indices.map((i) => i + 1).join("、") || "无"}`,
              )
              .join("；")}
          </p>
          <p>
            未映射的列：
            {mapping.unmapped
              .map((c) => `第 ${c.index + 1} 列「${c.header}」`)
              .join("；") || "无"}
          </p>
          <p>
            重复列：
            {mapping.duplicates
              .map((c) => `第 ${c.index + 1} 列「${c.header}」→ ${c.field}`)
              .join("；") || "无"}
          </p>
        </section>
        <section aria-label="诊断信息">
          <h3 className="font-medium">诊断信息</h3>
          {[...new Set([...mapping.warnings, ...preview.diagnostics])].map(
            (message, i) => (
              <p key={i}>{message}</p>
            ),
          )}
          {!mapping.warnings.length && !preview.diagnostics.length && (
            <p>无诊断信息</p>
          )}
        </section>
        {summary.conflict > 0 && (
          <section
            role="alert"
            className="rounded-lg border border-destructive p-3"
          >
            <h3 className="font-semibold">
              存在冲突，禁止导入；整批导入会回滚
            </h3>
            {preview.rows
              .filter((row) => row.status === "conflict")
              .map((row, i) => (
                <p key={i}>
                  第 {row.rowIndex} 行 · 差异字段：{row.differences.join("、")}{" "}
                  · 编号：{row.id}
                </p>
              ))}
          </section>
        )}
        <details>
          <summary className="cursor-pointer">逐行状态与待核对明细</summary>
          {preview.rows.map((row, i) => (
            <p key={i}>
              第 {row.rowIndex} 行 ·{" "}
              <Badge variant="outline">
                {
                  { new: "将写入", duplicate: "已存在", conflict: "冲突" }[
                    row.status
                  ]
                }
              </Badge>{" "}
              {row.differences.join("、")}
            </p>
          ))}
          {preview.parsed.unresolved.map((row, i) => (
            <p key={i}>
              第 {row.rowIndex} 行 · 待核对：{row.reason} ·{" "}
              {row.cells.join(" / ")}
            </p>
          ))}
          {preview.parsed.fills
            .filter((fill) => fill.anomalies.length)
            .map((fill, i) => (
              <p key={i}>
                第 {fill.rowIndex} 行 · 异常：{fill.anomalies.join("；")}
              </p>
            ))}
        </details>
        <p className="text-sm text-muted-foreground">
          预览不会写库。确认后保存可识别记录及待核对证据；已存在记录跳过，冲突整批拒绝。
        </p>
        <Button disabled={busy || summary.conflict > 0} onClick={onConfirm}>
          {busy ? "正在导入…" : "确认导入"}
        </Button>
      </CardContent>
    </Card>
  );
}

export function TradeReviewImport({
  directory,
  onDirectoryChange,
  onList,
  files,
  draft,
  onDraftChange,
  onPreview,
  preview,
  busy,
  onConfirm,
}: {
  directory: string;
  onDirectoryChange: (value: string) => void;
  onList: () => void;
  files: RouterOutputs["deliveryFiles"] | undefined;
  draft: DeliveryDraft;
  onDraftChange: (value: DeliveryDraft) => void;
  onPreview: () => void;
  preview?: DeliveryPreview;
  busy: boolean;
  onConfirm: () => void;
}) {
  return (
    <Panel
      aria-label="交割单导入向导"
      icon={UploadSimple}
      title="交割单导入"
      bodyClassName="space-y-4"
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1 space-y-2">
          <Label htmlFor="delivery-directory">交割单目录（只读）</Label>
          <Input
            id="delivery-directory"
            value={directory}
            maxLength={2048}
            disabled={busy}
            onChange={(e) => onDirectoryChange(e.target.value)}
          />
        </div>
        <Button
          variant="outline"
          disabled={busy || !directory.trim()}
          onClick={onList}
        >
          列出文件
        </Button>
      </div>
      {files && (
        <div className="space-y-2" aria-label="候选文件">
          {files.length ? (
            files.map((file) => (
              <div
                key={file.path}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
              >
                <p>
                  {file.name} · {file.size} 字节 ·{" "}
                  {new Date(file.modifiedAt).toLocaleString("zh-CN")}
                </p>
                <Button
                  variant={draft.path === file.path ? "default" : "outline"}
                  disabled={busy}
                  onClick={() => onDraftChange({ ...draft, path: file.path })}
                >
                  {draft.path === file.path ? "已选择" : "选择文件"}
                </Button>
              </div>
            ))
          ) : (
            <p>目录内没有 .xls / .txt / .csv 文件。</p>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-2">
          <Label htmlFor="delivery-account">账户别名</Label>
          <Input
            id="delivery-account"
            value={draft.account}
            maxLength={64}
            disabled={busy}
            onChange={(e) =>
              onDraftChange({ ...draft, account: e.target.value })
            }
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="delivery-source">来源</Label>
          <Select
            value={draft.source}
            disabled={busy}
            onValueChange={(source) =>
              onDraftChange({
                ...draft,
                source: source as DeliveryDraft["source"],
              })
            }
          >
            <SelectTrigger id="delivery-source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(deliverySourceLabels).map(([key, label]) => (
                <SelectItem value={key} key={key}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          disabled={busy || !draft.path || !draft.account.trim()}
          onClick={onPreview}
        >
          {busy ? "处理中…" : "预览"}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        已选文件：{draft.path || "尚未选择"}
        。账户别名用于区分账本，请勿输入真实资金账号。
      </p>
      {preview && (
        <TradeReviewPreview
          preview={preview}
          busy={busy}
          onConfirm={onConfirm}
        />
      )}
    </Panel>
  );
}
