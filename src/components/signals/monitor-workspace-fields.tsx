"use client";
import { formatEvidenceText } from "~/lib/common/evidence-text";

import { useState } from "react";
import { Button } from "../ui/button";
import { useIntersectionLoadMore } from "../ui/use-infinite-table";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../ui/select";
export const monitorTime = (at: number | null | undefined) =>
  at == null
    ? "未记录"
    : new Date(at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
export const deliveryLabels = {
  pending: "待发送",
  sending: "发送中",
  sent: "平台已接受",
  failed: "失败",
  expired: "已过期",
  cancelled: "已取消",
};
export function MonitorSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export function MonitorError({
  error,
  retry,
}: {
  error?: { message: string } | null;
  retry?: () => void;
}) {
  return error ? (
    <p role="alert" className="text-sm text-nc-bad">
      {error.message}{" "}
      {retry && (
        <Button variant="outline" size="sm" onClick={retry}>
          重试读取
        </Button>
      )}
    </p>
  ) : null;
}
export function MonitorPages({
  page,
  more,
  busy,
  next,
}: {
  page: number;
  more: boolean;
  busy: boolean;
  previous?: () => void;
  next: () => void;
}) {
  const sentinel = useIntersectionLoadMore({
    enabled: more,
    loading: busy,
    onLoadMore: next,
  });
  return (
    <div className="flex flex-wrap items-center gap-3 py-3">
      <div ref={sentinel} aria-hidden="true" className="h-px w-full" />
      <span className="text-sm text-nc-text-3">第 {page} 批</span>
      {more && (
        <Button variant="outline" size="sm" disabled={busy} onClick={next}>
          {busy ? "加载中…" : "加载更多"}
        </Button>
      )}
    </div>
  );
}
export function MonitorText({ text, label }: { text: string; label: string }) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(text.length / 8000));
  const boundary = (index: number) => {
    const at = index * 8000;
    return at > 0 &&
      at < text.length &&
      text.charCodeAt(at) >= 0xdc00 &&
      text.charCodeAt(at) <= 0xdfff
      ? at - 1
      : at;
  };
  const current = Math.min(page, pages - 1);
  return (
    <div className="space-y-2">
      <pre
        aria-label={label}
        className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs"
      >
        {text.slice(boundary(current), boundary(current + 1))}
      </pre>
      {pages > 1 && (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            {label}上一段
          </Button>
          <span className="text-xs">
            第 {current + 1} / {pages} 段，全文可导出
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={current >= pages - 1}
            onClick={() => setPage(current + 1)}
          >
            {label}下一段
          </Button>
        </div>
      )}
    </div>
  );
}
export function MonitorEvidence({
  value,
  label = "完整证据",
}: {
  value: unknown;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? "收起" : "展开"}
        {label}
      </Button>
      {open && <MonitorText label={label} text={formatEvidenceText(value)} />}
    </div>
  );
}
