"use client";
import type { Icon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { cn } from "~/lib/common/classnames";
import { Panel, PanelEmpty, Pill, type PanelProps } from "./panel";
import { toneEdge, toneText, type Tone } from "./tone";

export type ListItem = {
  key: string;
  icon?: Icon;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Status pill text. */
  tag?: ReactNode;
  tone?: Tone;
  /** Trailing button(s). */
  action?: ReactNode;
  /** Extra content under the row text (expanded details). */
  children?: ReactNode;
};

/** Row cards: icon · title/subtitle (single line) · status pill · action. */
export function ListRows({
  items,
  empty = "暂无记录",
}: {
  items: readonly ListItem[];
  empty?: ReactNode;
}) {
  if (items.length === 0) return <PanelEmpty>{empty}</PanelEmpty>;
  return (
    <ul className="nc-list">
      {items.map((item) => {
        const tone = item.tone ?? "neutral";
        const ItemIcon = item.icon;
        return (
          <li
            key={item.key}
            className={cn("nc-list-row", tone !== "neutral" && toneEdge[tone])}
          >
            <div className="flex items-start gap-3">
              {ItemIcon && (
                <ItemIcon
                  size={17}
                  className={cn(
                    "mt-px flex-none",
                    toneText[tone === "neutral" ? "accent" : tone],
                  )}
                />
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <div className="flex min-w-0 items-center gap-2">
                  <strong className="truncate text-[12.5px] font-medium">
                    {item.title}
                  </strong>
                  {item.tag && <Pill tone={tone}>{item.tag}</Pill>}
                </div>
                {item.subtitle && (
                  <span className="truncate text-[11.5px] text-nc-text-3">
                    {item.subtitle}
                  </span>
                )}
              </div>
              {item.action && (
                <div className="flex flex-none items-center gap-2">
                  {item.action}
                </div>
              )}
            </div>
            {item.children}
          </li>
        );
      })}
    </ul>
  );
}

export function ListPanel({
  items,
  empty,
  children,
  ...panel
}: PanelProps & { items: readonly ListItem[]; empty?: ReactNode }) {
  return (
    <Panel {...panel}>
      <ListRows items={items} empty={empty} />
      {children}
    </Panel>
  );
}
