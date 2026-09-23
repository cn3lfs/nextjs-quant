"use client";
import { usePathname } from "next/navigation";
import { type ReactNode } from "react";
import { Workbench } from "./workbench";
import { navItemFor } from "./navigation";

export function WorkbenchLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (!navItemFor(pathname)) return children;
  return <Workbench>{children}</Workbench>;
}
