import {
  BookOpen,
  FlaskConical,
  LayoutDashboard,
  Radio,
  Settings2,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";

export type Tab =
  | "market"
  | "screen"
  | "backtest"
  | "signals"
  | "reports"
  | "settings"
  | "analysis"
  | "news";
export const dailyTabs = [
  { id: "market", label: "行情图表", icon: LayoutDashboard },
  { id: "screen", label: "条件选股", icon: SlidersHorizontal },
  { id: "signals", label: "信号与通知", icon: Radio },
  { id: "settings", label: "数据与连接", icon: Settings2 },
] as const;
// Research keeps existing panel groups intact; no panel implementation changes.
export const researchTabs = [
  { id: "analysis", label: "证据分析", icon: Sparkles },
  { id: "reports", label: "研究档案", icon: BookOpen },
  { id: "backtest", label: "策略实验", icon: FlaskConical },
  { id: "news", label: "新闻/主题", icon: BookOpen },
] as const;
export const tabs = [...dailyTabs, ...researchTabs];

export const routeTabs = [
  { href: "/intraday", label: "盘中预选", icon: SlidersHorizontal },
  { href: "/research", label: "策略研究", icon: FlaskConical },
  { href: "/cls-review", label: "财联社复盘", icon: BookOpen },
  { href: "/signal-ledger", label: "信号台账", icon: BookOpen },
  { href: "/trade-ledger", label: "持仓与交易日志", icon: BookOpen },
  { href: "/rps", label: "RPS数据管理", icon: BookOpen },
] as const;
