"use client";
import { useState, type ReactNode } from "react";
import { Button } from "../ui/button";
export const archiveStamp = (value: unknown) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 8640000000000000
    ? new Date(value).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : "时间未知";

/** Render heavy evidence only while expanded, including JSON serialization. */
export function ArchiveEvidence({
  title,
  children,
}: {
  title: string;
  children: () => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{title}</summary>
      {open && children()}
    </details>
  );
}
export function ArchiveMetadata({
  createdAt,
  model,
  version,
}: {
  createdAt?: number;
  model?: string;
  version?: string;
}) {
  return (
    <p className="text-sm text-nc-text-3">
      生成时间：
      {typeof createdAt === "number" &&
      Number.isFinite(createdAt) &&
      createdAt >= 0 &&
      createdAt <= 8640000000000000
        ? archiveStamp(createdAt)
        : "时间未知"}{" "}
      · 模型：{model || "未记录"} · 版本：{version || "未记录"}
    </p>
  );
}

/** Keep a large archived source readable without laying out megabytes of text. */
export function ArchiveText({ text }: { text: string }) {
  const [page, setPage] = useState(0);
  const size = 8000;
  const count = Math.max(1, Math.ceil(text.length / size));
  const current = Math.min(page, count - 1);
  function boundary(value: number) {
    const code = text.charCodeAt(value);
    return code >= 0xdc00 && code <= 0xdfff ? value - 1 : value;
  }
  return (
    <div className="min-w-0 space-y-2">
      {count > 1 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>
            证据第 {current + 1} / {count} 段 · 完整内容保留在报告导出中
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            上一段证据
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={current === count - 1}
            onClick={() => setPage(current + 1)}
          >
            下一段证据
          </Button>
        </div>
      )}
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all">
        {text.slice(boundary(current * size), boundary((current + 1) * size))}
      </pre>
    </div>
  );
}
