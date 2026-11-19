"use client";
import type {
  NewsArchiveOption,
  NewsArchiveOptions,
} from "~/lib/news/news-archives";
import { Segmented } from "../panels";
import { Button } from "../ui/button";
export function NewsArchiveSwitch({
  options,
  value,
  unconfigured,
  note,
  onSelect,
}: {
  options: NewsArchiveOption[];
  value: string;
  unconfigured: NewsArchiveOptions["unconfigured"];
  note: string | null;
  onSelect: (option: NewsArchiveOption) => void;
}) {
  const available = options.filter((option) => option.available);
  return (
    <div className="my-3 space-y-2" aria-label="新闻档案来源">
      {available.length > 1 ? (
        <Segmented
          label="新闻档案来源"
          value={value}
          onChange={(key) => {
            const option = available.find((item) => item.key === key);
            if (option) onSelect(option);
          }}
          options={available.map((option) => ({
            value: option.key,
            label: option.label,
          }))}
        />
      ) : (
        <p role="status" className="text-sm">
          当前档案：
          {available[0]
            ? `${available[0].primary ? "主档案" : "互补档案"} · ${available[0].label}`
            : "无可用档案"}
        </p>
      )}
      {options
        .filter((option) => !option.available)
        .map((option) => (
          <p key={option.key} role="status" className="text-sm text-nc-warn">
            {option.primary ? "主档案" : "互补档案"} · {option.label}：
            {option.message ?? "不可用"}
          </p>
        ))}
      {unconfigured.length > 0 && (
        <p className="text-sm text-nc-text-3">
          未配置：{unconfigured.map((item) => item.label).join("、")}
          。可在“数据与连接设置 → 新闻采集”中补充；不会自动使用其他档案。
        </p>
      )}
      {note && <p className="text-sm text-nc-warn">{note}</p>}
    </div>
  );
}
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
export { newsTime } from "~/lib/news/news-time";
