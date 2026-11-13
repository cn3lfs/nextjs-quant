"use client";
import { CaretDown } from "@phosphor-icons/react/ssr";
import Link from "next/link";
import { useEffect, useState } from "react";
import { cn } from "~/lib/common/classnames";
import { navGroups } from "./navigation";

export function Sidebar({
  active,
  badges,
}: {
  active: string | undefined;
  badges: Record<string, { count: number; bad?: boolean }>;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const activeGroup = navGroups.find((group) =>
    group.items.some((item) => item.href === active),
  );
  useEffect(() => {
    if (!activeGroup) return;
    setExpanded((current) => ({ ...current, [activeGroup.label]: true }));
  }, [active, activeGroup]);
  return (
    <aside className="sidebar">
      <Link href="/" className="brand" aria-label="观澜首页">
        <span className="brand-symbol" aria-hidden="true">
          观
        </span>
        <strong>观澜</strong>
      </Link>
      <nav aria-label="工作台导航" className="min-h-0 flex-1 overflow-y-auto">
        {navGroups.map((group, index) => {
          const open = expanded[group.label] ?? group === activeGroup;
          const GroupIcon = group.items[0]!.icon;
          const id = "workbench-nav-" + index;
          return (
            <div key={group.label} className="nav-group">
              <button
                type="button"
                className={cn(
                  "nav-group-toggle",
                  group === activeGroup && "active",
                )}
                title={group.label}
                aria-expanded={open}
                aria-controls={id}
                onClick={() =>
                  setExpanded((current) => ({
                    ...current,
                    [group.label]: !open,
                  }))
                }
              >
                <GroupIcon size={18} aria-hidden="true" />
                <span>{group.label}</span>
                <CaretDown
                  size={14}
                  className={cn("nav-caret", !open && "closed")}
                />
              </button>
              <ul id={id} hidden={!open} className="nav-group-items">
                {group.items
                  .filter((item) => !item.hidden)
                  .map((item) => {
                    const selected = item.href === active;
                    const badge = badges[item.href];
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          scroll={false}
                          title={item.label}
                          aria-current={selected ? "page" : undefined}
                          className={cn("nav-item", selected && "active")}
                        >
                          <item.icon
                            size={16}
                            aria-hidden="true"
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
          );
        })}
      </nav>
    </aside>
  );
}
