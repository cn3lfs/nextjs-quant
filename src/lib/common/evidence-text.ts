import { formatNumber } from "trading-strategy-core/format-number";

const labels: Record<string, string> = {
  id: "编号",
  version: "版本",
  symbol: "品种",
  strategyId: "策略",
  strategyVersion: "策略版本",
  market: "市场",
  period: "周期",
  date: "日期",
  bar: "bar日期",
  type: "类型",
  source: "来源",
  reason: "原因",
  status: "状态",
  value: "数值",
  price: "价格",
  quantity: "数量",
  name: "名称",
  title: "标题",
  input: "输入",
  result: "结果",
  parameters: "参数",
  evidence: "依据",
  entry: "入场",
  exit: "退出",
  stop: "止损",
  target: "目标",
  sleeve: "分仓",
  createdAt: "创建时间",
  observedAt: "观察时间",
  availableAt: "可得时间",
  hash: "内容摘要",
  sha256: "SHA256摘要",
  fast: "短周期",
  slow: "长周期",
  kind: "种类",
  weight: "权重",
  minimum: "最小值",
  maximum: "最大值",
  enabled: "启用",
  error: "错误",
  errors: "错误明细",
};
function reminder(value: string) {
  if (!value.startsWith("[")) return null;
  try {
    const v: unknown = JSON.parse(value);
    if (
      Array.isArray(v) &&
      v.length >= 5 &&
      typeof v[0] === "string" &&
      typeof v[1] === "number" &&
      ["cn-equity", "crypto"].includes(v[2]) &&
      typeof v[3] === "string" &&
      typeof v[4] === "string"
    )
      return `策略 ${v[0]} v${v[1]} · 品种 ${v[3]} · bar日期 ${v[4]} · 提醒`;
  } catch {
    /* Ordinary evidence text is not a serialized reminder identity. */
  }
  return null;
}
/** Readable evidence only. Complete unmodified objects remain in explicit JSON
 * exports; dedupe identifiers never appear as raw serialized arrays in UI. */
export function formatEvidenceText(value: unknown, depth = 0): string {
  if (value == null) return "未提供";
  if (typeof value === "string") return reminder(value) ?? value;
  if (typeof value === "number")
    return formatNumber(value, Number.isInteger(value) ? 0 : 6);
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value !== "object") return String(value);
  const indent = "  ".repeat(depth),
    entries = Object.entries(value);
  if (!entries.length) return "无记录";
  return entries
    .map(([key, item]) => {
      const label = Array.isArray(value)
        ? `第${Number(key) + 1}项`
        : (labels[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2"));
      if (
        typeof item === "string" &&
        (["triggerKey", "alertKey", "dedupeKey", "eventKey"].includes(key) ||
          (key === "key" && reminder(item)))
      )
        return `${indent}提醒：${reminder(item) ?? "内部编号保留于导出"}`;
      return `${indent}${label}：${item && typeof item === "object" ? "\n" : ""}${formatEvidenceText(item, depth + 1)}`;
    })
    .join("\n");
}
