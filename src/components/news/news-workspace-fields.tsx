"use client";
import { Button } from "../ui/button";
export function NewsError({
  message,
  retry,
  stale = false,
}: {
  message?: string;
  retry: () => void;
  stale?: boolean;
}) {
  return message ? (
    <div role="alert" className="my-2 text-sm text-nc-bad">
      {message}。{stale && "保留上次成功结果，可能已过期。"}
      <Button size="sm" variant="outline" onClick={retry}>
        重试读取
      </Button>
    </div>
  ) : null;
}
export function NewsPaging({
  label,
  page,
  total,
  next,
  busy,
  onPrevious,
  onNext,
}: {
  label: string;
  page: number;
  total: number;
  next: boolean;
  busy: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <nav
      aria-label={`${label}分页`}
      className="my-3 flex flex-wrap items-center gap-3 text-sm"
    >
      <Button size="sm" disabled={page === 1 || busy} onClick={onPrevious}>
        上一页{label}
      </Button>
      <span>
        {total}条 · 第{page}页
      </span>
      <Button size="sm" disabled={!next || busy} onClick={onNext}>
        下一页{label}
      </Button>
    </nav>
  );
}
export function rememberNews(key: string, value: unknown) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Optional navigation only. */
  }
}
export function readNewsMemory(key: string): unknown {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}
export const newsTime = (value: number | string | null | undefined) =>
  value == null
    ? "未知"
    : new Date(value).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      });
