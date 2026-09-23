"use client";
import type { ReactNode } from "react";
import { cn } from "~/lib/common/classnames";
import { Panel, PanelEmpty, type PanelProps } from "./panel";

export type Column<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  /** Grid track, e.g. "1.4fr" or "80px". Defaults to 1fr. */
  width?: string;
  align?: "left" | "right";
};

/**
 * Grid table from the design: 10.5px muted header, 12px rows with an inset
 * divider and hover. Scrolls horizontally below `minWidth`.
 */
export function GridTable<T>({
  columns,
  rows,
  rowKey,
  minWidth = 0,
  empty = "暂无记录",
  label,
  onRowClick,
  rowClassName,
}: {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T, index: number) => string;
  minWidth?: number;
  empty?: ReactNode;
  label?: string;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
}) {
  const template = columns
    .map((c) => `minmax(0,${c.width ?? "1fr"})`)
    .join(" ");
  return (
    <div className="nc-table-scroll">
      <div role="table" aria-label={label} style={{ minWidth }}>
        <div
          role="row"
          className="nc-table-head"
          style={{ gridTemplateColumns: template }}
        >
          {columns.map((column) => (
            <span
              key={column.key}
              role="columnheader"
              className={cn(column.align === "right" && "text-right")}
            >
              {column.header}
            </span>
          ))}
        </div>
        {rows.length === 0 ? (
          <PanelEmpty>{empty}</PanelEmpty>
        ) : (
          rows.map((row, index) => (
            <div
              key={rowKey(row, index)}
              role="row"
              className={cn(
                "nc-table-row",
                onRowClick && "cursor-pointer",
                rowClassName?.(row),
              )}
              style={{ gridTemplateColumns: template }}
              onClick={onRowClick && (() => onRowClick(row))}
            >
              {columns.map((column) => (
                <div
                  key={column.key}
                  role="cell"
                  className={cn(
                    "min-w-0",
                    column.align === "right" && "text-right",
                  )}
                >
                  {column.cell(row, index)}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function TablePanel<T>({
  columns,
  rows,
  rowKey,
  minWidth,
  empty,
  onRowClick,
  rowClassName,
  children,
  ...panel
}: PanelProps & {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T, index: number) => string;
  minWidth?: number;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
}) {
  return (
    <Panel {...panel}>
      <GridTable
        columns={columns}
        rows={rows}
        rowKey={rowKey}
        minWidth={minWidth}
        empty={empty}
        onRowClick={onRowClick}
        rowClassName={rowClassName}
        label={typeof panel.title === "string" ? panel.title : undefined}
      />
      {children}
    </Panel>
  );
}
