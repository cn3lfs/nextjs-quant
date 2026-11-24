import { useId, useState, type ReactNode } from "react";
import {
  defaultPortfolioRiskPolicy,
  type PortfolioRiskPolicy,
} from "quant-execution";
import { Input } from "~/components/ui/input";
import { Checkbox } from "~/components/ui/checkbox";
import type { RouterOutputs } from "~/trpc/react";

export type StudioCatalog = RouterOutputs["studioTemplates"];
export type RiskPolicy = Partial<PortfolioRiskPolicy>;

export function StudioStep({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="min-w-0 space-y-3 rounded-lg border border-nc-border-soft bg-nc-card px-3 pb-3">
      <legend className="px-1 text-sm font-semibold text-nc-text">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

type StrategyGroup = { id: string; label: string; keys: readonly string[] };
export function StrategyPicker({
  label,
  value,
  groups,
  onChange,
}: {
  label: string;
  value: string;
  groups: readonly StrategyGroup[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  const [filter, setFilter] = useState("");
  const term = filter.trim().toLowerCase();
  const options = groups
    .map((group) => ({
      ...group,
      keys: group.keys.filter((key) =>
        (group.label + " " + key).toLowerCase().includes(term),
      ),
    }))
    .filter((group) => group.keys.length > 0);
  const visibleSelection = options.some((group) => group.keys.includes(value));
  return (
    <div className="min-w-0 space-y-2">
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
      <Input
        id={id}
        value={value}
        maxLength={100}
        placeholder="输入策略键或从分组选取"
        onChange={(event) => onChange(event.target.value)}
      />
      {groups.length > 0 && (
        <>
          <Input
            aria-label={`搜索${label}`}
            placeholder="搜索策略或分组"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <select
            aria-label={`按分组选取${label}`}
            className="block w-full"
            value={visibleSelection ? value : ""}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="" disabled>
              {options.length ? "选择策略" : "无匹配策略"}
            </option>
            {options.map((group) => (
              <optgroup key={group.id} label={group.label}>
                {group.keys.map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </>
      )}
    </div>
  );
}

const riskFields: {
  key: keyof PortfolioRiskPolicy;
  label: string;
  fraction?: boolean;
}[] = [
  { key: "reduceThreshold", label: "减仓回撤", fraction: true },
  { key: "pauseThreshold", label: "暂停回撤", fraction: true },
  { key: "recoverThreshold", label: "恢复回撤", fraction: true },
  { key: "recoverConsecutiveDays", label: "恢复连续交易日" },
  { key: "reducedScale", label: "减仓后风险比例", fraction: true },
  { key: "maxTotalStopRisk", label: "总止损敞口", fraction: true },
  { key: "maxIndustryWeight", label: "行业权重上限", fraction: true },
  { key: "maxSingleInstrumentWeight", label: "单标的权重上限", fraction: true },
  {
    key: "maxEtfWeight",
    label: "ETF 权重上限（空值沿用单标的上限）",
    fraction: true,
  },
  { key: "riskPerTrade", label: "单笔风险预算", fraction: true },
  { key: "atrStopMultiple", label: "ATR 止损倍数" },
  {
    key: "missingStopFraction",
    label: "缺失止损时的估算敞口（空值禁止新增仓位）",
    fraction: true,
  },
];

export function RiskPolicyFields({
  value,
  onChange,
}: {
  value: RiskPolicy | undefined;
  onChange: (policy: RiskPolicy | undefined) => void;
}) {
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={value !== undefined}
          onCheckedChange={(enabled) =>
            onChange(enabled === true ? {} : undefined)
          }
        />
        启用账户级风控（PortfolioRiskEngine）
      </label>
      {value && (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {riskFields.map(({ key, label, fraction }) => {
            const effective =
              key in value ? value[key] : defaultPortfolioRiskPolicy[key];
            const nullable =
              key === "maxEtfWeight" || key === "missingStopFraction";
            const scale = fraction ? 100 : 1;
            return (
              <label key={key} className="block text-sm">
                {label}
                {fraction ? "（%）" : ""}
                <Input
                  type="number"
                  className="mt-1"
                  min={fraction ? 0 : 1}
                  max={fraction ? 100 : undefined}
                  step={key === "recoverConsecutiveDays" ? 1 : "any"}
                  value={
                    effective == null
                      ? ""
                      : Number((effective * scale).toPrecision(12))
                  }
                  onChange={(event) => {
                    if (Number.isFinite(event.target.valueAsNumber))
                      onChange({
                        ...value,
                        [key]: event.target.valueAsNumber / scale,
                      });
                    else if (nullable) onChange({ ...value, [key]: null });
                    else onChange({ ...value, [key]: undefined });
                  }}
                />
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
