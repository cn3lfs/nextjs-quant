"use client";
import { Pulse } from "@phosphor-icons/react";
import Link from "next/link";
import { cn } from "~/lib/common/classnames";
import { navGroups } from "./navigation";

/** Grouped one-layer sidebar; `badges` maps a route to a count. */
export function Sidebar({
  active,
  badges,
  model,
}: {
  active: string | undefined;
  badges: Record<string, { count: number; bad?: boolean }>;
  model: string;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-symbol">
          <Pulse size={19} />
        </div>
        <div>
          <strong>观澜</strong>
          <span>QUANT WORKBENCH</span>
        </div>
      </div>
      <nav aria-label="工作台导航" className="min-h-0 flex-1 overflow-y-auto">
        {navGroups.map((group) => (
          <div key={group.label} className="nav-group">
            <div className="nav-label">{group.label}</div>
            <ul className="m-0 flex list-none flex-col gap-[3px] p-0">
              {group.items
                .filter((item) => !item.hidden || item.href === active)
                .map((item) => {
                  const on = item.href === active;
                  const badge = badges[item.href];
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        scroll={false}
                        title={item.label}
                        aria-current={on ? "page" : undefined}
                        className={cn("nav-item", on && "active")}
                      >
                        <item.icon
                          size={16}
                          weight={on ? "fill" : "regular"}
                          className="flex-none"
                        />
                        <span>{item.label}</span>
                        {badge && badge.count > 0 && (
                          <em
                            className={cn(
                              "nav-badge not-italic",
                              badge.bad && "bad",
                            )}
                          >
                            {badge.count}
                          </em>
                        )}
                      </Link>
                    </li>
                  );
                })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div className="local-indicator">
          <i /> 本机研究环境
        </div>
        <p>
          数据留在本地
          <br />
          调度仅在应用运行时执行
        </p>
        <p>{model}</p>
        <span>v0.1 · Windows</span>
      </div>
    </aside>
  );
}
