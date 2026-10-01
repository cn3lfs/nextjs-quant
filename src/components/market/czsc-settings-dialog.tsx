"use client";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import {
  czscBlockingRule,
  czscFieldValue,
  czscStrokeSample,
  type CzscConfigChoice,
  type CzscConfigField,
} from "~/lib/chart/czsc-settings";
import { useCzscSettings } from "~/lib/stores/czsc-settings-store";
import { api } from "~/trpc/react";

/**
 * Fields the chart does not expose: signal publication only changes the live
 * event stream, while the chart draws hindsight signals.
 */
const hiddenFields = new Set(["signals.publication"]);

const choiceLabel = (c: CzscConfigChoice) =>
  c.original
    ? `${c.label}${c.lessons ? `（第${c.lessons}课）` : ""}`
    : `${c.label}（社区口径）`;

/** DLL notes may open with "社区口径：", which the choice label already says. */
const noteText = (c: CzscConfigChoice) =>
  c.note.replace(/^社区口径[:：]\s*/, "");

type Note = { label: string; text: string };

function Row({
  title,
  notes,
  footer,
  current,
  children,
}: {
  title: string;
  /** Every choice of this row, shown in the title tooltip. */
  notes: Note[];
  footer?: string;
  /** Note of the selected choice (or why the row is disabled), under the control. */
  current?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-4 text-sm">
        <span className="flex items-center gap-1">
          {title}
          {notes.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="plain"
                  aria-label={`${title}说明`}
                  className="size-4 rounded-full border text-[10px] leading-none text-nc-text-3"
                >
                  i
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-80 space-y-1">
                {notes.map((n) => (
                  <p key={n.label}>
                    <b>{n.label}</b>：{n.text}
                  </p>
                ))}
                {footer && <p className="opacity-70">{footer}</p>}
              </TooltipContent>
            </Tooltip>
          )}
        </span>
        {children}
      </div>
      {current && <p className="text-xs text-nc-text-3">{current}</p>}
    </div>
  );
}

/** TradingView-style "输入" page, generated from the DLL configuration schema (api v20). */
export function CzscSettingsDialog() {
  const settings = useCzscSettings();
  const schema = api.czscSchema.useQuery(undefined, {
    staleTime: Infinity,
    retry: false,
  });
  const values = settings.values;
  const field = (f: CzscConfigField) => {
    const choices = (schema.data?.choices ?? []).filter(
      (c) => c.field === f.key,
    );
    // A dependency rule disables the row and says why (text from the DLL).
    const rule = schema.data && czscBlockingRule(schema.data, f.key, values);
    const value =
      rule && rule.onlyValue >= 0 ? rule.onlyValue : czscFieldValue(f, values);
    const selected = choices.find((c) => c.value === value);
    return (
      <Row
        key={f.key}
        title={f.label}
        notes={choices.map((c) => ({
          label: choiceLabel(c),
          text: noteText(c),
        }))}
        footer={f.key === "stroke.rule" ? czscStrokeSample : undefined}
        current={rule ? rule.reason : selected && noteText(selected)}
      >
        {f.kind === 1 ? (
          <Input
            aria-label={f.label}
            className="w-56"
            type="number"
            step={0.001}
            min={f.minFloat}
            max={f.maxFloat}
            disabled={!!rule}
            // The DLL reports float32 defaults (0.02 → 0.0199999995…).
            value={Number(value.toPrecision(6))}
            onChange={(e) => {
              const next = Number(e.target.value);
              if (next > f.minFloat && next < f.maxFloat)
                settings.setValue(f.key, next);
            }}
          />
        ) : (
          <Select
            value={String(value)}
            disabled={!choices.length || !!rule}
            onValueChange={(v) => settings.setValue(f.key, Number(v))}
          >
            <SelectTrigger aria-label={f.label} className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map((c) => (
                <SelectItem key={c.key} value={String(c.value)}>
                  {choiceLabel(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Row>
    );
  };
  const visible = (layer: number) =>
    (schema.data?.fields ?? []).filter(
      (f) => f.layer === layer && !hiddenFields.has(f.key),
    );
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" aria-label="缠论设置">
          缠论设置
        </Button>
      </DialogTrigger>
      <DialogContent
        // Focus the dialog itself; auto-focusing the first info icon would pop its tooltip on open.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus();
        }}
      >
        <DialogTitle>缠论结构 · 输入</DialogTitle>
        <DialogDescription>
          只作用于 K
          线图，跨品种、跨周期共享；研究、监控与信号台账固定使用默认口径。
        </DialogDescription>
        <TooltipProvider>
          <div className="space-y-3">
            {schema.error && (
              <p role="alert" className="text-xs">
                读取配置选项失败：{schema.error.message}
              </p>
            )}
            <p className="text-xs font-medium text-nc-text-3">结构</p>
            {visible(0).map(field)}
            <p className="text-xs font-medium text-nc-text-3">显示</p>
            <Row title="笔及笔中枢" notes={[]}>
              <Switch
                aria-label="显示笔及笔中枢"
                checked={settings.showStroke}
                onCheckedChange={(v) => settings.set({ showStroke: v })}
              />
            </Row>
            <Row title="线段及线段中枢" notes={[]}>
              <Switch
                aria-label="显示线段及线段中枢"
                checked={settings.showSegment}
                onCheckedChange={(v) => settings.set({ showSegment: v })}
              />
            </Row>
            {visible(2).map(field)}
            <Button variant="outline" size="sm" onClick={settings.reset}>
              恢复默认
            </Button>
          </div>
        </TooltipProvider>
      </DialogContent>
    </Dialog>
  );
}
