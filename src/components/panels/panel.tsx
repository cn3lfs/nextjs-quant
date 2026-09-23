"use client";
import type { Icon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { cn } from "~/lib/common/classnames";
import { Button } from "../ui/button";
import { toneEdge, toneText, type Tone } from "./tone";

export type Span = 3 | 4 | 5 | 6 | 7 | 8 | 9 | 12;

/** 12-column page grid; below 1240px every panel takes the full row. */
export function PageGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("nc-grid", className)}>{children}</div>;
}

export type PanelProps = {
  title?: ReactNode;
  icon?: Icon;
  /** Small pill after the title. */
  tag?: ReactNode;
  /** Muted text after the title. */
  meta?: ReactNode;
  /** Right side of the title row: segmented control, buttons. */
  actions?: ReactNode;
  /** 11px footnote under the body. */
  note?: ReactNode;
  span?: Span;
  /** accent: highlighted panel (gradient ground, accent edge). */
  tone?: "neutral" | "accent" | "ok" | "warn" | "bad";
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
  "aria-label"?: string;
};

/**
 * Shared panel shell: card ground, hairline edge, 8px radius and the title row
 * (icon · title · tag · meta · actions). Every panel type renders inside it.
 */
export function Panel({
  title,
  icon: TitleIcon,
  tag,
  meta,
  actions,
  note,
  span = 12,
  tone = "neutral",
  className,
  bodyClassName,
  children,
  ...rest
}: PanelProps) {
  return (
    <section
      aria-label={
        rest["aria-label"] ?? (typeof title === "string" ? title : undefined)
      }
      className={cn(
        "nc-panel",
        `nc-span-${span}`,
        tone === "accent" && "nc-panel-accent",
        tone !== "neutral" && tone !== "accent" && toneEdge[tone],
        className,
      )}
    >
      {(title || actions) && (
        <header className="nc-panel-head">
          {TitleIcon && (
            <TitleIcon size={16} className="flex-none text-nc-accent" />
          )}
          {title && <h3>{title}</h3>}
          {tag && <Pill tone="accent">{tag}</Pill>}
          {meta && <span className="nc-panel-meta">{meta}</span>}
          {actions && <div className="nc-panel-actions">{actions}</div>}
        </header>
      )}
      <div className={cn("min-w-0", bodyClassName)}>{children}</div>
      {note && <p className="nc-panel-note">{note}</p>}
    </section>
  );
}

export function Pill({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "nc-pill",
        toneText[tone === "neutral" ? "idle" : tone],
        tone === "neutral" || tone === "idle"
          ? "border-nc-border"
          : tone === "accent"
            ? "border-nc-accent-800 text-nc-accent-light"
            : toneEdge[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export type SegmentOption<T extends string> = { value: T; label: ReactNode };

/** Segmented control from the design: outlined pills, the current one filled. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="nc-segmented">
      {options.map((option) => (
        <Button
          key={option.value}
          variant="plain"
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={cn(option.value === value && "selected")}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

/** Security cell: name (500) over a muted code line. */
export function SecurityCell({
  name,
  code,
  extra,
}: {
  name: ReactNode;
  code?: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-px">
      <strong className="truncate font-medium">{name}</strong>
      {(code || extra) && (
        <span className="truncate text-[10.5px] text-nc-text-4 tabular-nums">
          {code}
          {code && extra && " · "}
          {extra}
        </span>
      )}
    </div>
  );
}

/** Empty or loading body inside a panel. */
export function PanelEmpty({ children }: { children: ReactNode }) {
  return <p className="nc-panel-empty">{children}</p>;
}
