import type { ReactNode } from "react";
import { Panel, PanelEmpty, type PanelProps } from "./panel";

export type Bar = {
  key: string;
  name: ReactNode;
  /** Displayed value, e.g. "96" or "46 条". */
  value: ReactNode;
  /** Fill 0–100. */
  pct: number;
};

/** Accent ramp by strength: stronger rows read brighter. */
function fill(pct: number) {
  return pct >= 90
    ? "var(--nc-accent)"
    : pct >= 80
      ? "var(--nc-accent-600)"
      : pct >= 50
        ? "var(--nc-accent-700)"
        : "var(--nc-accent-800)";
}

export function BarRows({
  items,
  empty = "暂无数据",
}: {
  items: readonly Bar[];
  empty?: ReactNode;
}) {
  if (items.length === 0) return <PanelEmpty>{empty}</PanelEmpty>;
  return (
    <div className="flex flex-col">
      {items.map((item) => {
        const pct = Math.max(0, Math.min(100, item.pct));
        return (
          <div key={item.key} className="nc-bar-row">
            <span className="nc-bar-name">{item.name}</span>
            <span className="nc-bar-track">
              <span style={{ width: `${pct}%`, background: fill(pct) }} />
            </span>
            <span className="nc-bar-value">{item.value}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Bars panel: name · 5px progress track · value (RPS, theme heat). */
export function BarsPanel({
  items,
  empty,
  children,
  ...panel
}: PanelProps & { items: readonly Bar[]; empty?: ReactNode }) {
  return (
    <Panel {...panel}>
      <BarRows items={items} empty={empty} />
      {children}
    </Panel>
  );
}
