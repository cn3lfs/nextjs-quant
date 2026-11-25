"use client";

import { useState } from "react";
import { patternBreakoutKinds } from "trading-strategies";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  breakoutChartSettingsSchema,
  defaultBreakoutChartSettings,
  defaultPatternBreakoutChartSettings,
  patternBreakoutChartSettingsSchema,
  patternBreakoutKindLabels,
} from "~/lib/chart/overlay-settings";
import { useOverlaySettings } from "~/lib/stores/overlay-settings-store";

const directionOptions = [
  { value: "both", label: "双向" },
  { value: "long", label: "仅向上" },
  { value: "short", label: "仅向下" },
] as const;

type BreakoutNumberKey =
  "volumeRatioThreshold" | "minIndicatorVotes" | "minScore" | "minTouches";

const breakoutNumberFields: {
  key: BreakoutNumberKey;
  label: string;
  min: number;
  max: number;
  step: number;
  hint: string;
}[] = [
  {
    key: "volumeRatioThreshold",
    label: "放量倍数",
    min: 0.5,
    max: 10,
    step: 0.1,
    hint: "0.5–10",
  },
  {
    key: "minIndicatorVotes",
    label: "指标共振",
    min: 0,
    max: 4,
    step: 1,
    hint: "0–4 整数",
  },
  {
    key: "minScore",
    label: "最低评分",
    min: 0,
    max: 5,
    step: 1,
    hint: "0–5 整数",
  },
  {
    key: "minTouches",
    label: "最少触点",
    min: 2,
    max: 10,
    step: 1,
    hint: "2–10 整数",
  },
];

const breakoutDraft = (
  settings: typeof defaultBreakoutChartSettings,
): Record<BreakoutNumberKey, string> => ({
  volumeRatioThreshold: String(settings.volumeRatioThreshold),
  minIndicatorVotes: String(settings.minIndicatorVotes),
  minScore: String(settings.minScore),
  minTouches: String(settings.minTouches),
});

const numberError = (
  fields: readonly { label: string; hint: string }[],
): string => fields.map((f) => `${f.label} ${f.hint}`).join("，");

const draftNumber = (raw: string) =>
  raw.trim() === "" ? Number.NaN : Number(raw);

/** Inline editor for 双突破 overlays: valid edits apply immediately; invalid
 *  drafts stay local until corrected, like the indicator parameter panel. */
export function BreakoutParameterPanel({ onClose }: { onClose: () => void }) {
  const { breakout, setBreakout, resetBreakout } = useOverlaySettings();
  const [draft, setDraft] = useState(() => breakoutDraft(breakout));
  const isDisabled = (key: BreakoutNumberKey) =>
    key === "minTouches" && breakout.trendMode === "ma20";
  const invalidFields = breakoutNumberFields.filter(
    ({ key }) =>
      !isDisabled(key) &&
      !breakoutChartSettingsSchema.shape[key].safeParse(draftNumber(draft[key]))
        .success,
  );
  const applyNumber = (key: BreakoutNumberKey, raw: string) => {
    setDraft((current) => ({ ...current, [key]: raw }));
    const parsed = breakoutChartSettingsSchema.shape[key].safeParse(
      draftNumber(raw),
    );
    if (parsed.success) setBreakout({ [key]: parsed.data });
  };
  const reset = () => {
    resetBreakout();
    setDraft(breakoutDraft(defaultBreakoutChartSettings));
  };
  return (
    <div
      role="dialog"
      aria-label="双突破 参数"
      className="flex flex-wrap items-center gap-3 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <strong>双突破 · 趋势线与关键位</strong>
      <label className="flex items-center gap-1">
        趋势基准
        <Select
          value={breakout.trendMode}
          onValueChange={(value) =>
            setBreakout({
              trendMode: value as typeof breakout.trendMode,
            })
          }
        >
          <SelectTrigger
            aria-label="双突破 参数 趋势基准"
            className="h-7 w-40"
            autoFocus
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="trendline-or-ma20">
              趋势线（无则MA20）
            </SelectItem>
            <SelectItem value="trendline">仅趋势线</SelectItem>
            <SelectItem value="ma20">MA20替代</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <label className="flex items-center gap-1">
        关键位口径
        <Select
          value={breakout.levelMode}
          onValueChange={(value) =>
            setBreakout({ levelMode: value as typeof breakout.levelMode })
          }
        >
          <SelectTrigger
            aria-label="双突破 参数 关键位口径"
            className="h-7 w-32"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="structural">近期压力/支撑位</SelectItem>
            <SelectItem value="all">全部关键位</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <label className="flex items-center gap-1">
        方向
        <Select
          value={breakout.direction}
          onValueChange={(value) =>
            setBreakout({ direction: value as typeof breakout.direction })
          }
        >
          <SelectTrigger aria-label="双突破 参数 方向" className="h-7 w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {directionOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      {breakoutNumberFields.map((field) => (
        <label key={field.key} className="flex items-center gap-1">
          {field.label}
          <Input
            aria-label={`双突破 参数 ${field.label}`}
            aria-invalid={invalidFields.includes(field)}
            type="number"
            className="h-7 w-16"
            min={field.min}
            max={field.max}
            step={field.step}
            value={draft[field.key]}
            disabled={isDisabled(field.key)}
            onChange={(event) => applyNumber(field.key, event.target.value)}
          />
        </label>
      ))}
      <label className="flex items-center gap-1">
        <Checkbox
          aria-label="双突破 参数 要求实体K线"
          checked={breakout.requireLargeBody}
          onCheckedChange={(checked) =>
            setBreakout({ requireLargeBody: checked === true })
          }
        />
        要求实体K线
      </label>
      <Button variant="plain" size="sm" onClick={reset}>
        恢复默认
      </Button>
      <Button variant="plain" size="sm" onClick={onClose}>
        完成
      </Button>
      <span role="status" className="text-destructive">
        {numberError(invalidFields)}
      </span>
      <span className="opacity-60">
        仅作用于看盘图表，不影响监控、回测与信号台账默认口径
      </span>
    </div>
  );
}

const patternNumberFields = [
  {
    key: "minVolumeRatio",
    label: "最小放量倍数",
    min: 0,
    max: 10,
    step: 0.1,
    hint: "0–10",
  },
  {
    key: "minScore",
    label: "最低评分",
    min: 1,
    max: 5,
    step: 1,
    hint: "1–5 整数",
  },
] as const;

/** Inline editor for 形态突破 overlays, sharing the same immediate-apply
 *  semantics as the 双突破 panel. */
export function PatternBreakoutParameterPanel({
  onClose,
}: {
  onClose: () => void;
}) {
  const { patternBreakout, setPatternBreakout, resetPatternBreakout } =
    useOverlaySettings();
  const [draft, setDraft] = useState(() => ({
    minVolumeRatio: String(patternBreakout.minVolumeRatio),
    minScore: String(patternBreakout.minScore),
  }));
  const [kindsHint, setKindsHint] = useState("");
  const invalidFields = patternNumberFields.filter(
    ({ key }) =>
      !patternBreakoutChartSettingsSchema.shape[key].safeParse(
        draftNumber(draft[key]),
      ).success,
  );
  const applyNumber = (key: "minVolumeRatio" | "minScore", raw: string) => {
    setDraft((current) => ({ ...current, [key]: raw }));
    const parsed = patternBreakoutChartSettingsSchema.shape[key].safeParse(
      draftNumber(raw),
    );
    if (parsed.success) setPatternBreakout({ [key]: parsed.data });
  };
  const toggleKind = (kind: (typeof patternBreakoutKinds)[number]) => {
    const checked = patternBreakout.kinds.includes(kind);
    if (checked && patternBreakout.kinds.length === 1) {
      setKindsHint("至少保留一种形态");
      return;
    }
    setKindsHint("");
    const next = new Set(patternBreakout.kinds);
    if (checked) next.delete(kind);
    else next.add(kind);
    // Keep the canonical catalog order so persisted settings stay stable.
    setPatternBreakout({
      kinds: patternBreakoutKinds.filter((item) => next.has(item)),
    });
  };
  const reset = () => {
    resetPatternBreakout();
    setDraft({
      minVolumeRatio: String(
        defaultPatternBreakoutChartSettings.minVolumeRatio,
      ),
      minScore: String(defaultPatternBreakoutChartSettings.minScore),
    });
    setKindsHint("");
  };
  return (
    <div
      role="dialog"
      aria-label="形态突破 参数"
      className="flex flex-wrap items-center gap-3 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <strong>形态突破 · 头肩/箱体/三角形/楔形</strong>
      <div
        role="group"
        aria-label="形态类型"
        className="flex flex-wrap items-center gap-2"
      >
        <span>形态类型</span>
        {patternBreakoutKinds.map((kind, index) => (
          <label key={kind} className="flex items-center gap-1">
            <Checkbox
              aria-label={`形态类型 ${patternBreakoutKindLabels[kind]}`}
              checked={patternBreakout.kinds.includes(kind)}
              autoFocus={index === 0}
              onCheckedChange={() => toggleKind(kind)}
            />
            {patternBreakoutKindLabels[kind]}
          </label>
        ))}
      </div>
      <label className="flex items-center gap-1">
        方向
        <Select
          value={patternBreakout.direction}
          onValueChange={(value) =>
            setPatternBreakout({
              direction: value as typeof patternBreakout.direction,
            })
          }
        >
          <SelectTrigger aria-label="形态突破 参数 方向" className="h-7 w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {directionOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      {patternNumberFields.map((field) => (
        <label key={field.key} className="flex items-center gap-1">
          {field.label}
          <Input
            aria-label={`形态突破 参数 ${field.label}`}
            aria-invalid={invalidFields.includes(field)}
            type="number"
            className="h-7 w-16"
            min={field.min}
            max={field.max}
            step={field.step}
            value={draft[field.key]}
            onChange={(event) => applyNumber(field.key, event.target.value)}
          />
        </label>
      ))}
      <label className="flex items-center gap-1">
        <Checkbox
          aria-label="显示全部历史轨道线"
          checked={patternBreakout.showAllGeometry}
          onCheckedChange={(checked) =>
            setPatternBreakout({ showAllGeometry: checked === true })
          }
        />
        显示全部历史轨道线
      </label>
      <Button variant="plain" size="sm" onClick={reset}>
        恢复默认
      </Button>
      <Button variant="plain" size="sm" onClick={onClose}>
        完成
      </Button>
      <span role="status" className="text-destructive">
        {[numberError(invalidFields), kindsHint].filter(Boolean).join("，")}
      </span>
      <span className="opacity-60">
        仅作用于看盘图表，不影响选股与研究默认口径
      </span>
    </div>
  );
}
