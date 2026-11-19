"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { navItemFor, workspaceGroupFor } from "./navigation";
import { Suspense } from "react";
import { cn } from "~/lib/common/classnames";

/** Subpages keep ordinary Next lifecycles; only Scan owns retained editors. */
export function WorkspaceTabs({ workspace }: { workspace: string }) {
  return (
    <Suspense fallback={<p role="status">正在读取工作区标签…</p>}>
      <WorkspaceTabsBody workspace={workspace} />
    </Suspense>
  );
}
function WorkspaceTabsBody({ workspace }: { workspace: string }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const active = navItemFor(pathname, search);
  // A page can be filed under another workspace (e.g. 历史信号 lives in
  // 选股筛选 but renders in the accounts layout); the tab bar follows the
  // page's own workspace, not the layout that happens to host it.
  const group = active
    ? workspaceGroupFor(pathname, search)
    : workspaceGroupFor(workspace);
  return (
    <nav
      aria-label="工作区子页"
      className="mb-4 flex flex-wrap items-center gap-2"
    >
      <span className="mr-1 text-xs text-nc-text-4">{group.label}</span>
      {group.items
        .filter((item) => !item.hidden)
        .map((item) => {
          const selected = active?.href === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              scroll={false}
              aria-current={selected ? "page" : undefined}
              className={cn(
                "rounded-md border px-3 py-2 text-sm",
                selected
                  ? "border-nc-accent-800 bg-nc-accent-900 text-nc-accent"
                  : "border-nc-border bg-nc-card text-nc-text-2 hover:bg-nc-inset",
              )}
            >
              {item.label}
            </Link>
          );
        })}
    </nav>
  );
}
