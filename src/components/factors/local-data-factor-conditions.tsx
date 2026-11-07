"use client";
import {
  localDataFactorCatalog,
  type LocalDataFactorCondition,
} from "trading-strategy-core/factors";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

export function LocalDataFactorConditions({
  value,
  onChange,
  disabled,
}: {
  value: readonly LocalDataFactorCondition[];
  onChange: (value: LocalDataFactorCondition[]) => void;
  disabled: boolean;
}) {
  const update = (index: number, patch: Partial<LocalDataFactorCondition>) =>
    onChange(value.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium">
        本地数据因子（日线收盘后，全部满足）
      </h4>
      <p className="text-xs text-muted-foreground">
        规模、估值、资金、股东、指定板块、市场环境和沪深300风险因子。只使用基准日记录，稀疏序列不前填；源零值未认证时留空。金额阈值按元输入。市场和指定板块是环境条件，不自动推断历史行业归属。此处因子用于筛选，五分钟回测仍使用技术因子。
      </p>
      {value.map((condition, index) => {
        const metadata = localDataFactorCatalog.find(
          (f) => f.id === condition.id,
        )!;
        return (
          <div
            key={index}
            className="space-y-2 rounded border border-border p-3"
          >
            <div className="flex flex-wrap gap-2">
              <Select
                disabled={disabled}
                value={condition.id}
                onValueChange={(id) => update(index, { id })}
              >
                <SelectTrigger
                  aria-label={`数据因子${index + 1}字段`}
                  className="min-w-48 flex-1"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {localDataFactorCatalog.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.category} · {f.label} · {f.unit}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                disabled={disabled}
                value={condition.operator}
                onValueChange={(operator) =>
                  update(index, {
                    operator: operator as LocalDataFactorCondition["operator"],
                  })
                }
              >
                <SelectTrigger aria-label={`数据因子${index + 1}比较`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[
                    { value: "gt", label: "大于" },
                    { value: "gte", label: "大于等于" },
                    { value: "lt", label: "小于" },
                    { value: "lte", label: "小于等于" },
                  ].map((op) => (
                    <SelectItem key={op.value} value={op.value}>
                      {op.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                disabled={disabled}
                type="number"
                aria-label={`数据因子${index + 1}阈值`}
                className="w-36"
                value={
                  Number.isFinite(condition.threshold)
                    ? condition.threshold
                    : ""
                }
                onChange={(event) =>
                  update(index, {
                    threshold:
                      event.target.value === ""
                        ? NaN
                        : Number(event.target.value),
                  })
                }
              />
              <Button
                disabled={disabled}
                variant="outline"
                onClick={() => onChange(value.filter((_, i) => i !== index))}
              >
                删除数据因子
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {metadata.formula} 单位：{metadata.unit}。
            </p>
          </div>
        );
      })}
      <Button
        disabled={disabled || value.length >= 12}
        variant="outline"
        onClick={() =>
          onChange([...value, { id: "GP16-0", operator: "gt", threshold: 0 }])
        }
      >
        添加本地数据因子
      </Button>
    </div>
  );
}
