"use client";
import { usePathname } from "next/navigation";
import { type ReactNode } from "react";
import { Workbench } from "./workbench";
import { routeTabs } from "./workbench/navigation";

export function WorkbenchLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (
    pathname !== "/" &&
    !pathname.startsWith("/reports/") &&
    !routeTabs.some((item) => item.href === pathname)
  )
    return children;
  return <Workbench>{children}</Workbench>;
}
