"use client";
import { Input } from "../ui/input";
import { useId } from "react";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../ui/select";
export const deliveryReadOptions = {
  retry: false,
  staleTime: Infinity,
  gcTime: 0,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;
export function DeliveryField({
  label,
  value,
  onChange,
  disabled = false,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  type?: string;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="grid min-w-0 gap-1 text-sm">
      <span>{label}</span>
      <Input
        id={id}
        value={value}
        type={type}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
export function DeliverySelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: Record<string, string>;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-1 text-sm">
      <span>{label}</span>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(options).map(([key, text]) => (
            <SelectItem key={key} value={key}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
export const deliverySourceText = {
  generic: "通用",
  ths: "同花顺",
  eastmoney: "东方财富",
  tdx: "通达信",
};
export const deliveryScopeText = {
  all: "成交与现金流",
  cashFlowsOnly: "仅现金流",
};
export const deliveryStatusText = {
  all: "全部",
  new: "将写入",
  duplicate: "已存在",
  conflict: "冲突",
  unresolved: "待核对",
  anomaly: "异常",
};
