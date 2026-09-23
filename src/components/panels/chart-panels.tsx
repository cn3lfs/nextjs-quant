import type { ReactNode } from "react";
import { cn } from "~/lib/common/classnames";
import { Panel, type PanelProps } from "./panel";
import { toneText, type Tone } from "./tone";

export type Quote = {
  name: ReactNode;
  /** Code, board and industry line. */
  code?: ReactNode;
  last?: ReactNode;
  change?: ReactNode;
  tone?: Tone;
  /** OHLC / volume strip. */
  detail?: ReactNode;
};

/**
 * K-line panel: quote header over the repository's own chart component, which
 * is passed as children (lightweight-charts, recolored from tokens).
 */
export function KlinePanel({
  quote,
  foot,
  children,
  ...panel
}: PanelProps & { quote?: Quote; foot?: ReactNode }) {
  return (
    <Panel {...panel}>
      {quote && (
        <div className="nc-quote">
          <div className="flex min-w-0 flex-col">
            <strong className="text-[15px] font-medium">{quote.name}</strong>
            {quote.code && (
              <span className="text-[11px] text-nc-text-4">{quote.code}</span>
            )}
          </div>
          {quote.last !== undefined && (
            <div className="flex flex-col items-end tabular-nums">
              <strong
                className={cn(
                  "text-[22px] leading-tight font-medium",
                  toneText[quote.tone ?? "neutral"],
                )}
              >
                {quote.last}
              </strong>
              {quote.change && (
                <span
                  className={cn(
                    "text-[12px]",
                    toneText[quote.tone ?? "neutral"],
                  )}
                >
                  {quote.change}
                </span>
              )}
            </div>
          )}
          {quote.detail && (
            <div className="basis-full text-[11px] text-nc-text-3 tabular-nums">
              {quote.detail}
            </div>
          )}
        </div>
      )}
      {children}
      {foot && <p className="nc-panel-foot">{foot}</p>}
    </Panel>
  );
}

/** Equity panel: net-value chart (existing chart component) plus a legend foot. */
export function EquityPanel({
  foot,
  children,
  ...panel
}: PanelProps & { foot?: ReactNode }) {
  return (
    <Panel {...panel}>
      {children}
      {foot && <p className="nc-panel-foot">{foot}</p>}
    </Panel>
  );
}
