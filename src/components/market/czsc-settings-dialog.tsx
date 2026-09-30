"use client";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
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
  czscOptionNotes,
  czscStrokeSample,
  type CzscConfigOption,
} from "~/lib/chart/czsc-settings";
import { useCzscSettings } from "~/lib/stores/czsc-settings-store";
import { api } from "~/trpc/react";

// Config-code places fed by the dialog; place 100 (center unit) is the two family toggles.
const structureFields = [
  { place: 1, field: "stroke", title: "笔算法" },
  { place: 10, field: "strokeEnd", title: "笔端点" },
  { place: 1000, field: "segment", title: "线段算法" },
  { place: 10000, field: "segmentEnd", title: "线段分界点" },
] as const;

const optionLabel = (o: CzscConfigOption) =>
  o.original ? `${o.label}（第${o.lessons}课）` : `${o.label}（社区口径）`;

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
  /** Note of the selected choice, shown under the control. */
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

const noteOf = (o: CzscConfigOption): Note => ({
  label: optionLabel(o),
  text: czscOptionNotes[o.key] ?? "",
});

const familyNotes = {
  stroke: [
    {
      label: "笔中枢",
      text: "三笔重叠构成中枢。原文第63课以线段构成中枢，用笔代替是工程降级，适合看更细的结构。",
    },
  ],
  segment: [
    {
      label: "线段中枢",
      text: "三段重叠构成中枢（第63课），结构更粗、更稳定。",
    },
  ],
};

const boxNotes = {
  initial: "只画成枢的最初三笔／三段（第17/18课），与通达信公式输出一致。",
  extended: "框一直画到中枢延伸结束（第18/20课），能看出中枢震荡了多久。",
};

/** TradingView-style "输入" page for the chart's Chan structure indicator. */
export function CzscSettingsDialog() {
  const settings = useCzscSettings();
  // The DLL option table is the single source of rule names and provenance.
  const options = api.czscOptions.useQuery(undefined, {
    staleTime: Infinity,
    retry: false,
  });
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
          线图，跨品种、跨周期共享；研究、监控与信号台账固定使用默认口径（配置 0
          / 1100）。
        </DialogDescription>
        <TooltipProvider>
          <div className="space-y-3">
            <p className="text-xs font-medium text-nc-text-3">结构</p>
            {options.error && (
              <p role="alert" className="text-xs">
                读取配置选项失败：{options.error.message}
              </p>
            )}
            {structureFields.map(({ place, field, title }) => {
              const rows = (options.data ?? []).filter(
                (o) => o.place === place,
              );
              // Boundary display applies to feature-sequence segments only (api v8).
              const off = field === "segmentEnd" && settings.segment !== 1;
              const value = off ? 0 : settings[field];
              const selected = rows.find((o) => o.value === value);
              return (
                <Row
                  key={field}
                  title={title}
                  notes={rows.map(noteOf)}
                  footer={field === "stroke" ? czscStrokeSample : undefined}
                  current={
                    off
                      ? "仅特征序列线段可选；启发式线段固定画在极值笔。"
                      : selected && czscOptionNotes[selected.key]
                  }
                >
                  <Select
                    value={String(value)}
                    disabled={!rows.length || off}
                    onValueChange={(v) => settings.set({ [field]: Number(v) })}
                  >
                    <SelectTrigger aria-label={title} className="w-56">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {rows.map((o) => (
                        <SelectItem key={o.key} value={String(o.value)}>
                          {optionLabel(o)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Row>
              );
            })}
            <p className="text-xs font-medium text-nc-text-3">显示</p>
            <Row title="笔及笔中枢" notes={familyNotes.stroke}>
              <Switch
                aria-label="显示笔及笔中枢"
                checked={settings.showStroke}
                onCheckedChange={(v) => settings.set({ showStroke: v })}
              />
            </Row>
            <Row title="线段及线段中枢" notes={familyNotes.segment}>
              <Switch
                aria-label="显示线段及线段中枢"
                checked={settings.showSegment}
                onCheckedChange={(v) => settings.set({ showSegment: v })}
              />
            </Row>
            <Row
              title="中枢框范围"
              notes={[
                { label: "最初三笔／三段", text: boxNotes.initial },
                { label: "含延伸", text: boxNotes.extended },
              ]}
              footer="只影响绘制，买卖点与信号计算不变。"
              current={boxNotes[settings.box]}
            >
              <Select
                value={settings.box}
                onValueChange={(v) =>
                  settings.set({ box: v as "initial" | "extended" })
                }
              >
                <SelectTrigger aria-label="中枢框范围" className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="initial">
                    最初三笔／三段（第17/18课）
                  </SelectItem>
                  <SelectItem value="extended">含延伸</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            <Button variant="outline" size="sm" onClick={settings.reset}>
              恢复默认
            </Button>
          </div>
        </TooltipProvider>
      </DialogContent>
    </Dialog>
  );
}
