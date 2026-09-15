"use client";

import {
  chartAdjustmentLabels,
  chartAdjustmentSchema,
  type ChartAdjustment,
} from "~/lib/chart-adjustment";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

export function ChartAdjustmentSelect({
  value,
  onChange,
  disabled = false,
}: {
  value: ChartAdjustment;
  onChange: (value: ChartAdjustment) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => onChange(chartAdjustmentSchema.parse(next))}
    >
      <SelectTrigger aria-label="复权方式" className="w-auto min-w-28">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {chartAdjustmentSchema.options.map((adjustment) => (
          <SelectItem key={adjustment} value={adjustment}>
            {chartAdjustmentLabels[adjustment]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
