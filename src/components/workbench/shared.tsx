"use client";
import { Database } from "@phosphor-icons/react/ssr";
import { type Monitor } from "~/lib/domain";
import { Button } from "../ui/button";
import { useIntersectionLoadMore } from "../ui/use-infinite-table";

export const fmt = (n: number | undefined, d = 2) =>
  n === undefined
    ? "—"
    : n.toLocaleString("zh-CN", {
        maximumFractionDigits: d,
        minimumFractionDigits: d,
      });
export const stamp = (n: number) =>
  new Date(n).toLocaleString("zh-CN", { hour12: false });
export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="empty">
      <Database size={25} />
      <p>{children}</p>
    </div>
  );
}
export function CalendarEvidence({
  evidence,
}: {
  evidence: Monitor["calendarEvidence"];
}) {
  if (!evidence) return <p className="muted">尚无已归档的日历核验信息</p>;
  return (
    <details>
      <summary>日历核验来源</summary>
      <p>{evidence.source}</p>
      <p>核验时间：{stamp(evidence.assessedAt)}</p>
      <p style={{ overflowWrap: "anywhere" }}>
        来源指纹：{evidence.hash ?? "未记录"}
      </p>
    </details>
  );
}

export function ResultPager({
  page,
  count,
  onChange,
}: {
  page: number;
  count: number;
  onChange: (page: number) => void;
}) {
  const loaded = Math.min((page + 1) * 50, count);
  const hasMore = loaded < count;
  const sentinel = useIntersectionLoadMore({
    enabled: hasMore,
    loading: false,
    onLoadMore: () => onChange(page + 1),
  });
  return (
    <div className="flex flex-wrap items-center gap-3 py-2 text-sm">
      <div ref={sentinel} aria-hidden="true" className="h-px w-full" />
      <span className="text-muted-foreground">
        已加载 {loaded} / 共 {count} 条
      </span>
      {hasMore && (
        <Button variant="outline" size="sm" onClick={() => onChange(page + 1)}>
          加载更多
        </Button>
      )}
    </div>
  );
}
