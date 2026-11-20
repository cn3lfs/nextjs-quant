import { capabilities } from "~/lib/common/capabilities";
import { type Icon } from "@phosphor-icons/react";
import {
  Archive,
  ArrowsLeftRight,
  Article,
  BellRinging,
  BookOpen,
  CalendarCheck,
  CalendarDots,
  ChartBar,
  ChartLine,
  ChartPieSlice,
  ClipboardText,
  ClockCounterClockwise,
  Compass,
  CurrencyBtc,
  Database,
  Fire,
  Flask,
  Funnel,
  Gauge,
  GearSix,
  Lightning,
  LinkSimple,
  ListChecks,
  MathOperations,
  Newspaper,
  NotePencil,
  PaperPlaneTilt,
  PiggyBank,
  PlayCircle,
  Receipt,
  ShieldCheck,
  Sparkle,
  Stack,
  Star,
  Swatches,
  TrendUp,
  Trophy,
  Wallet,
} from "@phosphor-icons/react/ssr";

export type Tab =
  | "market"
  | "screen"
  | "backtest"
  | "signals"
  | "reports"
  | "tasks"
  | "settings"
  | "analysis"
  | "news";
export type NavItem = {
  href: string;
  label: string;
  title?: string;
  subtitle: string;
  icon: Icon;
  tab?: Tab;
  hidden?: boolean;
};
/** 一级工作区：7 个直白职责分组，每组只回答一类问题。 */
export type NavGroup = {
  label: string;
  subtitle: string;
  icon: Icon;
  items: readonly NavItem[];
};
export type NavEntry = NavItem & { group: string };

function item(href: string, label: string, icon: Icon, tab?: Tab): NavItem {
  const capability =
    href === "/?tab=intraday"
      ? "intraday"
      : href === "/system/notifications"
        ? "signalMonitor"
        : href === "/accounts/alerts"
          ? "signalLedger"
          : null;
  return {
    href,
    label,
    icon,
    tab,
    subtitle: capability ? capabilities[capability].reason : label,
  };
}

export const navGroups: readonly NavGroup[] = [
  {
    label: "今日交易",
    subtitle: "先看今天该做什么：计划、大盘、涨停情绪与板块位置。",
    icon: Compass,
    items: [
      item("/", "今日计划", Compass),
      item("/?tab=overview", "大盘总览", Gauge),
      item("/scan?tab=sentiment", "涨停与情绪", Fire),
      item("/scan?tab=valuation", "板块估值", ChartBar),
    ],
  },
  {
    label: "行情看盘",
    subtitle: "按市场看盘：A 股、我的自选、数字货币与期货各自独立。",
    icon: ChartLine,
    items: [
      item("/scan", "A 股看盘", ChartLine, "market"),
      item("/scan?tab=watchlist", "我的自选", Star),
      item("/scan?tab=crypto", "数字货币", CurrencyBtc),
      item("/scan?tab=futures", "期货行情", TrendUp),
    ],
  },
  {
    label: "选股筛选",
    subtitle: "把条件变成候选：公式、问财、强势排名、股票池与历史信号。",
    icon: Funnel,
    items: [
      item("/scan?tab=formula", "公式选股", MathOperations, "screen"),
      item("/scan?tab=wencai", "问财选股", Sparkle),
      item("/scan?tab=rps", "强势排名 (RPS)", Trophy),
      item("/scan?tab=pool", "股票池", Stack),
      item("/accounts/alerts", "历史信号", BellRinging),
    ],
  },
  {
    label: "策略回测",
    subtitle: "同口径验证策略：策略库、组合回测、对比与记录。",
    icon: Flask,
    items: [
      item("/lab", "策略库", Flask),
      item("/lab/backtest", "组合回测", PlayCircle, "backtest"),
      item("/lab?tab=catalog", "策略对比", ArrowsLeftRight),
      item("/lab?tab=tasks", "回测记录", ClockCounterClockwise),
    ],
  },
  {
    label: "持仓复盘",
    subtitle: "从持仓到交割单，把每一笔交易解释清楚。",
    icon: Wallet,
    items: [
      item("/accounts", "持仓总览", Wallet),
      item("/accounts?tab=ledger", "手工记账", NotePencil),
      item("/accounts?tab=trades", "成交明细", Receipt),
      item("/accounts/review", "交割单复盘", ClipboardText),
      item("/accounts?tab=attribution", "策略归因", ChartPieSlice),
      item("/accounts?tab=weekly", "周度复盘", CalendarCheck),
      item("/accounts?tab=monthly", "月度复盘", CalendarDots),
      item("/accounts?tab=paper", "本地模拟盘", PiggyBank),
      item("/accounts/risk", "仓位与风控", ShieldCheck),
      item("/accounts/crypto", "币圈模拟盘", CurrencyBtc),
    ],
  },
  {
    label: "资讯研报",
    subtitle: "把快讯、研报与 AI 研判放回持仓上下文。",
    icon: Newspaper,
    items: [
      item("/intel", "快讯与主题", Newspaper, "news"),
      item("/intel?tab=thsdk", "同花顺快讯", Lightning),
      item("/intel?tab=related", "持仓关联资讯", LinkSimple),
      item("/intel/review", "财联社复盘", Article),
      item("/lab/analysis", "AI 研判", Sparkle, "analysis"),
      item("/lab/reports", "研报存档", Archive, "reports"),
    ],
  },
  {
    label: "系统设置",
    subtitle: "数据源、提醒推送与后台任务的运行状态。",
    icon: GearSix,
    items: [
      item("/system", "数据源设置", Database, "settings"),
      item("/system/push", "信号推送", PaperPlaneTilt),
      item("/system/notifications", "提醒与推送", BellRinging, "signals"),
      item("/system/tasks", "后台任务", ListChecks, "tasks"),
      item("/lab/data-guide", "数据说明", BookOpen),
      ...(process.env.NODE_ENV === "development"
        ? [item("/system/ui-gallery", "UI 组件", Swatches)]
        : []),
    ],
  },
];

export const navItems: readonly NavEntry[] = navGroups.flatMap((group) =>
  group.items.map((entry) => ({ ...entry, group: group.label })),
);

/**
 * 已并入其它工作区的旧深链：仍解析导航归属与能力说明，但不再出现在
 * 侧栏、命令面板或工作区入口中。`盘中记录` 已并入「公式选股」。
 */
const legacyRoutes: readonly NavEntry[] = [
  {
    ...item("/?tab=intraday", "盘中记录", NotePencil),
    group: "选股筛选",
    hidden: true,
  },
];

/** 每个工作区的默认落点，供 Alt+1…7 与图标窄轨使用。 */
export const workspaceHrefs: readonly string[] = navGroups.map(
  (group) => group.items[0]!.href,
);

function splitHref(href: string) {
  const index = href.indexOf("?");
  const path = index === -1 ? href : href.slice(0, index);
  const query = index === -1 ? "" : href.slice(index + 1);
  return { path: path || "/", tab: new URLSearchParams(query).get("tab") };
}

function matches(item: NavItem, path: string, tab: string | null) {
  const parsed = splitHref(item.href);
  return parsed.path === path && parsed.tab === tab;
}

export function tabHref(tab: Tab) {
  return navItems.find((entry) => entry.tab === tab)!.href;
}

/**
 * 结合 `?tab=` 精确匹配当前子页；单参数调用仍兼容旧的 `href` 形式
 * （例如 `navItemFor("/?tab=intraday")`）。
 */
export function navItemFor(pathname: string, search?: string) {
  const parsed = splitHref(pathname);
  const tab =
    search === undefined ? parsed.tab : new URLSearchParams(search).get("tab");
  const exact = [...navItems, ...legacyRoutes].find((entry) =>
    matches(entry, parsed.path, tab),
  );
  if (exact) return exact;
  if (parsed.path.startsWith("/lab/reports/")) {
    const reports = navItems.find((entry) => entry.href === "/lab/reports");
    return reports ? { ...reports, title: "研究报告详情" } : undefined;
  }
  return undefined;
}

/** 当前路由所属的一级工作区；`workspace` 是布局传入的路径兜底。 */
export function workspaceGroupFor(href: string, search?: string) {
  const active = navItemFor(href, search);
  return (
    (active
      ? navGroups.find((group) =>
          group.items.some((entry) => entry.href === active.href),
        )
      : undefined) ??
    navGroups.find((group) =>
      group.items.some(
        (entry) => splitHref(entry.href).path === splitHref(href).path,
      ),
    ) ??
    navGroups[0]!
  );
}

export function searchNav(query: string): readonly NavEntry[] {
  const term = query.trim().toLowerCase();
  return term
    ? navItems.filter((entry) =>
        [
          entry.label,
          entry.title ?? "",
          entry.href,
          entry.group,
          entry.subtitle,
        ].some((text) => text.toLowerCase().includes(term)),
      )
    : [];
}
