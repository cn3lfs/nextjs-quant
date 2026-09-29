"use client";
import type { ReactNode } from "react";
import { Input } from "../ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../ui/select";
import { Button } from "../ui/button";
export const ledgerStrategyName = (value: string) =>
  value === "czsc" ? "缠论" : "双突破";
export const ledgerRunLabels = {
  running: "运行中",
  complete: "完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
};
export function LedgerInput({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value?: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label className="grid gap-1 text-xs text-nc-text-2">
      {label}
      <Input
        aria-label={label}
        type={type}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
export function LedgerSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value?: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <label className="grid gap-1 text-xs text-nc-text-2">
      {label}
      <Select
        value={value || "all"}
        onValueChange={(value) => onChange(value === "all" ? "" : value)}
      >
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
    </label>
  );
}
export function LedgerPaging({
  page,
  next,
  busy,
  onPrevious,
  onNext,
  label = "记录",
  total,
}: {
  page: number;
  next: boolean;
  busy: boolean;
  onPrevious: () => void;
  onNext: () => void;
  label?: string;
  total: number;
}) {
  return (
    <nav
      aria-label={`${label}分页`}
      className="mt-3 flex flex-wrap items-center gap-3 text-xs"
    >
      <Button size="sm" disabled={page <= 1 || busy} onClick={onPrevious}>
        上一页{label}
      </Button>
      <span>
        {total}条{label} · 第{page}页 · 每页20条
      </span>
      <Button size="sm" disabled={!next || busy} onClick={onNext}>
        下一页{label}
      </Button>
    </nav>
  );
}
export function LedgerError({
  message,
  onRetry,
  stale = false,
}: {
  message?: string;
  onRetry: () => void;
  stale?: boolean;
}) {
  return message ? (
    <p role="alert" className="my-2 text-sm text-nc-bad">
      {message}。{stale && "保留上次成功结果，可能已过期。"}
      <Button size="sm" variant="outline" onClick={onRetry}>
        重试读取
      </Button>
    </p>
  ) : null;
}
export function LedgerOptional({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="nc-span-12 min-w-0 rounded border border-nc-border p-3">
      <Button variant="outline" aria-expanded={open} onClick={onToggle}>
        {title}
      </Button>
      {open && <div className="mt-3 min-w-0">{children}</div>}
    </section>
  );
}
