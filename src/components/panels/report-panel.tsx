"use client";
import type { ReactNode } from "react";
import { cn } from "~/lib/common/classnames";
import { Panel, Pill, type PanelProps } from "./panel";
import { toneEdge, type Tone } from "./tone";

/** Evidence verdict of one research stage. */
export type StageStatus = "support" | "counter" | "insufficient" | "none";

const stageTone: Record<StageStatus, Tone> = {
  support: "ok",
  counter: "bad",
  insufficient: "warn",
  none: "idle",
};
export const stageLabel: Record<StageStatus, string> = {
  support: "证据支持",
  counter: "存在反证",
  insufficient: "证据不足",
  none: "—",
};

export type Stage = {
  key: string;
  title: ReactNode;
  status: StageStatus;
  /** Override for the pill text. */
  statusLabel?: ReactNode;
  body?: ReactNode;
  note?: ReactNode;
};

export function StageCards({ stages }: { stages: readonly Stage[] }) {
  return (
    <div className="nc-stages">
      {stages.map((stage) => {
        const tone = stageTone[stage.status];
        return (
          <div
            key={stage.key}
            className={cn("nc-stage", tone !== "idle" && toneEdge[tone])}
          >
            <div className="flex items-center gap-2">
              <strong className="text-[12.5px] font-medium">
                {stage.title}
              </strong>
              <Pill tone={tone} className="ml-auto">
                {stage.statusLabel ?? stageLabel[stage.status]}
              </Pill>
            </div>
            {stage.body && (
              <div className="text-[12px] leading-relaxed text-nc-text-2">
                {stage.body}
              </div>
            )}
            {stage.note && (
              <span className="text-[10.5px] text-nc-text-4">{stage.note}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Report panel: conclusion headline, summary and staged evidence cards. */
export function ReportPanel({
  headline,
  summary,
  stages = [],
  children,
  ...panel
}: PanelProps & {
  headline?: ReactNode;
  summary?: ReactNode;
  stages?: readonly Stage[];
}) {
  return (
    <Panel {...panel}>
      {headline && <h4 className="nc-report-headline">{headline}</h4>}
      {summary && <p className="nc-report-summary">{summary}</p>}
      {stages.length > 0 && <StageCards stages={stages} />}
      {children}
    </Panel>
  );
}
