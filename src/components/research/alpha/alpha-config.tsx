import { Plus, Trash } from "@phosphor-icons/react/ssr";
import { FormField, FormGrid, Panel, PanelEmpty } from "~/components/panels";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
  alphaBuiltinOptions,
  builtinLabel,
  type AlphaDraft,
  type AlphaFactorDraft,
} from "./draft";

export const weightingLabels = {
  equal: "等权",
  icir: "因果滚动 ICIR",
  custom: "自定义权重",
} satisfies Record<AlphaDraft["weightingMethod"], string>;

export const neutralizationLabels = {
  none: "无",
  industry: "行业",
  size: "市值",
  industry_size: "行业 + 市值",
} satisfies Record<AlphaDraft["neutralizationMode"], string>;

const winsorizeLabels = {
  none: "无",
  mad: "MAD",
  quantile: "分位数",
} satisfies Record<AlphaDraft["winsorizeMethod"], string>;

function MethodSelect<T extends string>({
  label,
  accessibleLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  accessibleLabel?: string;
  value: T;
  options: Record<T, string>;
  onChange: (value: T) => void;
}) {
  return (
    <FormField label={label}>
      <select
        aria-label={accessibleLabel}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value as T)}
      >
        {Object.keys(options).map((key) => (
          <option key={key} value={key}>
            {options[key as T]}
          </option>
        ))}
      </select>
    </FormField>
  );
}

export function AlphaConfig({
  draft,
  onChange,
  busy,
  savePending,
  evaluationPending,
  canSave,
  canEvaluate,
  onSave,
  onEvaluate,
}: {
  draft: AlphaDraft;
  onChange: (patch: Partial<AlphaDraft>) => void;
  busy: boolean;
  savePending: boolean;
  evaluationPending: boolean;
  canSave: boolean;
  canEvaluate: boolean;
  onSave: () => void;
  onEvaluate: () => void;
}) {
  const horizons = [...new Set([1, 5, 10, 20, ...draft.horizons])].sort(
    (a, b) => a - b,
  );
  const factorLimit = draft.factors.length >= 32;
  const updateFactor = (factorId: string, patch: Partial<AlphaFactorDraft>) =>
    onChange({
      factors: draft.factors.map((row) =>
        row.factorId === factorId ? { ...row, ...patch } : row,
      ),
    });
  const addFormula = () => {
    let index = 1;
    while (draft.factors.some((row) => row.factorId === `tdx-${index}`))
      index++;
    onChange({
      factors: [
        ...draft.factors,
        { factorId: `tdx-${index}`, formula: "", direction: 1, weight: 1 },
      ],
    });
  };

  return (
    <Panel title="组合配置" span={8} tone="accent">
      <fieldset disabled={busy} className="m-0 min-w-0 space-y-4 border-0 p-0">
        <FormGrid>
          <FormField label="组合名称">
            <Input
              value={draft.name}
              onChange={(e) => onChange({ name: e.target.value })}
            />
          </FormField>
          <FormField label="组合说明">
            <Input
              value={draft.description}
              onChange={(e) => onChange({ description: e.target.value })}
            />
          </FormField>
        </FormGrid>
        <div className="flex flex-wrap gap-2" aria-label="快捷添加因子">
          {alphaBuiltinOptions.map(({ id, label }) => (
            <Button
              key={id}
              size="sm"
              variant="outline"
              disabled={
                factorLimit || draft.factors.some((row) => row.factorId === id)
              }
              onClick={() =>
                onChange({
                  factors: [
                    ...draft.factors,
                    { factorId: id, direction: 1, weight: 1 },
                  ],
                })
              }
            >
              <Plus aria-hidden size={14} />
              {label}
            </Button>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={factorLimit}
            onClick={addFormula}
          >
            <Plus aria-hidden size={14} />
            TDX 公式
          </Button>
        </div>
        {draft.factors.length ? (
          <ul className="divide-y divide-nc-border-soft border-y border-nc-border-soft">
            {draft.factors.map((factor) => {
              const label =
                factor.formula === undefined
                  ? (builtinLabel(factor.factorId) ?? factor.factorId)
                  : `TDX 公式 · ${factor.factorId}`;
              return (
                <li key={factor.factorId} className="space-y-2 py-2">
                  <div className="flex flex-wrap items-end gap-2">
                    <strong className="min-w-32 flex-1 self-center text-sm">
                      {label}
                    </strong>
                    <MethodSelect
                      label="方向"
                      accessibleLabel={`${label} 方向`}
                      value={factor.direction === 1 ? "1" : "-1"}
                      options={{ "1": "+1 正向", "-1": "-1 反向" }}
                      onChange={(value) =>
                        updateFactor(factor.factorId, {
                          direction: value === "1" ? 1 : -1,
                        })
                      }
                    />
                    <FormField label="权重">
                      <Input
                        aria-label={`${label} 权重`}
                        className="w-24 tabular-nums"
                        type="number"
                        min={0}
                        step="any"
                        value={
                          Number.isFinite(factor.weight) ? factor.weight : ""
                        }
                        onChange={(e) =>
                          updateFactor(factor.factorId, {
                            weight: e.target.valueAsNumber,
                          })
                        }
                      />
                    </FormField>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`移除${label}`}
                      onClick={() =>
                        onChange({
                          factors: draft.factors.filter(
                            (row) => row.factorId !== factor.factorId,
                          ),
                        })
                      }
                    >
                      <Trash aria-hidden size={16} />
                    </Button>
                  </div>
                  {factor.formula !== undefined && (
                    <Textarea
                      aria-label={label}
                      rows={2}
                      spellCheck={false}
                      className="font-mono"
                      maxLength={20000}
                      placeholder="例如 X:C/REF(C,20)-1;"
                      value={factor.formula}
                      onChange={(e) =>
                        updateFactor(factor.factorId, {
                          formula: e.target.value,
                        })
                      }
                    />
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <PanelEmpty>添加内置因子或输入 TDX 公式。</PanelEmpty>
        )}
        <FormGrid>
          <MethodSelect
            label="合成方法"
            value={draft.weightingMethod}
            options={weightingLabels}
            onChange={(weightingMethod) => onChange({ weightingMethod })}
          />
          <MethodSelect
            label="截面缩尾"
            value={draft.winsorizeMethod}
            options={winsorizeLabels}
            onChange={(winsorizeMethod) => onChange({ winsorizeMethod })}
          />
          <MethodSelect
            label="中性化"
            value={draft.neutralizationMode}
            options={neutralizationLabels}
            onChange={(neutralizationMode) => onChange({ neutralizationMode })}
          />
          <MethodSelect
            label="分组数"
            value={draft.quantiles === 5 ? "5" : "10"}
            options={{ "5": "5", "10": "10" }}
            onChange={(value) =>
              onChange({ quantiles: value === "5" ? 5 : 10 })
            }
          />
          <FormField label="评估起始日期">
            <Input
              type="date"
              value={draft.start}
              onChange={(e) => onChange({ start: e.target.value })}
            />
          </FormField>
          <FormField label="评估结束日期">
            <Input
              type="date"
              min={draft.start || undefined}
              value={draft.end}
              onChange={(e) => onChange({ end: e.target.value })}
            />
          </FormField>
        </FormGrid>
        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="mb-1 text-xs font-medium text-nc-text-2">
            持有期（交易日）
          </legend>
          <div className="flex flex-wrap gap-3">
            {horizons.map((horizon) => (
              <label
                key={horizon}
                className="flex items-center gap-1.5 text-sm"
              >
                <Checkbox
                  checked={draft.horizons.includes(horizon)}
                  onCheckedChange={(checked) =>
                    onChange({
                      horizons: checked
                        ? [...draft.horizons, horizon].sort((a, b) => a - b)
                        : draft.horizons.filter((value) => value !== horizon),
                    })
                  }
                />
                T+{horizon}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <Button disabled={!canEvaluate} onClick={onEvaluate}>
            {evaluationPending ? "正在提交…" : "运行全市场评估"}
          </Button>
          <Button variant="outline" disabled={!canSave} onClick={onSave}>
            {savePending ? "正在保存…" : draft.id ? "保存修改" : "保存组合"}
          </Button>
        </div>
      </fieldset>
    </Panel>
  );
}
