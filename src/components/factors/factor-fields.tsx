"use client";
import { factorCatalog, type FactorSpec } from "trading-strategy-core/factors";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
export function FactorFields({
  value,
  onChange,
  disabled,
  label,
}: {
  value: FactorSpec;
  onChange: (value: FactorSpec) => void;
  disabled: boolean;
  label: string;
}) {
  const metadata = factorCatalog.find((f) => f.id === value.id)!;
  return (
    <div className="space-y-2">
      <Select
        value={value.id}
        disabled={disabled}
        onValueChange={(id) => {
          const factor = factorCatalog.find((f) => f.id === id);
          if (factor) onChange({ id: factor.id });
        }}
      >
        <SelectTrigger className="w-full" aria-label={`${label}因子`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {factorCatalog.map((f) => (
            <SelectItem key={f.id} value={f.id}>
              {f.category} · {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex flex-wrap gap-2">
        {Object.entries(metadata.parameters).map(([key, rule]) => (
          <label key={key} className="grid w-28 gap-1 text-xs text-nc-text-2">
            {key === "period" ? rule.label : `${key} · ${rule.label}`}
            <Input
              type="number"
              min={rule.min}
              max={rule.max}
              step={rule.integer ? 1 : 0.1}
              aria-label={`${label}${key}`}
              disabled={disabled}
              value={
                Number.isFinite(value.parameters?.[key] ?? rule.default)
                  ? (value.parameters?.[key] ?? rule.default)
                  : ""
              }
              onChange={(e) =>
                onChange({
                  ...value,
                  parameters: {
                    ...value.parameters,
                    [key]: e.target.value === "" ? NaN : Number(e.target.value),
                  },
                })
              }
            />
          </label>
        ))}
      </div>
      <p className="text-xs leading-relaxed text-nc-text-3">
        {metadata.description} 单位：{metadata.unit}。
      </p>
      {metadata.source && (
        <p className="text-xs leading-relaxed text-nc-text-3">
          来源：
          <a
            className="underline"
            href={metadata.source.url}
            target="_blank"
            rel="noreferrer"
          >
            {metadata.source.name} · {metadata.source.originalName}
          </a>
          。{metadata.source.notes}
        </p>
      )}
    </div>
  );
}
