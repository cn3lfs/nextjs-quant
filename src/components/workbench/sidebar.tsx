"use client";
import { CaretDown, List } from "@phosphor-icons/react/ssr";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "~/lib/common/classnames";
import { navGroups } from "./navigation";
import { Button } from "../ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";

export function Sidebar({
  active,
  badges,
  alerts,
}: {
  active: string | undefined;
  badges: Record<string, { count: number; bad?: boolean }>;
  alerts?: ReactNode;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(navGroups.map((group) => [group.label, true])),
  );
  const [navigationOpen, setNavigationOpen] = useState(false);
  const activeGroup = navGroups.find((group) =>
    group.items.some((item) => item.href === active),
  );
  useEffect(() => {
    if (!activeGroup) return;
    setExpanded((current) => ({ ...current, [activeGroup.label]: true }));
  }, [active, activeGroup]);
  return (
    <TooltipProvider>
      <aside className="sidebar">
        {alerts}
        <Link href="/" className="brand" aria-label="观澜首页">
          <span className="brand-symbol" aria-hidden="true">
            观
          </span>
          <strong>观澜</strong>
        </Link>
        <Dialog open={navigationOpen} onOpenChange={setNavigationOpen}>
          <DialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="sidebar-page-menu mb-2 h-10 w-10 p-0"
              aria-label="展开全部页面导航"
              title="全部页面"
            >
              <List size={20} />
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[85%] sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>全部页面</DialogTitle>
              <DialogDescription>
                按工作流程分组，选择页面后关闭导航。
              </DialogDescription>
            </DialogHeader>
            <nav
              aria-label="全部页面导航"
              className="grid gap-4 sm:grid-cols-2"
            >
              {navGroups.map((group) => (
                <section key={group.label}>
                  <h3 className="mb-1 text-sm font-semibold">{group.label}</h3>
                  <ul className="m-0 list-none p-0">
                    {group.items
                      .filter((item) => !item.hidden)
                      .map((item) => (
                        <li key={item.href}>
                          <Link
                            href={item.href}
                            scroll={false}
                            onClick={() => setNavigationOpen(false)}
                            aria-current={
                              item.href === active ? "page" : undefined
                            }
                            className={cn(
                              "nav-item",
                              item.href === active && "active",
                            )}
                          >
                            <item.icon
                              size={16}
                              aria-hidden="true"
                              className="flex-none"
                            />
                            <span>{item.label}</span>
                            {!!badges[item.href]?.count && (
                              <em
                                className={cn(
                                  "nav-badge not-italic",
                                  badges[item.href]?.bad && "bad",
                                )}
                              >
                                {badges[item.href]?.count}
                              </em>
                            )}
                          </Link>
                        </li>
                      ))}
                  </ul>
                </section>
              ))}
            </nav>
          </DialogContent>
        </Dialog>
        <nav aria-label="工作台导航" className="min-h-0 flex-1 overflow-y-auto">
          {navGroups.map((group, index) => {
            const open = expanded[group.label] ?? group === activeGroup;
            const GroupIcon = group.items[0]!.icon;
            const id = "workbench-nav-" + index;
            return (
              <div key={group.label} className="nav-group">
                <Button
                  variant="plain"
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
                </Button>
                <ul id={id} data-collapsed={!open} className="nav-group-items">
                  {group.items
                    .filter((item) => !item.hidden)
                    .map((item) => {
                      const selected = item.href === active;
                      const badge = badges[item.href];
                      return (
                        <li key={item.href}>
                          <Tooltip>
                            <TooltipTrigger asChild data-slot={undefined}>
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
                            </TooltipTrigger>
                            <TooltipContent side="right">
                              {item.label}
                            </TooltipContent>
                          </Tooltip>
                        </li>
                      );
                    })}
                </ul>
              </div>
            );
          })}
        </nav>
      </aside>
    </TooltipProvider>
  );
}
