"use client";
import {
  ArrowDown,
  ArrowElbowDownLeft,
  ArrowUp,
  MagnifyingGlass,
} from "@phosphor-icons/react/ssr";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { chartSymbolHref } from "~/lib/chart/chart-symbol";
import { cn } from "~/lib/common/classnames";
import { useWorkbenchUiStore } from "~/lib/stores/workbench-ui-store";
import { api } from "~/trpc/react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { navItems, searchNav } from "./navigation";

type PaletteSection = "工作区与页面" | "快捷动作" | "本机标的";
type PaletteItem = {
  id: string;
  group: PaletteSection;
  label: string;
  detail?: string;
  keywords: string;
  run: (alternate: boolean) => void;
};

/**
 * 三段式命令面板：页面、动作、本机标的。
 * `>` 只搜动作，`@` 只搜本机标的；标的结果来自本机已扫描目录，不伪造。
 */
export function CommandPalette({
  open,
  onOpenChange,
  onOpenHelp,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenHelp: () => void;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [debouncedTerm, setDebouncedTerm] = useState("");
  const density = useWorkbenchUiStore((state) => state.density);
  const toggleDensity = useWorkbenchUiStore((state) => state.toggleDensity);
  const sidebarCollapsed = useWorkbenchUiStore(
    (state) => state.sidebarCollapsed,
  );
  const toggleSidebar = useWorkbenchUiStore((state) => state.toggleSidebar);
  const zenMode = useWorkbenchUiStore((state) => state.zenMode);
  const toggleZen = useWorkbenchUiStore((state) => state.toggleZen);
  const singleKeyShortcuts = useWorkbenchUiStore(
    (state) => state.singleKeyShortcuts,
  );
  const setSingleKeyShortcuts = useWorkbenchUiStore(
    (state) => state.setSingleKeyShortcuts,
  );

  const raw = query.trim();
  const mode = raw.startsWith(">")
    ? "action"
    : raw.startsWith("@")
      ? "security"
      : "all";
  const term = (mode === "all" ? raw : raw.slice(1)).trim();
  const needle = term.toLowerCase();
  const wantsSecurities =
    open && (mode === "security" || (mode === "all" && !!term));
  const searchReady = wantsSecurities && term === debouncedTerm;
  const securities = api.quickSearchSecurities.useQuery(
    { query: debouncedTerm, limit: 6 },
    {
      enabled: searchReady,
      staleTime: 0,
      retry: false,
    },
  );

  useEffect(() => {
    if (!wantsSecurities) return;
    const timer = window.setTimeout(() => setDebouncedTerm(term), 160);
    return () => window.clearTimeout(timer);
  }, [wantsSecurities, term]);

  const changeOpen = (next: boolean) => {
    if (!next) {
      setQuery("");
      setDebouncedTerm("");
      setCursor(0);
    }
    onOpenChange(next);
  };
  const close = () => changeOpen(false);
  const go = (href: string) => {
    close();
    router.push(href, { scroll: false });
  };

  const actions: PaletteItem[] = (() => {
    if (mode === "security") return [];
    const entries: PaletteItem[] = [
      {
        id: "action:density",
        group: "快捷动作",
        label: `切换为${density === "comfort" ? "紧凑" : "舒适"}视图`,
        detail: "视图密度",
        keywords: "密度 舒适 紧凑 视图 density",
        run: () => {
          close();
          toggleDensity();
        },
      },
      {
        id: "action:sidebar",
        group: "快捷动作",
        label: sidebarCollapsed ? "展开侧栏" : "收起侧栏",
        detail: "Ctrl+B",
        keywords: "侧栏 展开 收起 导航 sidebar",
        run: () => {
          close();
          toggleSidebar();
        },
      },
      {
        id: "action:zen",
        group: "快捷动作",
        label: zenMode ? "退出专注模式" : "开启专注模式",
        detail: "Shift+F",
        keywords: "专注 全屏 隐藏 侧栏 zen focus",
        run: () => {
          close();
          toggleZen();
        },
      },
      {
        id: "action:data",
        group: "快捷动作",
        label: "前往数据源设置",
        keywords: "数据源 扫描 设置 data source",
        run: () => go("/system"),
      },
      {
        id: "action:push",
        group: "快捷动作",
        label: "前往信号推送",
        keywords: "推送 飞书 钉钉 微信 telegram discord push",
        run: () => go("/system/push"),
      },
      {
        id: "action:risk",
        group: "快捷动作",
        label: "前往仓位与风控",
        keywords: "分仓 仓位 风控 限额 risk allocation",
        run: () => go("/accounts/risk"),
      },
      {
        id: "action:alerts",
        group: "快捷动作",
        label: "前往提醒与推送诊断",
        keywords: "提醒 推送 通知 诊断 alerts notifications",
        run: () => go("/system/notifications"),
      },
      {
        id: "action:help",
        group: "快捷动作",
        label: "打开快捷键帮助",
        detail: "?",
        keywords: "快捷键 帮助 键盘 help shortcut",
        run: () => {
          close();
          onOpenHelp();
        },
      },
      {
        id: "action:single-key",
        group: "快捷动作",
        label: singleKeyShortcuts ? "关闭单键快捷键" : "启用单键快捷键",
        keywords: "单键 快捷键 开关 键盘 single key",
        run: () => {
          close();
          setSingleKeyShortcuts(!singleKeyShortcuts);
        },
      },
    ];
    return needle
      ? entries.filter(
          (entry) =>
            entry.label.toLowerCase().includes(needle) ||
            entry.keywords.includes(needle),
        )
      : entries;
  })();

  const pages: PaletteItem[] = (() => {
    if (mode === "action" || mode === "security") return [];
    const entries = (needle ? searchNav(needle) : navItems)
      .filter((entry) => !entry.hidden)
      .slice(0, 8)
      .map<PaletteItem>((entry) => ({
        id: `page:${entry.href}`,
        group: "工作区与页面",
        label: entry.label,
        detail: `${entry.group} · ${entry.href}`,
        keywords: `${entry.label} ${entry.group} ${entry.href}`.toLowerCase(),
        run: () => go(entry.href),
      }));
    return entries;
  })();

  const securityItems = (
    searchReady ? (securities.data?.items ?? []) : []
  ).map<PaletteItem>((item) => {
    const href = chartSymbolHref(item.symbol);
    const hasFinancials = item.market === "cn-equity";
    return {
      id: `security:${item.symbol}`,
      group: "本机标的",
      label: `${item.name} ${item.symbol}`,
      detail: hasFinancials ? "回车看盘 · Shift+回车看财务" : "回车看盘",
      keywords: `${item.name} ${item.symbol}`.toLowerCase(),
      run: (alternate) =>
        go(alternate && hasFinancials ? `${href}&view=financial` : href),
    };
  });

  const sections = [
    { label: "工作区与页面" as const, items: pages },
    { label: "快捷动作" as const, items: actions },
    { label: "本机标的" as const, items: securityItems },
  ].filter((section) => section.items.length > 0);
  const flat = sections.flatMap((section) => section.items);
  const selectedIndex = Math.min(cursor, Math.max(flat.length - 1, 0));
  const active = flat[selectedIndex];
  const securityNotice = (() => {
    if (!wantsSecurities) return null;
    if (!searchReady || securities.isPending) return "正在搜索本机标的…";
    if (securities.isError) return "本机标的搜索失败，请稍后重试";
    if (securities.data?.ready === false) {
      return "本机证券目录未就绪，请先在数据源设置执行扫描";
    }
    if (!term) return "输入证券代码、名称或拼音首字母";
    if (!securityItems.length) return "未找到匹配的本机标的";
    return null;
  })();

  useEffect(() => {
    document
      .getElementById(`command-option-${selectedIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, flat.length]);

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        showCloseButton={false}
        className="top-[15vh] max-h-[70vh] translate-y-0 gap-0 overflow-hidden p-0 lg:max-w-[560px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          input.current?.focus();
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>命令面板</DialogTitle>
          <DialogDescription>
            搜索工作区页面、快捷动作或本机标的。
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b border-nc-border-soft px-4 py-3">
          <MagnifyingGlass
            size={18}
            aria-hidden="true"
            className="flex-none text-nc-text-4"
          />
          <Input
            ref={input}
            role="combobox"
            aria-label="搜索页面、快捷动作或本机标的"
            aria-autocomplete="list"
            aria-expanded={flat.length > 0}
            aria-controls="command-palette-results"
            aria-activedescendant={
              active ? `command-option-${selectedIndex}` : undefined
            }
            className="h-8 border-0 bg-transparent px-0 text-[14px] shadow-none focus-visible:ring-0"
            placeholder="搜索页面、> 动作、@ 本机标的"
            autoComplete="off"
            maxLength={100}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            onKeyDown={(event) => {
              // 中文输入法组合态下，方向键与回车属于候选词选择。
              if (
                event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229
              )
                return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setCursor(
                  Math.min(selectedIndex + 1, Math.max(flat.length - 1, 0)),
                );
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setCursor(Math.max(selectedIndex - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                active?.run(event.shiftKey);
              }
            }}
          />
          <kbd className="flex-none rounded border border-nc-border px-1 text-[10px] text-nc-text-4">
            Esc
          </kbd>
        </div>
        <div
          id="command-palette-results"
          role="listbox"
          aria-label="命令结果"
          className="max-h-[52vh] overflow-y-auto px-2 py-1"
        >
          {sections.map((section) => (
            <section key={section.label} aria-label={section.label}>
              <h3 className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-nc-text-4">
                {section.label}
              </h3>
              <ul className="m-0 list-none p-0">
                {section.items.map((item) => {
                  const index = flat.indexOf(item);
                  const selected = index === selectedIndex;
                  return (
                    <li key={item.id}>
                      <Button
                        id={`command-option-${index}`}
                        variant="plain"
                        role="option"
                        aria-selected={selected}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm",
                          selected
                            ? "bg-nc-accent-900 text-nc-accent"
                            : "text-nc-text-2 hover:bg-nc-inset",
                        )}
                        onMouseEnter={() => setCursor(index)}
                        onClick={() => item.run(false)}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {item.label}
                        </span>
                        {item.detail && (
                          <small className="max-w-[55%] truncate text-xs text-nc-text-4">
                            {item.detail}
                          </small>
                        )}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {flat.length === 0 && !securityNotice && (
            <p role="status" className="px-3 py-6 text-sm text-nc-text-4">
              没有匹配的命令
            </p>
          )}
          {securityNotice && (
            <p role="status" className="px-3 py-2 text-xs text-nc-warn">
              {securityNotice}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-nc-border-soft px-4 py-2 text-[11px] text-nc-text-4">
          <span className="inline-flex items-center gap-1">
            <ArrowUp size={12} aria-hidden="true" />
            <ArrowDown size={12} aria-hidden="true" />
            选择
          </span>
          <span className="inline-flex items-center gap-1">
            <ArrowElbowDownLeft size={12} aria-hidden="true" />
            打开
          </span>
          <span>Shift+回车 看财务</span>
          <span>&gt; 只搜动作</span>
          <span>@ 只搜本机标的</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
