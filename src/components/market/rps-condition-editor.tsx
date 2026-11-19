"use client";
import { rpsPeriods } from "quant-rps";
import { useRef, useState } from "react";
import type { RpsCondition } from "~/lib/screening/rps-conditions";
import { rpsPeriodLabel } from "~/lib/screening/rps";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

type DraftCondition = {
  key: number;
  period: number;
  side: RpsCondition["side"];
  /** Kept as text so an empty or malformed entry is never silently applied. */
  value: string;
};
type ConditionError = { message: string; key?: number };

/** Shared by row markers and apply validation so both point at the same rows. */
function duplicatePeriods(rows: readonly { period: number }[]) {
  const counts = new Map<number, number>();
  for (const row of rows)
    counts.set(row.period, (counts.get(row.period) ?? 0) + 1);
  return new Set(
    [...counts].filter(([, count]) => count > 1).map(([period]) => period),
  );
}

/** Draft editor shared by stock, industry and concept rankings. The parent owns
 *  the applied conditions and the page reset. */
export function RpsConditionEditor({
  applied,
  onApply,
  onClear,
}: {
  applied: RpsCondition[];
  onApply: (conditions: RpsCondition[]) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState<DraftCondition[]>([]);
  const [conditionError, setConditionError] = useState<ConditionError | null>(
    null,
  );
  const nextDraftKey = useRef(0);
  const duplicates = duplicatePeriods(draft);
  const update = (key: number, patch: Partial<Omit<DraftCondition, "key">>) => {
    setDraft((rows) =>
      rows.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
    setConditionError(null);
  };
  const add = () => {
    if (draft.length >= 3) return;
    setConditionError(null);
    const used = new Set(draft.map((row) => row.period));
    const period =
      (rpsPeriods as readonly number[]).find((value) => !used.has(value)) ??
      rpsPeriods[0];
    // The key advances outside the state updater, so a retried render cannot
    // consume extra keys or reorder existing rows.
    const key = nextDraftKey.current++;
    setDraft([...draft, { key, period, side: "gte", value: "" }]);
  };
  const remove = (key: number) => {
    setDraft((rows) => rows.filter((row) => row.key !== key));
    setConditionError(null);
  };
  const apply = () => {
    if (duplicates.size) {
      setConditionError({
        message: "条件周期不能重复，请修改标记为“周期重复”的行。",
      });
      return;
    }
    const invalid = draft.find((row) => {
      const text = row.value.trim();
      const value = Number(text);
      return (
        !/^\d+$/.test(text) ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > 100
      );
    });
    if (invalid) {
      setConditionError({
        key: invalid.key,
        message: "每条条件需填写 0–100 的整数阈值。",
      });
      return;
    }
    setConditionError(null);
    onApply(
      draft.map((row) => ({
        period: row.period,
        side: row.side,
        value: Number(row.value),
      })),
    );
  };
  const clear = () => {
    setDraft([]);
    setConditionError(null);
    onClear();
  };
  return (
    <div className="w-full space-y-2 rounded-md border border-border/70 p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">
          RPS 条件组合（同时满足，最多 3 条）
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={clear}
            disabled={applied.length === 0 && draft.length === 0}
          >
            清除条件
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={apply}
            disabled={applied.length === 0 && draft.length === 0}
          >
            应用条件
          </Button>
        </div>
      </div>
      {draft.map((row, index) => {
        const duplicate = duplicates.has(row.period);
        const invalid = conditionError?.key === row.key;
        return (
          <div key={row.key} className="flex flex-wrap items-center gap-2">
            <Select
              value={String(row.period)}
              onValueChange={(value) =>
                update(row.key, { period: Number(value) })
              }
            >
              <SelectTrigger
                className="w-36"
                aria-label={`条件${index + 1}周期`}
                aria-invalid={duplicate}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {rpsPeriods.map((period) => (
                  <SelectItem key={period} value={String(period)}>
                    {rpsPeriodLabel(period)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={row.side}
              onValueChange={(value) =>
                update(row.key, {
                  side: value as RpsCondition["side"],
                })
              }
            >
              <SelectTrigger
                className="w-20"
                aria-label={`条件${index + 1}比较`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="gte">≥</SelectItem>
                <SelectItem value="lte">≤</SelectItem>
              </SelectContent>
            </Select>
            <Input
              className="w-24"
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              step={1}
              aria-label={`条件${index + 1}阈值`}
              aria-invalid={duplicate || invalid}
              placeholder="0–100"
              value={row.value}
              onChange={(e) => update(row.key, { value: e.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => remove(row.key)}
            >
              移除
            </Button>
            {duplicate && (
              <span className="text-xs text-destructive">周期重复</span>
            )}
            {invalid && (
              <span className="text-xs text-destructive">0–100 整数</span>
            )}
          </div>
        );
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={add}
        disabled={draft.length >= 3}
      >
        添加条件
      </Button>
      {conditionError && (
        <p role="alert" className="text-sm text-destructive">
          {conditionError.message}
        </p>
      )}
    </div>
  );
}
