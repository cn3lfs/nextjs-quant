import { capabilities } from "~/lib/common/capabilities";
import { type Icon } from "@phosphor-icons/react";
import {
  Compass,
  ChartLine,
  Flask,
  Wallet,
  Newspaper,
  PlugsConnected,
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
export type NavGroup = { label: string; items: readonly NavItem[] };
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
    label: "今日",
    items: [
      item("/", "今日", Compass),
      item("/?tab=intraday", "盘中预选", Compass),
      item("/?tab=overview", "市场与数据总览", Compass),
    ],
  },
  {
    label: "扫描与图表",
    items: [
      item("/scan", "扫描与图表", ChartLine, "market"),
      item("/scan?tab=pool", "证券池", ChartLine),
      item("/scan?tab=formula", "条件选股", ChartLine, "screen"),
      item("/scan?tab=rps", "RPS 排名与数据管理", ChartLine),
      item("/scan?tab=sentiment", "打板情绪", ChartLine),
      item("/scan?tab=valuation", "板块估值", ChartLine),
      item("/scan?tab=crypto", "数字货币图表", ChartLine),
      item("/scan?tab=futures", "资源期货", ChartLine),
    ],
  },
  {
    label: "策略实验室",
    items: [
      item("/lab", "策略中心", Flask),
      item("/lab/backtest", "策略实验", Flask, "backtest"),
      item("/lab?tab=tasks", "研究任务", Flask),
      item("/lab?tab=catalog", "方法目录与运行比较", Flask),
      item("/lab/analysis", "证据分析", Flask, "analysis"),
      item("/lab/reports", "研究档案", Flask, "reports"),
      item("/lab/data-guide", "研究数据指南", Flask),
    ],
  },
  {
    label: "账户与复盘",
    items: [
      item("/accounts", "统一持仓", Wallet),
      item("/accounts?tab=ledger", "持仓与交易日志", Wallet),
      item("/accounts?tab=trades", "全部成交与来源", Wallet),
      item("/accounts?tab=paper", "纸面账户", Wallet),
      item("/accounts?tab=attribution", "策略归因与衰减", Wallet),
      item("/accounts?tab=monthly", "月度自查", Wallet),
      item("/accounts?tab=weekly", "周复盘与执行质量", Wallet),
      item("/accounts/review", "交割单与交易复盘", Wallet),
      item("/accounts/alerts", "信号台账", Wallet),
      item("/accounts/crypto", "数字货币账户与模拟", Wallet),
    ],
  },
  {
    label: "情报",
    items: [
      item("/intel", "新闻 / 主题", Newspaper, "news"),
      item("/intel?tab=related", "持仓与计划情报", Newspaper),
      item("/intel/review", "财联社复盘", Newspaper),
    ],
  },
  {
    label: "系统",
    items: [
      item("/system", "数据与连接", PlugsConnected, "settings"),
      item("/system/tasks", "任务中心", PlugsConnected, "tasks"),
      item("/system/notifications", "信号与通知", PlugsConnected, "signals"),
      ...(process.env.NODE_ENV === "development"
        ? [item("/system/ui-gallery", "UI 组件", PlugsConnected)]
        : []),
    ],
  },
];
export const navItems = navGroups.flatMap((g) =>
  g.items.map((i) => ({ ...i, group: g.label })),
);
export function tabHref(tab: Tab) {
  return navItems.find((i) => i.tab === tab)!.href;
}
export function navItemFor(pathname: string) {
  return (
    navItems.find((i) => i.href === pathname) ??
    (pathname.startsWith("/lab/reports/")
      ? {
          ...navItems.find((i) => i.href === "/lab/reports")!,
          title: "研究报告详情",
        }
      : undefined)
  );
}
export function searchNav(query: string) {
  const term = query.trim().toLowerCase();
  return term
    ? navItems.filter((i) =>
        [i.label, i.title ?? "", i.href, i.group].some((t) =>
          t.toLowerCase().includes(term),
        ),
      )
    : [];
}
