"use client";
import type { ReactNode } from "react";
import { cn } from "~/lib/common/classnames";
import { Panel, type PanelProps } from "./panel";

/** `auto-fit minmax(170px,1fr)` field grid. */
export function FormGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("nc-form-grid", className)}>{children}</div>;
}

/** Label above a control; `wide` spans the whole grid row. */
export function FormField({
  label,
  hint,
  wide,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={cn("nc-field", wide && "col-span-full")}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

/**
 * Form panel: field grid, optional checks row and a button group. Business
 * forms keep their own controls and handlers; this only lays them out.
 */
export function FormPanel({
  fields,
  checks,
  buttons,
  children,
  ...panel
}: PanelProps & {
  fields?: ReactNode;
  checks?: ReactNode;
  buttons?: ReactNode;
}) {
  return (
    <Panel {...panel}>
      {fields && <FormGrid>{fields}</FormGrid>}
      {children}
      {checks && <div className="nc-checks">{checks}</div>}
      {buttons && <div className="nc-buttons">{buttons}</div>}
    </Panel>
  );
}
