"use client";
import { usePathname } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { Workbench } from "./workbench";
import { navItemFor } from "./navigation";

export function WorkbenchLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (!navItemFor(pathname)) return children;
  return (
    <Suspense
      fallback={
        <div className="app-shell">
          <main className="main">
            <div className="page">{children}</div>
          </main>
        </div>
      }
    >
      <Workbench>{children}</Workbench>
    </Suspense>
  );
}
