import { FactorFields } from "../factors/factor-fields";
import { factorCatalog } from "trading-strategy-core/factors";
import { Plus, Trash2 } from "lucide-react";
import {
  factorStrategyPresets,
  type FactorStrategyInput,
} from "trading-strategies";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

type Condition = FactorStrategyInput["entry"]["conditions"][number];
const operators: { value: Condition["operator"]; label: string }[] = [
  { value: "gt", label: "大于" },
  { value: "gte", label: "大于等于" },
  { value: "lt", label: "小于" },
  { value: "lte", label: "小于等于" },
  { value: "cross-above", label: "上穿" },
  { value: "cross-below", label: "下穿" },
];

export function FactorStrategyEditor({
  value,
  onChange,
  disabled,
}: {
  value: FactorStrategyInput | undefined;
  onChange: (value: FactorStrategyInput | undefined) => void;
  disabled: boolean;
}) {
  function changeCondition(
    side: "entry" | "exit",
    index: number,
    condition: Condition,
  ) {
    if (!value) return;
    onChange({
      ...value,
      [side]: {
        ...value[side],
        conditions: value[side].conditions.map((c, i) =>
          i === index ? condition : c,
        ),
      },
    });
  }
  return (
    <section
      aria-label="模块化技术因子策略"
      className="space-y-4 rounded-lg border border-nc-border bg-nc-card p-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-medium">策略与技术因子</h3>
        <Select
          value={value ? "factors" : "baseline"}
          disabled={disabled}
          onValueChange={(mode) =>
            onChange(
              mode === "baseline"
                ? undefined
                : structuredClone(factorStrategyPresets[0]!),
            )
          }
        >
          <SelectTrigger className="w-52" aria-label="策略模式">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="baseline">双均线 SMA5/20 基线</SelectItem>
            <SelectItem value="factors">模块化因子组合</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-xs text-nc-text-3">
          {factorCatalog.length} 个因子 · 趋势 / 动量 / 波动 / 量价 / 突破
        </span>
      </div>
      {value ? (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm">
              策略名称
              <Input
                aria-label="因子策略名称"
                value={value.name}
                maxLength={60}
                disabled={disabled}
                onChange={(e) => onChange({ ...value, name: e.target.value })}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              {factorStrategyPresets.map((preset) => (
                <Button
                  key={preset.name}
                  variant="outline"
                  disabled={disabled}
                  onClick={() => onChange(structuredClone(preset))}
                >
                  {preset.name}
                </Button>
              ))}
            </div>
          </div>
          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            {(["entry", "exit"] as const).map((side) => (
              <div
                key={side}
                className="min-w-0 space-y-3 rounded-lg border border-nc-border p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-medium">
                    {side === "entry" ? "入场" : "退出"}条件
                  </h4>
                  <Select
                    value={value[side].mode}
                    disabled={disabled}
                    onValueChange={(mode) =>
                      onChange({
                        ...value,
                        [side]: { ...value[side], mode: mode as "all" | "any" },
                      })
                    }
                  >
                    <SelectTrigger
                      className="w-36"
                      aria-label={`${side}组合方式`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部满足</SelectItem>
                      <SelectItem value="any">任一满足</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {value[side].conditions.map((condition, index) => (
                  <div
                    key={index}
                    className="space-y-3 rounded-lg bg-nc-inset p-3"
                  >
                    <div className="flex items-center justify-between text-xs text-nc-text-3">
                      条件 {index + 1}
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`删除${side}条件${index + 1}`}
                        disabled={
                          disabled || value[side].conditions.length <= 1
                        }
                        onClick={() =>
                          onChange({
                            ...value,
                            [side]: {
                              ...value[side],
                              conditions: value[side].conditions.filter(
                                (_, i) => i !== index,
                              ),
                            },
                          })
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                    <FactorFields
                      label={`${side}${index + 1}左侧`}
                      value={condition.left}
                      disabled={disabled}
                      onChange={(left) =>
                        changeCondition(side, index, { ...condition, left })
                      }
                    />
                    <div className="flex flex-wrap gap-2">
                      <Select
                        value={condition.operator}
                        disabled={disabled}
                        onValueChange={(operator) =>
                          changeCondition(side, index, {
                            ...condition,
                            operator: operator as Condition["operator"],
                          })
                        }
                      >
                        <SelectTrigger
                          className="w-32"
                          aria-label={`${side}${index + 1}比较方式`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {operators.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={
                          "factor" in condition.right ? "factor" : "constant"
                        }
                        disabled={disabled}
                        onValueChange={(kind) =>
                          changeCondition(side, index, {
                            ...condition,
                            right:
                              kind === "constant"
                                ? { constant: 0 }
                                : { factor: { id: "sma" } },
                          })
                        }
                      >
                        <SelectTrigger
                          className="w-32"
                          aria-label={`${side}${index + 1}右侧类型`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="constant">固定数值</SelectItem>
                          <SelectItem value="factor">另一因子</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {"factor" in condition.right ? (
                      <FactorFields
                        label={`${side}${index + 1}右侧`}
                        value={condition.right.factor}
                        disabled={disabled}
                        onChange={(factor) =>
                          changeCondition(side, index, {
                            ...condition,
                            right: { factor },
                          })
                        }
                      />
                    ) : (
                      <Input
                        aria-label={`${side}${index + 1}阈值`}
                        type="number"
                        step="any"
                        disabled={disabled}
                        value={
                          Number.isFinite(condition.right.constant)
                            ? condition.right.constant
                            : ""
                        }
                        onChange={(e) =>
                          changeCondition(side, index, {
                            ...condition,
                            right: {
                              constant:
                                e.target.value === ""
                                  ? NaN
                                  : Number(e.target.value),
                            },
                          })
                        }
                      />
                    )}
                  </div>
                ))}
                <Button
                  variant="outline"
                  disabled={disabled || value[side].conditions.length >= 12}
                  onClick={() =>
                    onChange({
                      ...value,
                      [side]: {
                        ...value[side],
                        conditions: [
                          ...value[side].conditions,
                          {
                            left: { id: "roc" },
                            operator: "gt",
                            right: { constant: 0 },
                          },
                        ],
                      },
                    })
                  }
                >
                  <Plus className="size-4" />
                  添加条件
                </Button>
              </div>
            ))}
          </div>
          <p className="text-xs leading-relaxed text-nc-text-3">
            周期按五分钟行情根数计算。退出优先；缺失不触发，退出证据未知时不入场。示例只说明组合用法，不代表已验证收益。相对成交量按此前
            N 根均量计算，估算量不能证明真实量价关系。
          </p>
        </>
      ) : (
        <p className="text-sm text-nc-text-3">
          固定
          SMA5/20，金叉入场、死叉退出。选择因子组合后可编辑参数、比较方式和条件。
        </p>
      )}
    </section>
  );
}
