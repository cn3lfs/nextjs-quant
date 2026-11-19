"use client";
import { CaretDown, List, SidebarSimple } from "@phosphor-icons/react/ssr";
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { cn } from "~/lib/common/classnames";
import {
  maxExpandedGroups,
  useWorkbenchUiStore,
} from "~/lib/stores/workbench-ui-store";
import { navGroups, type NavGroup } from "./navigation";
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

type Badge = { count: number; bad?: boolean };

const narrowQuery = "(max-width: 1024px)";
function subscribeNarrow(callback: () => void) {
  const media = window.matchMedia(narrowQuery);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}
/** 1024px 以下沿用既有自动窄轨；SSR 先按宽屏渲染，水合后校正。 */
function useNarrowSidebar() {
  return useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(narrowQuery).matches,
    () => false,
  );
}

function groupBadge(badges: Record<string, Badge>, group: NavGroup) {
  let count = 0;
  let bad = false;
  for (const item of group.items) {
    const badge = badges[item.href];
    if (!badge?.count) continue;
    count += badge.count;
    bad ||= !!badge.bad;
  }
  return count ? { count, bad } : undefined;
}

export function Sidebar({
  active,
  badges,
  alerts,
}: {
  active: string | undefined;
  badges: Record<string, Badge>;
  alerts?: ReactNode;
}) {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [collapsedActive, setCollapsedActive] = useState(false);
  const collapsed = useWorkbenchUiStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useWorkbenchUiStore((state) => state.toggleSidebar);
  const expandedGroups = useWorkbenchUiStore((state) => state.expandedGroups);
  const toggleGroup = useWorkbenchUiStore((state) => state.toggleGroup);
  const narrow = useNarrowSidebar();
  const rail = collapsed || narrow;
  const activeGroup =
    navGroups.find((group) =>
      group.items.some((item) => item.href === active),
    ) ?? navGroups[0]!;
  const manualGroups = expandedGroups.filter(
    (label) => label !== activeGroup.label,
  );
  const openLabels = new Set(manualGroups.slice(-(maxExpandedGroups - 1)));
  const groupBadges = new Map(
    navGroups.map((group) => [group.label, groupBadge(badges, group)]),
  );
  useEffect(() => setCollapsedActive(false), [activeGroup.label]);
  return (
    <TooltipProvider>
      <aside className="sidebar" data-collapsed={rail ? "true" : "false"}>
        {!rail && alerts}
        <div
          className={cn(
            "flex items-center gap-1",
            rail && "flex-col justify-center",
          )}
        >
          <Link
            href="/"
            className={cn("brand min-w-0", !rail && "flex-1")}
            aria-label="观澜首页"
          >
            <span className="brand-symbol" aria-hidden="true">
              观
            </span>
            {!rail && <strong>观澜</strong>}
          </Link>
          {!narrow && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="plain"
                  className="h-8 w-8 flex-none rounded-md p-0 text-nc-text-4 hover:bg-nc-inset"
                  aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
                  aria-pressed={collapsed}
                  onClick={toggleSidebar}
                >
                  <SidebarSimple size={18} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">
                {collapsed ? "展开侧栏" : "收起侧栏"} · Ctrl+B
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <Dialog open={navigationOpen} onOpenChange={setNavigationOpen}>
          <DialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="sidebar-page-menu"
              aria-label="展开全部页面导航"
              title="全部页面"
            >
              <List size={20} />
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[85%] lg:max-w-4xl">
            <DialogHeader>
              <DialogTitle>全部页面</DialogTitle>
              <DialogDescription>
                7 个一级工作区及其全部子页；选择页面后关闭导航。
              </DialogDescription>
            </DialogHeader>
            <nav
              aria-label="全部页面导航"
              className="grid gap-5 lg:grid-cols-3"
            >
              {navGroups.map((group) => (
                <section key={group.label}>
                  <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold">
                    <group.icon size={16} aria-hidden="true" />
                    {group.label}
                  </h3>
                  <p className="m-0 mb-2 text-xs text-nc-text-4">
                    {group.subtitle}
                  </p>
                  <ul className="m-0 list-none p-0">
                    {group.items
                      .filter((item) => !item.hidden)
                      .map((item) => {
                        const badge = badges[item.href];
                        return (
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
                              {!!badge?.count && (
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
                </section>
              ))}
            </nav>
          </DialogContent>
        </Dialog>
        <nav aria-label="工作台导航" className="min-h-0 flex-1 overflow-y-auto">
          {rail
            ? navGroups.map((group) => {
                const entry = group.items[0]!;
                const badge = groupBadges.get(group.label);
                const selected = group.label === activeGroup.label;
                return (
                  <Tooltip key={group.label}>
                    <TooltipTrigger asChild>
                      <Link
                        href={entry.href}
                        scroll={false}
                        aria-label={
                          badge?.count
                            ? `${group.label}（${badge.count}）`
                            : group.label
                        }
                        aria-current={selected ? "page" : undefined}
                        className={cn(
                          "nav-item relative justify-center",
                          selected && "active",
                        )}
                      >
                        <group.icon size={20} aria-hidden="true" />
                        {!!badge?.count && (
                          <i
                            aria-hidden="true"
                            className={cn(
                              "absolute top-1.5 right-1.5 size-1.5 rounded-full",
                              badge.bad ? "bg-nc-bad" : "bg-nc-accent",
                            )}
                          />
                        )}
                      </Link>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      {group.label}
                      {badge?.count ? ` · ${badge.count} 条待处理` : ""}
                    </TooltipContent>
                  </Tooltip>
                );
              })
            : navGroups.map((group) => {
                const isActiveGroup = group.label === activeGroup.label;
                const open = isActiveGroup
                  ? !collapsedActive
                  : openLabels.has(group.label);
                const badge = groupBadges.get(group.label);
                return (
                  <section key={group.label} className="nav-group">
                    <Button
                      variant="plain"
                      className={cn(
                        "nav-group-toggle",
                        isActiveGroup && "active",
                      )}
                      aria-expanded={open}
                      onClick={() => {
                        if (isActiveGroup) {
                          setCollapsedActive((value) => !value);
                        } else {
                          toggleGroup(group.label);
                        }
                      }}
                    >
                      <group.icon size={18} aria-hidden="true" />
                      <span className="min-w-0 truncate">{group.label}</span>
                      <span className="ml-auto flex items-center gap-1">
                        {!!badge?.count && (
                          <em
                            className={cn(
                              "nav-badge not-italic",
                              badge.bad && "bad",
                            )}
                          >
                            {badge.count}
                          </em>
                        )}
                        <CaretDown
                          size={14}
                          aria-hidden="true"
                          className={cn("nav-caret", !open && "closed")}
                        />
                      </span>
                    </Button>
                    <ul
                      className="nav-group-items"
                      data-collapsed={open ? "false" : "true"}
                    >
                      {group.items
                        .filter((item) => !item.hidden)
                        .map((item) => {
                          const itemBadge = badges[item.href];
                          return (
                            <li key={item.href}>
                              <Link
                                href={item.href}
                                scroll={false}
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
                                {!!itemBadge?.count && (
                                  <em
                                    className={cn(
                                      "nav-badge not-italic",
                                      itemBadge.bad && "bad",
                                    )}
                                  >
                                    {itemBadge.count}
                                  </em>
                                )}
                              </Link>
                            </li>
                          );
                        })}
                    </ul>
                  </section>
                );
              })}
        </nav>
      </aside>
    </TooltipProvider>
  );
}
