import type { ReactNode } from "react";
import { cn } from "~/lib/common/classnames";

/**
 * 页面筛选条。桌面端把下拉、分段按钮、搜索框和右侧操作收在同一行；
 * 窄屏按 flex-wrap 换行，单个控件不占满整行。样式见 globals.css。
 */
export function FilterToolbar({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      className={cn("nc-filter-toolbar", className)}
    >
      {children}
    </div>
  );
}

/** 一个语义筛选组：可选标签 + 若干紧邻控件，组内不换行。 */
export function FilterGroup({
  label,
  className,
  children,
}: {
  label?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={typeof label === "string" ? label : undefined}
      className={cn("nc-filter-group", className)}
    >
      {label !== undefined && label !== null && label !== "" && (
        <span className="nc-filter-label">{label}</span>
      )}
      {children}
    </div>
  );
}

/** 筛选条件之间的竖分隔线；不承载语义，读屏跳过。 */
export function FilterDivider() {
  return <span className="nc-filter-divider" aria-hidden="true" />;
}
