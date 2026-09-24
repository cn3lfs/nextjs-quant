import type { Tone } from "../panels/tone";
import {
  dayPhase,
  formatMinutes,
  parseHhmm,
  type DayPhase,
} from "~/lib/market/market-session";

/**
 * Pure derivations behind 今日总览. Inputs are the repository's own status
 * payloads (narrowed to the fields used); nothing here fetches or invents data.
 */
export type RunStatus =
  "running" | "complete" | "partial" | "failed" | "missed";

export type OverviewInput = {
  now: number;
  /** Beijing date and minutes of `now`. */
  date: string;
  minutes: number;
  intraday?: {
    config: { enabled: boolean; noon: string; late: string };
    lastCheck: {
      checkedAt: number;
      schedule: {
        date: string;
        /** "open" | "closed" | "unknown" (widened by intradaySchedule). */
        trading: string;
        previousTradingDay: string | null;
        slots: { slot: string; status: string }[];
        closeDue: boolean;
      };
    } | null;
    worker: { running: boolean; error: string | null };
    runs: {
      date: string;
      slot: "noon" | "late";
      status: RunStatus;
      results: { observationId: string | null }[];
    }[];
    /** Observations of today with their close attempts. */
    unconfirmed: number;
  };
  cls?: {
    enabled: boolean;
    lastCheck: {
      checkedAt: number;
      status: "waiting" | "fixed" | "verified" | "missed" | "failed";
      message: string;
    } | null;
  };
  coverage: {
    counts: Record<string, number>;
    scannedAt: number;
  } | null;
  rps?: { latestDate: string | null; running: boolean; error?: string | null };
  channels: { enabled: boolean }[];
  failedDeliveries: number;
};

export type TimelineSlot = {
  key: string;
  time: string;
  label: string;
  status: string;
  tone: Tone;
  /** Position on the 07:40–15:40 axis, 0–100. */
  pct: number;
};

export const AXIS_START = 7 * 60 + 40;
export const AXIS_END = 15 * 60 + 40;
/** The 11:30–13:00 lunch break is drawn at a fixed short width. */
export const LUNCH_START = 11 * 60 + 30;
export const LUNCH_END = 13 * 60;
const LUNCH_DRAWN = 20;
const AXIS_SPAN = AXIS_END - AXIS_START - (LUNCH_END - LUNCH_START) + LUNCH_DRAWN;
export const axisPct = (minutes: number) => {
  const m = Math.max(AXIS_START, Math.min(AXIS_END, minutes));
  const drawn =
    m <= LUNCH_START
      ? m - AXIS_START
      : m < LUNCH_END
        ? LUNCH_START - AXIS_START +
          ((m - LUNCH_START) / (LUNCH_END - LUNCH_START)) * LUNCH_DRAWN
        : m - AXIS_START - (LUNCH_END - LUNCH_START) + LUNCH_DRAWN;
  return (drawn / AXIS_SPAN) * 100;
};

const hhmm = (at: number) =>
  new Date(at + 8 * 3600000).toISOString().slice(11, 16);
const beijingDate = (at: number) =>
  new Date(at + 8 * 3600000).toISOString().slice(0, 10);

export function phaseOf(input: OverviewInput): DayPhase {
  const config = input.intraday?.config ?? { noon: "11:20", late: "14:40" };
  return dayPhase(input.minutes, config);
}

function todayRun(input: OverviewInput, slot: "noon" | "late") {
  return input.intraday?.runs.find(
    (run) => run.date === input.date && run.slot === slot,
  );
}
export const candidates = (run?: {
  results: { observationId: string | null }[];
}) => run?.results.filter((result) => result.observationId).length ?? 0;

const runLabel: Record<RunStatus, string> = {
  running: "执行中",
  complete: "已完成",
  partial: "部分完成",
  failed: "失败",
  missed: "已错过",
};
const runTone: Record<RunStatus, Tone> = {
  running: "accent",
  complete: "ok",
  partial: "warn",
  failed: "bad",
  missed: "warn",
};

function until(minutes: number, target: number) {
  const left = target - minutes;
  return left <= 60 ? `${left} 分钟后` : `${formatMinutes(target)} 运行`;
}

/** The day's scheduled windows with their real status. */
export function timeline(input: OverviewInput): TimelineSlot[] {
  const m = input.minutes;
  const schedule =
    input.intraday?.lastCheck?.schedule.date === input.date
      ? input.intraday.lastCheck.schedule
      : null;
  const closedDay = schedule?.trading === "closed";
  const config = input.intraday?.config;
  const cls = input.cls;
  const clsCheck =
    cls?.lastCheck && beijingDate(cls.lastCheck.checkedAt) === input.date
      ? cls.lastCheck
      : null;
  const clsStatus: Pick<TimelineSlot, "status" | "tone"> = !cls?.enabled
    ? { status: "未启用", tone: "idle" }
    : clsCheck?.status === "fixed" || clsCheck?.status === "verified"
      ? {
          status: `${clsCheck.message} ${hhmm(clsCheck.checkedAt)}`,
          tone: "ok",
        }
      : clsCheck?.status === "failed" || clsCheck?.status === "missed"
        ? {
            status: clsCheck.message,
            tone: clsCheck.status === "failed" ? "bad" : "warn",
          }
        : m < 8 * 60
          ? { status: until(m, 8 * 60), tone: "accent" }
          : { status: clsCheck?.message ?? "等待盘前报告", tone: "accent" };
  const slot = (
    key: "noon" | "late",
  ): Pick<TimelineSlot, "status" | "tone"> => {
    if (!config?.enabled) return { status: "未启用", tone: "idle" };
    if (closedDay) return { status: "休市", tone: "idle" };
    const run = todayRun(input, key);
    if (run)
      return {
        status:
          run.status === "complete" || run.status === "partial"
            ? `${runLabel[run.status]} · ${candidates(run)} 个候选`
            : runLabel[run.status],
        tone: runTone[run.status],
      };
    const at = parseHhmm(config[key]);
    if (m < at) return { status: until(m, at), tone: "accent" };
    if (m < at + 5) return { status: "处于执行窗口", tone: "accent" };
    return { status: "未运行", tone: "warn" };
  };
  const open = m >= 9 * 60 + 30;
  return [
    {
      key: "cls",
      time: "08:00",
      label: "财联社报告扫描",
      pct: axisPct(8 * 60),
      ...clsStatus,
    },
    {
      key: "open",
      time: "09:30",
      label: "开盘",
      pct: axisPct(9 * 60 + 30),
      ...(closedDay
        ? { status: "非交易日", tone: "idle" as const }
        : open
          ? { status: m >= 15 * 60 ? "已收盘" : "已开盘", tone: "ok" as const }
          : { status: until(m, 9 * 60 + 30), tone: "accent" as const }),
    },
    {
      key: "noon",
      time: config?.noon ?? "11:20",
      label: "午盘预选",
      pct: axisPct(parseHhmm(config?.noon ?? "11:20")),
      ...slot("noon"),
    },
    {
      key: "late",
      time: config?.late ?? "14:40",
      label: "尾盘预选",
      pct: axisPct(parseHhmm(config?.late ?? "14:40")),
      ...slot("late"),
    },
    {
      key: "close",
      time: "15:05",
      label: "收盘复盘核对",
      pct: axisPct(15 * 60 + 5),
      ...(!config?.enabled
        ? { status: "未启用", tone: "idle" as const }
        : closedDay
          ? { status: "休市", tone: "idle" as const }
          : m < 15 * 60 + 5
            ? { status: until(m, 15 * 60 + 5), tone: "accent" as const }
            : input.intraday!.unconfirmed > 0
              ? {
                  status: `${input.intraday!.unconfirmed} 个待核对`,
                  tone: "accent" as const,
                }
              : { status: "已核对", tone: "ok" as const }),
    },
  ];
}

export function scheduleSummary(input: OverviewInput) {
  const done = (["noon", "late"] as const).filter((slot) =>
    ["complete", "partial"].includes(todayRun(input, slot)?.status ?? ""),
  ).length;
  return input.intraday?.config.enabled
    ? `今日 ${done}/2 个预选批次已运行`
    : "盘中预选未启用";
}

export type HealthCard = {
  key: string;
  name: string;
  value: string;
  note: string;
  tone: Tone;
};

const sum = (counts: Record<string, number>, period: string) =>
  Object.entries(counts)
    .filter(([key]) => key.endsWith(`/${period}`))
    .reduce((total, [, n]) => total + n, 0);

export function health(input: OverviewInput): HealthCard[] {
  const c = input.coverage;
  const previous = input.intraday?.lastCheck?.schedule.previousTradingDay;
  const rpsStale =
    !!input.rps?.latestDate && !!previous && input.rps.latestDate < previous;
  const check = input.intraday?.lastCheck;
  const enabledChannels = input.channels.filter((ch) => ch.enabled).length;
  return [
    {
      key: "day",
      name: "通达信日线",
      value: c
        ? `${sum(c.counts, "day").toLocaleString("zh-CN")} 个`
        : "未扫描",
      note: c
        ? `扫描于 ${new Date(c.scannedAt).toLocaleString("zh-CN", { hour12: false })} · 源目录只读`
        : "在数据与连接中扫描本地行情",
      tone: c ? "neutral" : "warn",
    },
    {
      key: "5m",
      name: "5 分钟行情",
      value: c ? `${sum(c.counts, "5m").toLocaleString("zh-CN")} 个` : "未扫描",
      note: "盘中预选需要当日完整 5 分钟线",
      tone: c && sum(c.counts, "5m") > 0 ? "neutral" : "warn",
    },
    {
      key: "rps",
      name: "RPS 数据",
      value: input.rps?.running
        ? "计算中"
        : input.rps?.latestDate
          ? `截至 ${input.rps.latestDate.slice(5)}`
          : "尚未计算",
      note: input.rps?.error
        ? input.rps.error
        : rpsStale
          ? `落后于上一交易日 ${previous}`
          : "个股 RPS 最近批次",
      tone: input.rps?.error
        ? "bad"
        : input.rps?.running
          ? "accent"
          : !input.rps?.latestDate || rpsStale
            ? "warn"
            : "neutral",
    },
    {
      key: "schedule",
      name: "调度",
      value: !input.intraday?.config.enabled
        ? "未启用"
        : input.intraday.worker.error
          ? "异常"
          : input.intraday.worker.running
            ? "执行中"
            : "运行中",
      note: input.intraday?.worker.error
        ? input.intraday.worker.error
        : check
          ? `最近检查 ${hhmm(check.checkedAt)} · 休眠会停止`
          : "应用运行时每分钟检查",
      tone: input.intraday?.worker.error
        ? "bad"
        : input.intraday?.config.enabled
          ? "neutral"
          : "idle",
    },
    {
      key: "channels",
      name: "通知渠道",
      value:
        input.failedDeliveries > 0
          ? `${input.failedDeliveries} 条失败`
          : `${enabledChannels} 个启用`,
      note:
        input.failedDeliveries > 0
          ? "信号已记录，未送达；可在信号与通知中重发"
          : enabledChannels
            ? "近期投递正常"
            : "尚未启用聊天渠道",
      tone:
        input.failedDeliveries > 0
          ? "bad"
          : enabledChannels
            ? "neutral"
            : "idle",
    },
  ];
}

export type Todo = {
  key: string;
  tone: Tone;
  tag: string;
  title: string;
  detail: string;
  action: string;
  href: string;
};

const severity: Record<Tone, number> = {
  bad: 0,
  warn: 1,
  accent: 2,
  ok: 3,
  neutral: 4,
  idle: 5,
};

/** 下一步: blocking issues first, then the next window, then finished work. */
export function todos(input: OverviewInput): Todo[] {
  const list: Todo[] = [];
  const m = input.minutes;
  const intraday = input.intraday;
  if (!input.coverage)
    list.push({
      key: "scan",
      tone: "warn",
      tag: "阻塞",
      title: "尚未扫描本地行情",
      detail:
        "选股、RPS 与盘中预选都依赖本地扫描索引。扫描只读取通达信目录，不修改源文件。",
      action: "去扫描",
      href: "/settings",
    });
  if (input.failedDeliveries > 0)
    list.push({
      key: "deliveries",
      tone: "bad",
      tag: "失败",
      title: `${input.failedDeliveries} 条通知投递失败`,
      detail: "信号已记录，未送达；查看失败原因后可手动重发。",
      action: "重发",
      href: "/signals",
    });
  if (intraday?.worker.error)
    list.push({
      key: "worker",
      tone: "bad",
      tag: "异常",
      title: "盘中调度执行出错",
      detail: intraday.worker.error,
      action: "查看",
      href: "/intraday",
    });
  if (intraday && !intraday.config.enabled)
    list.push({
      key: "intraday-off",
      tone: "idle",
      tag: "未启用",
      title: "盘中预选未启用",
      detail: `启用后在 ${intraday.config.noon} / ${intraday.config.late} 各运行一次，应用退出或休眠会错过批次。`,
      action: "去设置",
      href: "/intraday",
    });
  if (
    intraday?.config.enabled &&
    intraday.lastCheck?.schedule.trading !== "closed"
  )
    for (const slot of ["noon", "late"] as const) {
      const at = parseHhmm(intraday.config[slot]);
      const name = slot === "noon" ? "午盘预选" : "尾盘预选";
      const run = todayRun(input, slot);
      if (run)
        list.push({
          key: slot,
          tone: runTone[run.status],
          tag: runLabel[run.status],
          title:
            run.status === "complete" || run.status === "partial"
              ? `${name}批次 ${candidates(run)} 个候选已记录`
              : `${name}批次${runLabel[run.status]}`,
          detail: "收盘后核对成立 / 撤销 / 数据不足，不覆盖原始预选。",
          action: "查看",
          href: "/intraday",
        });
      else if (m < at + 5)
        list.push({
          key: slot,
          tone: "accent",
          tag: m < at ? until(m, at) : "执行窗口",
          title: `${name} ${intraday.config[slot]} 即将运行`,
          detail:
            "运行窗口为时点后 5 分钟；数据不足时不会产生候选，不代表策略不成立。",
          action: "看参数",
          href: "/intraday",
        });
      else
        list.push({
          key: slot,
          tone: "warn",
          tag: "未运行",
          title: `${name} ${intraday.config[slot]} 没有执行记录`,
          detail: "窗口已过；错过的批次不能用之后的数据补作当时的观察。",
          action: "查看",
          href: "/intraday",
        });
    }
  if (intraday && intraday.unconfirmed > 0 && m >= 15 * 60 + 5)
    list.push({
      key: "confirm",
      tone: "accent",
      tag: "待处理",
      title: `${intraday.unconfirmed} 个预选待收盘核对`,
      detail: "逐个核对成立 / 撤销 / 数据不足，并可导出当时与收盘的行情证据。",
      action: "开始核对",
      href: "/intraday",
    });
  const cls = input.cls?.lastCheck;
  if (
    input.cls?.enabled &&
    cls &&
    (cls.status === "failed" || cls.status === "missed")
  )
    list.push({
      key: "cls",
      tone: cls.status === "failed" ? "bad" : "warn",
      tag: cls.status === "failed" ? "失败" : "已错过",
      title: "财联社盘前样本未固定",
      detail: cls.message,
      action: "去核对",
      href: "/cls-review",
    });
  else if (input.cls?.enabled && m >= 15 * 60 + 5)
    list.push({
      key: "cls",
      tone: "accent",
      tag: "15:05 后",
      title: "财联社样本待核对方向与超额",
      detail: "当日与 T+1/5/10 方向、基准和超额收益；未到期、停牌、缺价单列。",
      action: "去核对",
      href: "/cls-review",
    });
  const rps = health(input).find((card) => card.key === "rps")!;
  if (rps.tone === "warn" || rps.tone === "bad")
    list.push({
      key: "rps",
      tone: rps.tone,
      tag: rps.tone === "bad" ? "失败" : "待更新",
      title: `RPS ${rps.value}`,
      detail: `${rps.note}。高 RPS 是候选过滤，不是买入指令。`,
      action: "看排名",
      href: "/rps",
    });
  return list.sort((a, b) => severity[a.tone] - severity[b.tone]);
}
