import Link from "next/link";
import type { ReactNode } from "react";
import { formatNumber } from "trading-strategy-core/format-number";
import { cn } from "~/lib/common/classnames";

/**
 * A-share convention: `up` is red, `down` is green. `warn` marks a value that
 * needs attention without claiming direction (e.g. an overdue refresh).
 */
export type MetricTone = "up" | "down" | "neutral" | "warn";

const toneText: Record<MetricTone, string> = {
  up: "text-nc-up",
  down: "text-nc-down",
  warn: "text-nc-warn",
  neutral: "text-nc-text",
};

/** Numbers go through `formatNumber`; strings are already-formatted values. */
export type MetricValue = number | string | null | undefined;

export type MetricCardProps = {
  /** Stable key for `MetricStrip`; not rendered. */
  id?: string;
  label: ReactNode;
  value: MetricValue;
  /** Decimal places for numeric values; ignored for strings. */
  digits?: number;
  /** Unit shown small next to the value. Keep units out of the number. */
  unit?: ReactNode;
  /** Source and scope: where the value comes from and as of when. */
  note?: ReactNode;
  /** Secondary tabular facts (delta, sample size) under the value. */
  meta?: ReactNode;
  tone?: MetricTone;
  /** kpi (28px) for summary rows, compact (18px) for dense side columns. */
  size?: "kpi" | "compact";
  /** Drill-down target; renders the card as a link. */
  href?: string;
  className?: string;
};

/**
 * `null`/`undefined`/non-finite mean "unknown" and render an em dash.
 * A real `0` renders `0.00`. The two must never look the same.
 */
function displayValue(value: MetricValue, digits: number) {
  if (value === null || value === undefined) {
    return { text: "—", missing: true };
  }
  if (typeof value === "number") {
    return {
      text: formatNumber(value, digits),
      missing: !Number.isFinite(value),
    };
  }
  return { text: value, missing: false };
}

/** One high-density quantitative fact with its source and drill-down. */
export function MetricCard({
  label,
  value,
  digits = 2,
  unit,
  note,
  meta,
  tone = "neutral",
  size = "kpi",
  href,
  className,
}: MetricCardProps) {
  const shown = displayValue(value, digits);
  const valueClass = cn(
    "block font-medium tabular [overflow-wrap:anywhere]",
    size === "compact"
      ? "text-[length:var(--nc-font-size-section)] leading-[var(--nc-line-height-section)]"
      : "text-[length:var(--nc-font-size-kpi)] leading-[var(--nc-line-height-kpi)]",
    shown.missing ? "text-nc-text-4" : toneText[tone],
  );
  const body = (
    <>
      <span className="truncate text-sub text-nc-text-3">{label}</span>
      <strong className={valueClass}>
        {shown.text}
        {!shown.missing && unit && (
          <span className="text-sub ml-0.5 font-normal text-nc-text-4">
            {unit}
          </span>
        )}
      </strong>
      {meta && (
        <span className="tabular flex flex-wrap items-center gap-x-2 gap-y-1 text-sub text-nc-text-4">
          {meta}
        </span>
      )}
      {note && (
        <span className="text-sub leading-[1.45] text-nc-text-4">{note}</span>
      )}
    </>
  );
  const cardClass = cn(
    "flex min-w-0 flex-col gap-[3px] rounded-lg border border-nc-border-soft bg-nc-card p-[var(--nc-card-p)] transition-colors",
    href &&
      "hover:border-nc-accent-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-nc-accent",
    className,
  );
  return href ? (
    <Link href={href} className={cardClass}>
      {body}
    </Link>
  ) : (
    <div className={cardClass}>{body}</div>
  );
}

/** Auto-fitting row of metric cards; one row answers "how are we doing". */
export function MetricStrip({
  items,
  className,
}: {
  items: readonly MetricCardProps[];
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid gap-[var(--nc-gap)] [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]",
        className,
      )}
    >
      {items.map(({ id, ...item }, index) => (
        <MetricCard key={id ?? index} {...item} />
      ))}
    </div>
  );
}
