import type { ReactNode } from "react";
import { WorkspaceTabs } from "~/components/workbench/workspace-tabs";
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <WorkspaceTabs workspace="/accounts" />
      {children}
    </>
  );
}
