"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { navGroups } from "./navigation";
import { Suspense } from "react";

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
  const search = useSearchParams();
  const active = (href: string) => {
    const url = new URL(href, "http://workspace");
    return (
      pathname === url.pathname &&
      (url.searchParams.get("tab") ?? "") === (search.get("tab") ?? "")
    );
  };
  const group = navGroups.find((g) => g.items[0]?.href === workspace);
  return (
    <nav aria-label="工作区子页" className="mb-4 flex flex-wrap gap-2">
      {group?.items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          scroll={false}
          aria-current={active(item.href) ? "page" : undefined}
          className={`rounded-md border px-3 py-2 text-sm ${active(item.href) ? "bg-nc-accent-900 text-nc-accent" : "bg-nc-card"}`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
