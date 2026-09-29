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
  value == null ? "—" : `${(value * 100).toFixed(2)}%`;
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
        上一页
      </Button>
      <span className="text-xs">第 {count} 页</span>
      <Button
        size="sm"
        variant="outline"
        disabled={!more || busy}
        onClick={next}
      >
        下一页
      </Button>
    </div>
  );
}
