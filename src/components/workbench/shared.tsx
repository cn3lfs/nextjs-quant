import { Database } from "lucide-react";
import { type Monitor } from "~/lib/domain";
import { Button } from "../ui/button";

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
  return (
    <div className="flex items-center gap-3 py-2">
      <Button
        variant="ghost"
        disabled={page === 0}
        onClick={() => onChange(page - 1)}
      >
        上一页
      </Button>
      <span>
        第 {page + 1} / {Math.max(1, Math.ceil(count / 50))} 页 · {count} 条
      </span>
      <Button
        variant="ghost"
        disabled={(page + 1) * 50 >= count}
        onClick={() => onChange(page + 1)}
      >
        下一页
      </Button>
    </div>
  );
}
