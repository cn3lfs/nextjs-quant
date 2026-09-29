"use client";
import { useId, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../ui/select";
export const tradeNumber = (value: number | null | undefined) =>
  value == null
    ? "—"
    : value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
export function TradeInputField({
  label,
  value,
  onChange,
  type = "text",
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  maxLength?: number;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="grid gap-1 text-sm">
      <span>{label}</span>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        maxLength={maxLength}
      />
    </label>
  );
}
export function TradeSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label}>
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
export function TradeError({
  error,
  onRetry,
}: {
  error?: string | null;
  onRetry?: () => void;
}) {
  return error ? (
    <div
      role="alert"
      className="space-y-2 rounded border border-nc-border-soft p-3"
    >
      <p>{error}</p>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          重试原请求
        </Button>
      )}
    </div>
  ) : null;
}
export function TradeEvidence({ text }: { text: string }) {
  const [page, setPage] = useState(0),
    size = 8000,
    pages = Math.max(1, Math.ceil(text.length / size));
  // Keep UTF-16 surrogate pairs together at a segment boundary.
  const boundary = (at: number) =>
    at > 0 && at < text.length && /[\uDC00-\uDFFF]/.test(text[at]!)
      ? at - 1
      : at;
  return (
    <div className="space-y-2">
      <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded bg-nc-inset p-3 text-xs">
        {text.slice(boundary(page * size), boundary((page + 1) * size))}
      </pre>
      {pages > 1 && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!page}
            onClick={() => setPage(page - 1)}
          >
            上一段
          </Button>
          <span>
            第{page + 1}/{pages}段 · 完整内容可导出
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={page + 1 >= pages}
            onClick={() => setPage(page + 1)}
          >
            下一段
          </Button>
        </div>
      )}
    </div>
  );
}
export function downloadTradeFile(name: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
