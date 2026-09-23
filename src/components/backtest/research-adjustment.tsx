"use client";
import {
  bonusAdjustmentAssumptions,
  type AdjustmentDiagnostics,
  type ResearchAdjustment,
} from "~/lib/research/evidence/research-adjustment";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../ui/select";

export function AdjustmentControl({
  value,
  onChange,
}: {
  value: ResearchAdjustment;
  onChange: (value: ResearchAdjustment) => void;
}) {
  return (
    <div className="my-3">
      <span>研究复权口径（回测与滚动检验共用）</span>
      <Select
        value={value}
        onValueChange={(value) => onChange(value as ResearchAdjustment)}
      >
        <SelectTrigger aria-label="研究复权口径">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">不复权（原模式）</SelectItem>
          <SelectItem value="backward">仅送转后复权（现金分红忽略）</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

export function AdjustmentDisclosure({
  mode,
  diagnostics,
  cashExperiment,
}: {
  mode?: ResearchAdjustment;
  diagnostics?: Partial<AdjustmentDiagnostics>;
  cashExperiment?: boolean;
}) {
  if (mode !== "backward")
    return (
      <p className="muted">
        复权口径：
        {cashExperiment
          ? "独立纯现金分红实验（见原假设）"
          : "不复权；跨除权事件不能用于正式收益评价"}
      </p>
    );
  return (
    <details open>
      <summary>复权口径：仅送转后复权（不是完整总回报）</summary>
      <ul>
        {bonusAdjustmentAssumptions.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
      {diagnostics && (
        <p>
          除权日 {diagnostics.exDividendDays} · 策略股数调整{" "}
          {diagnostics.shareAdjustments} · 策略碎股折现{" "}
          {diagnostics.fractionalShares} · 忽略现金分红{" "}
          {diagnostics.dividendsIgnored} · 配股拒绝{" "}
          {diagnostics.rightsIssuesBlocked} · 拒绝事件{" "}
          {diagnostics.blockedEvents?.count}
        </p>
      )}
    </details>
  );
}
