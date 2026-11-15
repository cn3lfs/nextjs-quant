"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { navGroups } from "./navigation";

/** Subpages keep ordinary Next lifecycles; only Scan owns retained editors. */
export function WorkspaceTabs({ workspace }: { workspace: string }) {
  const pathname = usePathname();
  const group = navGroups.find((g) => g.items[0]?.href === workspace);
  return (
    <nav aria-label="工作区子页" className="mb-4 flex flex-wrap gap-2">
      {group?.items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          scroll={false}
          aria-current={pathname === item.href ? "page" : undefined}
          className={`rounded-md border px-3 py-2 text-sm ${pathname === item.href ? "bg-nc-accent-900 text-nc-accent" : "bg-nc-card"}`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
