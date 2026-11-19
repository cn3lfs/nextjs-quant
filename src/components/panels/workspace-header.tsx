import type { ReactNode } from "react";
import { cn } from "~/lib/common/classnames";

export type WorkspaceHeaderProps = {
  /** The object the workspace is about (page h1). */
  title: ReactNode;
  /** Workspace or breadcrumb label above the title. */
  eyebrow?: ReactNode;
  /** Scope: universe, period, mode — what the numbers on this page cover. */
  scope?: ReactNode;
  /** Data cut-off, e.g. "数据截至 11-19 15:00". */
  asOf?: ReactNode;
  /** Status chips (Pill, `.nc-status-chip`) shown next to the as-of time. */
  status?: ReactNode;
  /** Exactly one visually primary action. */
  primaryAction?: ReactNode;
  /** Secondary actions: filters, exports, refresh. */
  secondaryActions?: ReactNode;
  className?: string;
};

/**
 * Shared workspace header: object, as-of time, scope and one primary action.
 * Replaces page-level hand-written header divs so every workspace answers
 * "what is this, how fresh is it, what can I do" in the same place.
 */
export function WorkspaceHeader({
  title,
  eyebrow,
  scope,
  asOf,
  status,
  primaryAction,
  secondaryActions,
  className,
}: WorkspaceHeaderProps) {
  return (
    <header
      className={cn(
        "mb-[var(--nc-section-gap)] flex flex-wrap items-end justify-between gap-x-[var(--nc-section-gap)] gap-y-2.5 border-b border-nc-border-soft pb-[var(--nc-card-p)]",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {eyebrow && (
          <span className="text-sub tracking-[0.12em] text-nc-text-4">
            {eyebrow}
          </span>
        )}
        <h1 className="m-0 text-[length:var(--nc-font-size-page)] leading-[var(--nc-line-height-page)] font-semibold text-nc-text">
          {title}
        </h1>
        {scope && (
          <p className="m-0 max-w-[840px] text-sub text-nc-text-3">{scope}</p>
        )}
        {(asOf || status) && (
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sub text-nc-text-4">
            {asOf && (
              <span className="tabular inline-flex items-center gap-1.5 whitespace-nowrap">
                {asOf}
              </span>
            )}
            {status}
          </div>
        )}
      </div>
      {(primaryAction || secondaryActions) && (
        <div className="ml-auto flex flex-wrap items-center gap-2 max-lg:ml-0 max-lg:w-full">
          {secondaryActions}
          {primaryAction}
        </div>
      )}
    </header>
  );
}
