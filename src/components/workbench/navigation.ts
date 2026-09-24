import {
  Books,
  Mountains,
  CurrencyBtc,
  Broadcast,
  ChartLine,
  Compass,
  Crosshair,
  Flask,
  Funnel,
  Hash,
  ListChecks,
  Newspaper,
  Notebook,
  PlugsConnected,
  Ranking,
  Receipt,
  Sparkle,
  TestTube,
  Wallet,
} from "@phosphor-icons/react/ssr";
import { type Icon } from "@phosphor-icons/react";

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
  /** Topbar title when it differs from the sidebar label. */
  title?: string;
  subtitle: string;
  icon: Icon;
  /** Workbench panel state behind this route, when the page is a former tab. */
  tab?: Tab;
  /** Reachable by link and search, but not listed in the sidebar. */
  hidden?: boolean;
};
export type NavGroup = { label: string; items: readonly NavItem[] };

/**
 * One navigation layer: every page is a route, grouped as in the design
 * handoff. Former tabs keep their panel state through `tab`.
 */
export const navGroups: readonly NavGroup[] = [
  {
    label: "今日",
    items: [
      {
        href: "/",
        label: "今日总览",
        subtitle: "调度窗口、数据健康与下一步",
        icon: Compass,
      },
      {
        href: "/intraday",
        label: "盘中预选",
        subtitle: "午尾盘预选与收盘确认 · 截至时点行情，不覆盖原始记录",
        icon: Crosshair,
      },
      {
        href: "/cls-review",
        label: "财联社复盘",
        subtitle: "盘前报告观点 → 当日与 T+1/5/10 方向和超额收益",
        icon: Newspaper,
      },
    ],
  },
  {
    label: "分析",
    items: [
      {
        href: "/market",
        label: "行情图表",
        subtitle: "从真实行情出发，把判断建立在证据上",
        icon: ChartLine,
        tab: "market",
      },
      {
        href: "/screen",
        label: "条件选股",
        subtitle: "先用规则缩小范围，再用研究理解差异",
        icon: Funnel,
        tab: "screen",
      },
      {
        href: "/rps",
        label: "RPS 数据",
        title: "RPS 数据管理",
        subtitle: "个股、行业与概念的相对强度排名计算与审计 · 共用一个任务队列",
        icon: Ranking,
      },
      {
        href: "/signals",
        label: "信号与通知",
        subtitle: "规则触发 → 交易状态核验 → 渠道投递",
        icon: Broadcast,
        tab: "signals",
      },
    ],
  },
  {
    label: "数字货币",
    items: [
      {
        href: "/crypto",
        label: "数字货币行情",
        subtitle: "币安现货 · 7×24 · UTC 收线 · 与 A 股数据完全分开",
        icon: CurrencyBtc,
      },
    ],
  },
  {
    label: "资源期货",
    items: [
      {
        href: "/futures",
        label: "资源期货行情",
        subtitle: "金银铜铝与原油 · Yahoo / 东方财富连续合约 · 仅浏览",
        icon: Mountains,
      },
    ],
  },
  {
    label: "台账",
    items: [
      {
        href: "/signal-ledger",
        label: "信号台账",
        subtitle: "每条信号的后续表现 · 原始记录只追加不覆盖",
        icon: Notebook,
      },
      {
        href: "/trade-ledger",
        label: "持仓与交易日志",
        subtitle: "模拟账户持仓、成交与交易日志",
        icon: Wallet,
      },
      {
        href: "/trade-review",
        label: "交割单与交易复盘",
        subtitle: "导入券商交割单 · 现金对账 · 纪律与执行质量复盘",
        icon: Receipt,
        hidden: true,
      },
    ],
  },
  {
    label: "研究",
    items: [
      {
        href: "/analysis",
        label: "证据分析",
        subtitle: "多看一层，少猜一步 · 数据来源与时间可追溯",
        icon: Sparkle,
        tab: "analysis",
      },
      {
        href: "/backtest",
        label: "策略实验",
        subtitle: "把策略想法变成可以复现的实验 · 研究模拟，不作为正式策略业绩",
        icon: Flask,
        tab: "backtest",
      },
      {
        href: "/research",
        label: "策略样本研究",
        subtitle: "多策略批量样本 · 准入评估与多重检验",
        icon: TestTube,
      },
      {
        href: "/news",
        label: "新闻 / 主题",
        subtitle: "财联社新闻 AI 归纳为主题，并对照主题成分价格",
        icon: Hash,
        tab: "news",
      },
      {
        href: "/reports",
        label: "研究档案",
        subtitle: "保存每一次研究，以及支撑判断的证据",
        icon: Books,
        tab: "reports",
      },
    ],
  },
  {
    label: "系统",
    items: [
      {
        href: "/tasks",
        label: "任务中心",
        subtitle: "选股、RPS、AI 研究共用本机后台队列",
        icon: ListChecks,
        tab: "tasks",
      },
      {
        href: "/settings",
        label: "数据与连接",
        subtitle: "只读接入本地行情 · 凭证保存在系统加密存储",
        icon: PlugsConnected,
        tab: "settings",
      },
    ],
  },
];

export const navItems = navGroups.flatMap((group) =>
  group.items.map((item) => ({ ...item, group: group.label })),
);

/** Route of a former workbench tab. */
export function tabHref(tab: Tab) {
  return navItems.find((item) => item.tab === tab)!.href;
}

/** Page for a pathname; report details belong to 研究档案. */
export function navItemFor(pathname: string) {
  return (
    navItems.find((item) => item.href === pathname) ??
    (pathname.startsWith("/reports/")
      ? {
          ...navItems.find((item) => item.href === "/reports")!,
          title: "研究报告详情",
        }
      : undefined)
  );
}

/** Match a sidebar search query against labels, titles and routes. */
export function searchNav(query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const has = (...texts: string[]) =>
    texts.some((text) => text.toLowerCase().includes(q));
  // Name and route matches rank ahead of group and description matches.
  return [
    ...navItems.filter((item) => has(item.label, item.title ?? "", item.href)),
    ...navItems.filter(
      (item) =>
        !has(item.label, item.title ?? "", item.href) &&
        has(item.group, item.subtitle),
    ),
  ];
}
