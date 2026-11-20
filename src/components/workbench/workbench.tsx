"use client";
import {
  ArrowsInSimple,
  Pulse as Activity,
  X,
} from "@phosphor-icons/react/ssr";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "../ui/button";
import {
  hydrateWorkbenchUi,
  syncWorkspaceUiPreferences,
  useWorkbenchUiStore,
} from "~/lib/stores/workbench-ui-store";
import { api } from "~/trpc/react";
import { navItemFor, workspaceHrefs } from "./navigation";
import { PanelCache } from "./keep-alive";
import { retainedPanels } from "./retained-routes";
import { WorkbenchSidebar } from "./workbench-sidebar";
import { Topbar } from "./topbar";
import { CommandPalette } from "./command-palette";
import { ShortcutHelpDialog } from "./shortcut-help-dialog";
import { useWorkbenchState } from "./use-workbench-state";
import { WorkbenchNotifyProvider } from "./workbench-notify";
import { ChartNavigationProvider } from "../market/open-chart";
import {
  BinanceHistoryNotice,
  isBinanceNoticeRoute,
} from "../common/binance-history-notice";

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    !!target.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
    )
  );
}
function hasOpenDialog() {
  return !!document.querySelector('[role="dialog"][data-state="open"]');
}

export function Workbench({ children }: { children?: ReactNode }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const { client } = api.useUtils();
  const item = navItemFor(pathname, search.toString());
  const { toast, setToast, notify } = useWorkbenchState();
  const [commandOpen, setCommandOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const zenMode = useWorkbenchUiStore((state) => state.zenMode);
  const setZenMode = useWorkbenchUiStore((state) => state.setZenMode);
  const toggleZen = useWorkbenchUiStore((state) => state.toggleZen);
  const singleKeyShortcuts = useWorkbenchUiStore(
    (state) => state.singleKeyShortcuts,
  );
  const toggleSidebar = useWorkbenchUiStore((state) => state.toggleSidebar);

  useLayoutEffect(() => {
    hydrateWorkbenchUi();
    const root = document.documentElement;
    root.dataset.density = useWorkbenchUiStore.getState().density;
    const unsubscribe = useWorkbenchUiStore.subscribe((next, previous) => {
      if (next.density !== previous.density)
        root.dataset.density = next.density;
    });
    return () => {
      unsubscribe();
      delete root.dataset.density;
    };
  }, []);
  useEffect(
    () =>
      syncWorkspaceUiPreferences(
        (signal) => client.workspacePreferences.query(undefined, { signal }),
        (patch) => client.saveWorkspacePreferences.mutate(patch),
      ),
    [client],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 中文输入法组合态下的按键属于候选词选择，不触发全局快捷键。
      if (event.isComposing || event.keyCode === 229) return;
      const key = event.key;
      const lower = key.toLowerCase();
      const mod = event.ctrlKey || event.metaKey;
      if (mod && (lower === "k" || (event.shiftKey && lower === "p"))) {
        event.preventDefault();
        setHelpOpen(false);
        setCommandOpen(true);
        return;
      }
      if (mod && !event.shiftKey && !event.altKey && lower === "b") {
        event.preventDefault();
        toggleSidebar();
        return;
      }
      if (isEditableTarget(event.target)) return;
      // 浮层打开时，单键与工作区跳转留给浮层自身处理。
      if (hasOpenDialog()) return;
      if (key === "?" && singleKeyShortcuts) {
        event.preventDefault();
        setHelpOpen(true);
        return;
      }
      if (event.shiftKey && !mod && !event.altKey && lower === "f") {
        event.preventDefault();
        toggleZen();
        return;
      }
      const digit = /^Digit([1-7])$/.exec(event.code);
      if (event.altKey && !mod && !event.shiftKey && digit) {
        const href = workspaceHrefs[Number(digit[1]) - 1];
        if (href) {
          event.preventDefault();
          router.push(href, { scroll: false });
        }
        return;
      }
      if (
        key === "Escape" &&
        useWorkbenchUiStore.getState().zenMode &&
        !hasOpenDialog()
      ) {
        setZenMode(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, setZenMode, singleKeyShortcuts, toggleSidebar, toggleZen]);

  return (
    <div className="app-shell" data-zen={zenMode ? "true" : undefined}>
      {!zenMode && <WorkbenchSidebar active={item?.href} />}
      <main className="main">
        {zenMode ? (
          <header className="topbar">
            <div className="topbar-title">
              <h1>{item?.title ?? item?.label ?? "专注模式"}</h1>
            </div>
            <div className="top-status">
              <span className="text-xs text-nc-text-4">
                专注模式 · Esc 退出
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setZenMode(false)}
              >
                <ArrowsInSimple size={15} aria-hidden="true" />
                退出专注
              </Button>
            </div>
          </header>
        ) : (
          <Topbar
            onOpenCommand={() => {
              setHelpOpen(false);
              setCommandOpen(true);
            }}
            onOpenHelp={() => {
              setCommandOpen(false);
              setHelpOpen(true);
            }}
          />
        )}
        <div className="page">
          {isBinanceNoticeRoute(pathname, search.get("tab")) && (
            <BinanceHistoryNotice />
          )}
          <WorkbenchNotifyProvider value={notify}>
            <ChartNavigationProvider>
              <PanelCache active={pathname} panels={retainedPanels} />
              {!(pathname in retainedPanels) && children}
            </ChartNavigationProvider>
          </WorkbenchNotifyProvider>
        </div>
      </main>
      <CommandPalette
        open={commandOpen}
        onOpenChange={setCommandOpen}
        onOpenHelp={() => {
          setCommandOpen(false);
          setHelpOpen(true);
        }}
      />
      <ShortcutHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
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
