"use client";
import type { ReactNode } from "react";
import { cn } from "~/lib/common/classnames";
import { Panel, type PanelProps } from "./panel";
import { toneEdge, toneText, type Tone } from "./tone";

export type Stat = {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  /** Value color; non-neutral tones also switch the card edge. */
  tone?: Tone;
  key?: string;
};

export function StatCards({ items }: { items: readonly Stat[] }) {
  return (
    <div className="nc-stats">
      {items.map((item, index) => {
        const tone = item.tone ?? "neutral";
        return (
          <div
            key={item.key ?? index}
            className={cn(
              "nc-stat",
              tone !== "neutral" && tone !== "idle" && toneEdge[tone],
            )}
          >
            <span className="nc-stat-label">{item.label}</span>
            <strong className={cn("nc-stat-value", toneText[tone])}>
              {item.value}
            </strong>
            {item.note && <span className="nc-stat-note">{item.note}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** Stats panel: auto-fit metric cards, 17px tabular values. */
export function StatsPanel({
  items,
  children,
  ...panel
}: PanelProps & { items: readonly Stat[] }) {
  return (
    <Panel {...panel}>
      <StatCards items={items} />
      {children}
    </Panel>
  );
}
