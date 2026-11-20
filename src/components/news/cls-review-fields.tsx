import { formatNumber as displayNumber } from "trading-strategy-core/format-number";
import { Button } from "../ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../ui/select";
export function ClsSelect({
  label,
  value,
  onChange,
  options,
  placeholder = "请选择",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="w-full">
        <SelectValue placeholder={placeholder} />
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
export const clsPct = (value: number | null | undefined) =>
  value == null ? "—" : `${displayNumber(value * 100, 2)}%`;
export const clsTime = (value: number) =>
  new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
export const clsDirections: Record<string, string> = {
  bullish: "偏多",
  bearish: "偏空",
  neutral: "中性/混合",
  unknown: "待核对",
};
export function ClsError({
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
        <Button size="sm" variant="outline" onClick={retry}>
          重试读取
        </Button>
      )}
    </p>
  ) : null;
}
/** Kept only so the retired fact-check module still type-checks; no active view
 * renders it. New views load continuously instead of paging. */
export function ClsPages({
  count,
  more,
  busy,
  previous,
  next,
}: {
  count: number;
  more: boolean;
  busy: boolean;
  previous: () => void;
  next: () => void;
}) {
  return (
    <div className="flex items-center gap-2 py-2">
      <Button
        size="sm"
        variant="outline"
        disabled={count <= 1 || busy}
        onClick={previous}
      >
        较早
      </Button>
      <span className="text-xs">第 {count} 页</span>
      <Button
        size="sm"
        variant="outline"
        disabled={!more || busy}
        onClick={next}
      >
        较新
      </Button>
    </div>
  );
}

/** T+N return cell: red up, green down, muted while the window is incomplete. */
export function ClsReturnValue({
  returnPct,
  elapsed,
  horizon,
  noBase = false,
}: {
  returnPct: number | null | undefined;
  elapsed: number;
  horizon: number;
  /** No local base bar at all: the window can never fill, so show “—”. */
  noBase?: boolean;
}) {
  if (returnPct == null)
    return (
      <span className="text-nc-text-4">
        {!noBase && elapsed < horizon ? `待满${horizon}日` : "—"}
      </span>
    );
  return (
    <span
      className={
        returnPct > 0
          ? "text-nc-up"
          : returnPct < 0
            ? "text-nc-down"
            : "text-nc-text-3"
      }
    >
      {`${returnPct > 0 ? "+" : ""}${displayNumber(returnPct, 2)}%`}
    </span>
  );
}
