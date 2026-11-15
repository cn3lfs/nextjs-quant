"use client";
import { Activity, X } from "lucide-react";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Button } from "../ui/button";
import { navItemFor } from "./navigation";
import { PanelCache } from "./keep-alive";
import { retainedPanels } from "./retained-routes";
import { WorkbenchSidebar } from "./workbench-sidebar";
import { Topbar } from "./topbar";
import { useWorkbenchState } from "./use-workbench-state";
import { WorkbenchNotifyProvider } from "./workbench-notify";
import { ChartNavigationProvider } from "../market/open-chart";
import { BinanceHistoryNotice } from "../common/binance-history-notice";

export function Workbench({ children }: { children?: ReactNode }) {
  const pathname = usePathname();
  const { toast, setToast, notify } = useWorkbenchState();
  const item = navItemFor(pathname);
  return (
    <div className="app-shell">
      <WorkbenchSidebar active={item?.href} />
      <main className="main">
        <Topbar
          crumb={item?.group ?? ""}
          title={item?.title ?? item?.label ?? ""}
          subtitle={item?.subtitle}
        />
        <div className="page">
          <BinanceHistoryNotice />
          <WorkbenchNotifyProvider value={notify}>
            <ChartNavigationProvider>
              <PanelCache active={pathname} panels={retainedPanels} />
              {!(pathname in retainedPanels) && children}
            </ChartNavigationProvider>
          </WorkbenchNotifyProvider>
        </div>
      </main>
      {toast && (
        <div role="status" className="toast">
          <Activity size={17} />
          {toast}
          <Button
            variant="plain"
            aria-label="关闭提示"
            onClick={() => setToast("")}
          >
            <X size={15} />
          </Button>
        </div>
      )}
    </div>
  );
}
