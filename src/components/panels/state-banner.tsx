import {
  ClockCountdown,
  Info,
  Tray,
  Warning,
  XCircle,
} from "@phosphor-icons/react/ssr";
import type { ReactNode } from "react";
import { cn } from "~/lib/common/classnames";
import { Button } from "../ui/button";

/**
 * The five states a workbench surface can report. They are deliberately not
 * just "red/green": stale data is a time problem, empty is a scope problem.
 */
export type BannerState = "info" | "warn" | "error" | "stale" | "empty";

const stateIcon = {
  info: Info,
  warn: Warning,
  error: XCircle,
  stale: ClockCountdown,
  empty: Tray,
} as const;

export type StateBannerAction = {
  label: ReactNode;
  onClick: () => void;
  disabled?: boolean;
};

export type StateBannerProps = {
  state: BannerState;
  /** One short sentence naming the condition. */
  title: ReactNode;
  /** Plain reason: what happened, what it affects, what the next step does. */
  children?: ReactNode;
  /** As-of label, e.g. "数据截至 11-19 15:00". */
  asOf?: ReactNode;
  /** Exactly one primary recovery/retry action. */
  action?: StateBannerAction;
  hideIcon?: boolean;
  className?: string;
};

/**
 * Semantic notice strip for panels and pages. It carries meaning through a
 * 2px left edge, an icon and text on a near-white ground — never a large
 * red or green fill. `data-state` resolves the edge and ground in panels.css.
 */
export function StateBanner({
  state,
  title,
  children,
  asOf,
  action,
  hideIcon = false,
  className,
}: StateBannerProps) {
  const StateIcon = stateIcon[state];
  return (
    <div
      role={state === "error" ? "alert" : "status"}
      data-state={state}
      className={cn(
        "nc-state-banner flex items-start gap-2.5 rounded-lg border border-l-2 border-nc-border-soft py-2.5 pr-3 pl-2.5 text-sub",
        state === "empty" ? "text-nc-text-4" : "text-nc-text-2",
        className,
      )}
    >
      {!hideIcon && (
        <StateIcon size={16} aria-hidden="true" className="mt-px flex-none" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <strong className="font-semibold text-nc-text">{title}</strong>
          {asOf && (
            <span className="tabular whitespace-nowrap text-nc-text-4">
              {asOf}
            </span>
          )}
        </div>
        {children && (
          <div className="text-nc-text-3 [overflow-wrap:anywhere]">
            {children}
          </div>
        )}
      </div>
      {action && (
        <Button
          variant="outline"
          size="sm"
          className="ml-auto flex-none"
          onClick={action.onClick}
          disabled={action.disabled}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}
