"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { formatNumber } from "trading-strategy-core/format-number";
import {
  chanSignalCodes,
  patternBreakoutKinds,
  theoryScreenerFamilyIds,
  type ChanSignalCode,
  type PatternBreakoutKind,
  type TheoryScreenerFamilyId,
} from "trading-strategies";
import { api, type RouterOutputs } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useMarketSession } from "~/lib/stores/market-session";
import { cn } from "~/lib/common/classnames";
import {
  buildScanToLabHandoffHref,
  isScreenerStrategyKey,
  ScanToLabHandoffSchema,
  SCREENER_STRATEGY_PREFIX,
} from "~/lib/research/diagnose-contract";
import {
  batchCandidatesToLabHref,
  patternCandidateToLabHref,
  portfolioHandoffLimit,
  portfolioHandoffLimitMessage,
  useCandidateBatchSelection,
} from "~/lib/screening/screen-candidate-navigation";
import { usePanelVisible } from "~/components/workbench/keep-alive";

type Candidate = RouterOutputs["patternScreenRun"]["candidates"][number];
type Direction = "both" | "long" | "short";

const chanCodeLabels: Record<ChanSignalCode, string> = {
  "1B": "一买",
  "1S": "一卖",
  P1B: "盘背一买",
  P1S: "盘背一卖",
  "2B": "二买",
  "2S": "二卖",
  L2B: "类二/二三重合买",
  L2S: "类二/二三重合卖",
  "3B": "三买",
  "3S": "三卖",
  STB: "小转大买",
  STS: "小转大卖",
  NB: "区间套买",
  NS: "区间套卖",
  ZYB: "中阴转折买",
  ZYS: "中阴转折卖",
  KB: "均线吻买",
  KS: "均线吻卖",
};
const patternKindLabels: Record<PatternBreakoutKind, string> = {
  "head-shoulders-bottom": "头肩底",
  "head-shoulders-top": "头肩顶",
  box: "箱体",
  triangle: "三角形",
  wedge: "楔形",
};
const theoryFamilyLabels: Record<TheoryScreenerFamilyId, string> = {
  "trend-breakout": "F02–04 趋势与波动突破",
  "growth-oneil": "F09 欧奈尔/SEPA/VCP",
  "wyckoff-volume": "F08 威科夫/VSA/筹码/AVWAP",
  "astock-dragon": "F11 A股龙头/首板/弱转强/二波",
  "wave-harmonic-smc": "F05–06 波浪/黄金分割/谐波/SMC",
  "momentum-reversion": "F10/12 动量拐点与极值回归",
  "value-multifactor": "F13 魔法公式/F-Score/多因子",
};
const theoryPresets: { label: string; families: TheoryScreenerFamilyId[] }[] = [
  { label: "全部流派", families: [...theoryScreenerFamilyIds] },
  { label: "欧奈尔成长+趋势", families: ["growth-oneil", "trend-breakout"] },
  {
    label: "威科夫量价+A股龙头",
    families: ["wyckoff-volume", "astock-dragon"],
  },
  { label: "波浪谐波+SMC", families: ["wave-harmonic-smc"] },
];
const symbolPattern = /^(sh|sz|bj)\d{6}$/;

function numberOrUndefined(text: string) {
  if (text.trim() === "") return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

function priceText(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : formatNumber(value, 2);
}

function ratioText(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : value.toFixed(2);
}

function rpsText(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : value.toFixed(1);
}

/** The leading theory match of a row, if it matched a theory method. */
function rowTheoryMatch(matches: readonly Candidate["matches"][number][]) {
  return matches.find(
    (match) => match.family === "theory" && match.methodId !== undefined,
  );
}

function screenerStrategyHint(methodId: string | null | undefined) {
  if (!methodId) return undefined;
  const key = `${SCREENER_STRATEGY_PREFIX}${methodId}`;
  return isScreenerStrategyKey(key) ? key : undefined;
}

/**
 * A batch hands one strategy hint to the diagnostic sleeve. Only use it when
 * every selected row matched exactly the same single theory method; otherwise
 * the hint would misdescribe part of the portfolio.
 */
function sharedTheoryMethodId(rows: readonly Candidate[]): string | null {
  let shared: string | null = null;
  for (const row of rows) {
    const ids = new Set(
      row.matches.flatMap((match) =>
        match.family === "theory" && match.methodId ? [match.methodId] : [],
      ),
    );
    if (ids.size !== 1) return null;
    const id = [...ids][0]!;
    if (shared === null) shared = id;
    else if (shared !== id) return null;
  }
  return shared;
}

/**
 * Builds a handoff URL only for a payload the contract accepts; an invalid
 * return path or field drops the link instead of throwing during render.
 */
function safeHandoffHref(
  payload: Parameters<typeof buildScanToLabHandoffHref>[0],
): string | null {
  const { returnTo, ...fields } = payload;
  const safeReturnTo =
    ScanToLabHandoffSchema.shape.returnTo.safeParse(returnTo);
  const parsed = ScanToLabHandoffSchema.safeParse({
    ...fields,
    ...(safeReturnTo.success ? { returnTo: safeReturnTo.data } : {}),
  });
  return parsed.success ? buildScanToLabHandoffHref(parsed.data) : null;
}

/** Badge that toggles one member of a multi-select filter. */
function ToggleBadge({
  active,
  label,
  title,
  onClick,
}: {
  active: boolean;
  label: string;
  title?: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="plain"
      type="button"
      aria-pressed={active}
      title={title}
      className={cn(
        "rounded border px-1.5 py-0.5 text-[11px]",
        active
          ? "border-primary bg-primary/15 text-primary"
          : "border-border text-muted-foreground",
      )}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

function DirectionSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: Direction;
  onChange: (value: Direction) => void;
  options?: { both: string; long: string; short: string };
}) {
  const labels = options ?? { both: "双向", long: "只做多", short: "只做空" };
  return (
    <label className="flex items-center gap-1 text-xs">
      方向
      <Select
        value={value}
        onValueChange={(next) => {
          if (next === "both" || next === "long" || next === "short")
            onChange(next);
        }}
      >
        <SelectTrigger aria-label={label} size="sm" className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="both">{labels.both}</SelectItem>
          <SelectItem value="long">{labels.long}</SelectItem>
          <SelectItem value="short">{labels.short}</SelectItem>
        </SelectContent>
      </Select>
    </label>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="space-y-2 rounded border border-border p-2">
      <legend className="px-1 text-xs font-medium">{title}</legend>
      {children}
    </fieldset>
  );
}

function matchLabel(match: Candidate["matches"][number]) {
  if (match.family === "chan")
    return `缠论 ${match.code ?? ""}${
      match.config === 0 ? "·笔" : match.config === 1100 ? "·段" : ""
    }`;
  if (match.family === "doubleBreakout") return "双突破";
  if (match.family === "theory")
    return `${match.theoryId ? `${match.theoryId} ` : ""}${
      match.label ?? match.methodId ?? "理论战法"
    }`;
  return `形态 ${match.subKind ?? match.kind ?? ""}`;
}

function matchColor(match: Candidate["matches"][number]) {
  if (match.family === "chan") return "text-nc-accent-light";
  if (match.family === "doubleBreakout") return "text-nc-warn";
  if (match.family === "theory") return "text-primary";
  return "text-nc-ok";
}

/**
 * Combined Chan / double-breakout / classic-pattern screen. A row opens the
 * frozen signal-day snapshot in the chart beside the list, exactly like the
 * formula screen's candidates, so the evidence is the same immutable prefix.
 */
export function PatternScreenPanel() {
  const router = useRouter();
  const visible = usePanelVisible();
  const search = useSearchParams();
  const returnTo = `/scan?${search.toString()}`;
  const run = api.patternScreenRun.useMutation();
  const [message, setMessage] = useState("");

  const [chanEnabled, setChanEnabled] = useState(true);
  const [chanDirection, setChanDirection] = useState<Direction>("both");
  const [chanConfigs, setChanConfigs] = useState<(0 | 1100)[]>([0, 1100]);
  const [chanCodes, setChanCodes] = useState<ChanSignalCode[]>([
    ...chanSignalCodes,
  ]);

  const [doubleEnabled, setDoubleEnabled] = useState(true);
  const [doubleDirection, setDoubleDirection] = useState<Direction>("both");
  const [doubleScore, setDoubleScore] = useState("3");
  const [doubleVolume, setDoubleVolume] = useState("");

  const [patternsEnabled, setPatternsEnabled] = useState(true);
  const [patternDirection, setPatternDirection] = useState<Direction>("both");
  const [patternKinds, setPatternKinds] = useState<PatternBreakoutKind[]>([
    ...patternBreakoutKinds,
  ]);
  const [patternScore, setPatternScore] = useState("");
  const [patternVolume, setPatternVolume] = useState("");

  const [theoryEnabled, setTheoryEnabled] = useState(true);
  const [theoryDirection, setTheoryDirection] = useState<Direction>("long");
  const [theoryFamilies, setTheoryFamilies] = useState<
    TheoryScreenerFamilyId[]
  >([...theoryScreenerFamilyIds]);
  const [theoryScore, setTheoryScore] = useState("");
  const [theoryVolume, setTheoryVolume] = useState("");

  const [combineMode, setCombineMode] = useState<"any" | "all">("any");
  const [lookbackBars, setLookbackBars] = useState("3");
  const [minRps20, setMinRps20] = useState("");
  const [minRps50, setMinRps50] = useState("");
  const [minRps120, setMinRps120] = useState("");
  const [symbolsText, setSymbolsText] = useState("");

  const toggle = <T,>(list: T[], value: T) =>
    list.includes(value)
      ? list.filter((item) => item !== value)
      : [...list, value];

  const candidates = run.data?.candidates ?? [];
  const filtersKey = JSON.stringify([
    chanEnabled,
    chanDirection,
    chanConfigs,
    chanCodes,
    doubleEnabled,
    doubleDirection,
    doubleScore,
    doubleVolume,
    patternsEnabled,
    patternDirection,
    patternKinds,
    patternScore,
    patternVolume,
    theoryEnabled,
    theoryDirection,
    theoryFamilies,
    theoryScore,
    theoryVolume,
    combineMode,
    lookbackBars,
    minRps20,
    minRps50,
    minRps120,
    symbolsText,
  ]);
  const [submittedFilters, setSubmittedFilters] = useState<string | null>(null);
  const batchReady =
    visible && run.isSuccess && submittedFilters === filtersKey;
  const batchSelection = useCandidateBatchSelection(
    batchReady ? JSON.stringify([run.submittedAt, filtersKey, returnTo]) : null,
  );
  const selectedCandidates = candidates.filter((row) =>
    batchSelection.symbols.includes(row.symbol),
  );
  const selectedDates = new Set(selectedCandidates.map((row) => row.date));
  const batchStrategyHint = screenerStrategyHint(
    sharedTheoryMethodId(selectedCandidates),
  );
  const batchHref = batchStrategyHint
    ? safeHandoffHref({
        scope: "portfolio-diagnose",
        handoffSource: "pattern",
        symbol: batchSelection.symbols[0],
        symbols: batchSelection.symbols,
        label: "结构与形态突破",
        frozenDate:
          selectedDates.size === 1 ? [...selectedDates][0] : undefined,
        strategyHint: batchStrategyHint,
        returnTo,
      })
    : (batchCandidatesToLabHref({
        symbols: batchSelection.symbols,
        handoffSource: "pattern",
        label: "结构与形态突破",
        frozenDate:
          selectedDates.size === 1 ? [...selectedDates][0] : undefined,
        returnTo,
      })?.href ?? null);
  const batchFull = batchSelection.symbols.length >= portfolioHandoffLimit;

  function submit() {
    setMessage("");
    if (!chanEnabled && !doubleEnabled && !patternsEnabled && !theoryEnabled) {
      setMessage("请至少启用一种信号来源。");
      return;
    }
    if (theoryEnabled && theoryFamilies.length === 0) {
      setMessage("理论战法选股已启用，请至少选择一个理论流派。");
      return;
    }
    if (chanEnabled && chanCodes.length === 0) {
      setMessage("缠论已启用，请至少选择一个买卖点代码。");
      return;
    }
    if (chanEnabled && chanConfigs.length === 0) {
      setMessage("缠论已启用，请至少选择一个级别（笔或线段）。");
      return;
    }
    if (patternsEnabled && patternKinds.length === 0) {
      setMessage("形态突破已启用，请至少选择一种形态。");
      return;
    }
    const score = numberOrUndefined(doubleScore);
    if (
      doubleEnabled &&
      score !== undefined &&
      (score < 3 || score > 5 || !Number.isInteger(score))
    ) {
      setMessage("双突破最低分须为 3–5 的整数。");
      return;
    }
    const patternScoreValue = numberOrUndefined(patternScore);
    if (
      patternsEnabled &&
      patternScoreValue !== undefined &&
      (patternScoreValue < 0 || patternScoreValue > 5)
    ) {
      setMessage("形态最低分须在 0–5 之间。");
      return;
    }
    const theoryScoreValue = numberOrUndefined(theoryScore);
    if (
      theoryEnabled &&
      theoryScoreValue !== undefined &&
      (!Number.isInteger(theoryScoreValue) ||
        theoryScoreValue < 1 ||
        theoryScoreValue > 5)
    ) {
      setMessage("理论战法最低分须为 1–5 的整数。");
      return;
    }
    const volumes = [
      doubleEnabled ? numberOrUndefined(doubleVolume) : undefined,
      patternsEnabled ? numberOrUndefined(patternVolume) : undefined,
      theoryEnabled ? numberOrUndefined(theoryVolume) : undefined,
    ];
    if (volumes.some((value) => value !== undefined && value < 0)) {
      setMessage("最小量比不能为负数。");
      return;
    }
    const bars = Number(lookbackBars);
    if (!Number.isInteger(bars) || bars < 1 || bars > 20) {
      setMessage("回看 K 线数须为 1–20 的整数。");
      return;
    }
    const invalidRps = (
      [
        ["RPS20", numberOrUndefined(minRps20)],
        ["RPS50", numberOrUndefined(minRps50)],
        ["RPS120", numberOrUndefined(minRps120)],
      ] as const
    ).find(([, value]) => value !== undefined && (value < 0 || value > 100));
    if (invalidRps) {
      setMessage(`${invalidRps[0]} 阈值须在 0–100 之间。`);
      return;
    }
    const symbols = [
      ...new Set(
        symbolsText
          .split(/[\s,，;；]+/)
          .map((symbol) => symbol.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    const invalidSymbols = symbols.filter(
      (symbol) => !symbolPattern.test(symbol),
    );
    if (invalidSymbols.length > 0) {
      setMessage(
        `证券代码格式无效：${invalidSymbols.join("、")}；应为 sh/sz/bj 加 6 位数字。`,
      );
      return;
    }
    batchSelection.clear();
    setSubmittedFilters(filtersKey);
    run.mutate({
      ...(chanEnabled
        ? {
            chan: {
              enabled: true,
              direction: chanDirection,
              ...(chanCodes.length === chanSignalCodes.length
                ? {}
                : { codes: chanCodes }),
              ...(chanConfigs.length === 2 ? {} : { configs: chanConfigs }),
            },
          }
        : {}),
      ...(doubleEnabled
        ? {
            doubleBreakout: {
              enabled: true,
              direction: doubleDirection,
              ...(score === undefined ? {} : { minScore: score }),
              ...(numberOrUndefined(doubleVolume) === undefined
                ? {}
                : { minVolumeRatio: numberOrUndefined(doubleVolume)! }),
            },
          }
        : {}),
      ...(patternsEnabled
        ? {
            patterns: {
              enabled: true,
              direction: patternDirection,
              ...(patternKinds.length === patternBreakoutKinds.length
                ? {}
                : { kinds: patternKinds }),
              ...(numberOrUndefined(patternScore) === undefined
                ? {}
                : { minScore: numberOrUndefined(patternScore)! }),
              ...(numberOrUndefined(patternVolume) === undefined
                ? {}
                : { minVolumeRatio: numberOrUndefined(patternVolume)! }),
            },
          }
        : {}),
      ...(theoryEnabled
        ? {
            theory: {
              enabled: true,
              direction: theoryDirection,
              ...(theoryFamilies.length === theoryScreenerFamilyIds.length
                ? {}
                : { families: theoryFamilies }),
              ...(theoryScoreValue === undefined
                ? {}
                : { minScore: theoryScoreValue }),
              ...(numberOrUndefined(theoryVolume) === undefined
                ? {}
                : { minVolumeRatio: numberOrUndefined(theoryVolume)! }),
            },
          }
        : {}),
      combineMode,
      lookbackBars: bars,
      ...(numberOrUndefined(minRps20) === undefined
        ? {}
        : { minRps20: numberOrUndefined(minRps20)! }),
      ...(numberOrUndefined(minRps50) === undefined
        ? {}
        : { minRps50: numberOrUndefined(minRps50)! }),
      ...(numberOrUndefined(minRps120) === undefined
        ? {}
        : { minRps120: numberOrUndefined(minRps120)! }),
      ...(symbols.length ? { symbols } : {}),
    });
  }

  function open(row: Candidate, index: number) {
    useMarketSession.getState().setBrowse({
      label: "结构形态候选",
      symbols: candidates.map((candidate) => candidate.symbol),
      index,
    });
    router.push(
      `/scan?tab=formula&symbol=${encodeURIComponent(row.symbol)}&screenSnapshot=${encodeURIComponent(row.snapshotId)}`,
      { scroll: false },
    );
  }

  return (
    <section className="panel space-y-3" aria-label="结构与形态突破选股">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0">结构与形态突破选股</h3>
        <Button
          variant="outline"
          size="sm"
          disabled={run.isPending}
          onClick={submit}
        >
          {run.isPending ? "正在扫描…" : "开始扫描"}
        </Button>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Section title="缠论全谱系买卖点">
          <label className="flex items-center gap-1 text-xs">
            <Checkbox
              checked={chanEnabled}
              onCheckedChange={(checked) => setChanEnabled(checked === true)}
            />
            启用缠论买卖点
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <DirectionSelect
              label="缠论方向"
              value={chanDirection}
              onChange={setChanDirection}
            />
            <div className="flex items-center gap-1 text-xs">
              <span className="text-muted-foreground">级别</span>
              {(
                [
                  [0, "笔"],
                  [1100, "线段"],
                ] as const
              ).map(([config, label]) => (
                <ToggleBadge
                  key={config}
                  active={chanConfigs.includes(config)}
                  label={label}
                  onClick={() =>
                    setChanConfigs((current) =>
                      toggle(current, config).sort((a, b) => a - b),
                    )
                  }
                />
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-1">
            {chanSignalCodes.map((code) => (
              <ToggleBadge
                key={code}
                active={chanCodes.includes(code)}
                label={`${code} ${chanCodeLabels[code]}`}
                onClick={() => setChanCodes((current) => toggle(current, code))}
              />
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            全谱系 18
            个代码；同时选中全部代码与两个级别时不额外传过滤条件。全市场扫描的缠论原生评估上限为
            120 只，超出部分只保留廉价信号命中。
          </p>
        </Section>

        <Section title="双突破（双向）">
          <label className="flex items-center gap-1 text-xs">
            <Checkbox
              checked={doubleEnabled}
              onCheckedChange={(checked) => setDoubleEnabled(checked === true)}
            />
            启用双突破
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <DirectionSelect
              label="双突破方向"
              value={doubleDirection}
              onChange={setDoubleDirection}
              options={{
                both: "双向",
                long: "向上突破买点",
                short: "向下破位卖点",
              }}
            />
            <label className="flex items-center gap-1 text-xs">
              最低分
              <Input
                aria-label="双突破最低分"
                className="h-7 w-16"
                type="number"
                min={3}
                max={5}
                value={doubleScore}
                onChange={(e) => setDoubleScore(e.target.value)}
              />
            </label>
            <label className="flex items-center gap-1 text-xs">
              最小量比
              <Input
                aria-label="双突破最小量比"
                className="h-7 w-16"
                type="number"
                min={0}
                step={0.1}
                placeholder="不限"
                value={doubleVolume}
                onChange={(e) => setDoubleVolume(e.target.value)}
              />
            </label>
          </div>
        </Section>

        <Section title="五大常见形态突破">
          <label className="flex items-center gap-1 text-xs">
            <Checkbox
              checked={patternsEnabled}
              onCheckedChange={(checked) =>
                setPatternsEnabled(checked === true)
              }
            />
            启用形态突破
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <DirectionSelect
              label="形态方向"
              value={patternDirection}
              onChange={setPatternDirection}
            />
            <label className="flex items-center gap-1 text-xs">
              最低分
              <Input
                aria-label="形态最低分"
                className="h-7 w-16"
                type="number"
                min={0}
                max={5}
                placeholder="不限"
                value={patternScore}
                onChange={(e) => setPatternScore(e.target.value)}
              />
            </label>
            <label className="flex items-center gap-1 text-xs">
              最小量比
              <Input
                aria-label="形态最小量比"
                className="h-7 w-16"
                type="number"
                min={0}
                step={0.1}
                placeholder="不限"
                value={patternVolume}
                onChange={(e) => setPatternVolume(e.target.value)}
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-1">
            {patternBreakoutKinds.map((kind) => (
              <ToggleBadge
                key={kind}
                active={patternKinds.includes(kind)}
                label={patternKindLabels[kind]}
                onClick={() =>
                  setPatternKinds((current) => toggle(current, kind))
                }
              />
            ))}
          </div>
        </Section>

        <Section title="七大流派理论战法选股 (F02–F18 · 57 种量化战法)">
          <label className="flex items-center gap-1 text-xs">
            <Checkbox
              checked={theoryEnabled}
              onCheckedChange={(checked) => setTheoryEnabled(checked === true)}
            />
            启用理论战法选股
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <DirectionSelect
              label="理论战法方向"
              value={theoryDirection}
              onChange={setTheoryDirection}
            />
            <label className="flex items-center gap-1 text-xs">
              最低分
              <Input
                aria-label="理论战法最低分"
                className="h-7 w-16"
                type="number"
                min={1}
                max={5}
                placeholder="不限"
                value={theoryScore}
                onChange={(e) => setTheoryScore(e.target.value)}
              />
            </label>
            <label className="flex items-center gap-1 text-xs">
              最小量比
              <Input
                aria-label="理论战法最小量比"
                className="h-7 w-16"
                type="number"
                min={0}
                step={0.1}
                placeholder="不限"
                value={theoryVolume}
                onChange={(e) => setTheoryVolume(e.target.value)}
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-1">
            {theoryPresets.map((preset) => (
              <Button
                key={preset.label}
                variant="outline"
                type="button"
                size="sm"
                className="h-6 px-1.5 text-[11px]"
                onClick={() => setTheoryFamilies([...preset.families])}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1">
            {theoryScreenerFamilyIds.map((family) => (
              <ToggleBadge
                key={family}
                active={theoryFamilies.includes(family)}
                label={theoryFamilyLabels[family]}
                onClick={() =>
                  setTheoryFamilies((current) => toggle(current, family))
                }
              />
            ))}
          </div>
        </Section>

        <Section title="组合与共振过滤">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1 text-xs">
              组合方式
              <Select
                value={combineMode}
                onValueChange={(value) => {
                  if (value === "any" || value === "all") setCombineMode(value);
                }}
              >
                <SelectTrigger aria-label="组合方式" size="sm" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">任一命中</SelectItem>
                  <SelectItem value="all">多维共振</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="flex items-center gap-1 text-xs">
              近
              <Input
                aria-label="回看K线数"
                className="h-7 w-16"
                type="number"
                min={1}
                max={250}
                value={lookbackBars}
                onChange={(e) => setLookbackBars(e.target.value)}
              />
              根 K 线
            </label>
            {(
              [
                ["RPS20", minRps20, setMinRps20],
                ["RPS50", minRps50, setMinRps50],
                ["RPS120", minRps120, setMinRps120],
              ] as const
            ).map(([label, value, setValue]) => (
              <label key={label} className="flex items-center gap-1 text-xs">
                {label} ≥
                <Input
                  aria-label={`${label}下限`}
                  className="h-7 w-16"
                  type="number"
                  min={0}
                  max={100}
                  placeholder="不限"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </label>
            ))}
          </div>
          <label className="flex flex-col gap-1 text-xs">
            指定证券（可选，逗号/空格分隔；留空扫描全市场）
            <Input
              aria-label="指定证券"
              placeholder="sh600519, sz000001"
              value={symbolsText}
              onChange={(e) => setSymbolsText(e.target.value)}
            />
          </label>
          <p className="text-[11px] text-muted-foreground">
            “多维共振”要求同一信号日同时满足所有已启用的信号来源；缠论仅在廉价信号未命中时补充计算。
          </p>
        </Section>
      </div>

      <p role="status" className="text-xs">
        {message}
      </p>
      {run.error && (
        <p role="alert" className="text-xs text-nc-bad">
          扫描失败：{run.error.message}
        </p>
      )}
      {run.data && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!batchHref}
              onClick={() => {
                if (batchHref) router.push(batchHref, { scroll: false });
              }}
            >
              {`批量带入组合诊断 (${batchSelection.symbols.length}/${portfolioHandoffLimit})`}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!batchHref}
              onClick={batchSelection.clear}
            >
              清空已选
            </Button>
          </div>
          <p role="status" className="text-xs text-muted-foreground">
            命中 {candidates.length} 只 · 缠论原生评估{" "}
            {run.data.czscEvaluatedCount} 次
            {run.data.errors.length
              ? ` · ${run.data.errors.length} 只读取失败`
              : ""}
          </p>
          {run.data.errors.length > 0 && (
            <details className="text-[11px] text-muted-foreground">
              <summary>读取失败明细（{run.data.errors.length}）</summary>
              <ul className="m-0 pl-4">
                {run.data.errors.slice(0, 50).map((error) => (
                  <li key={error.symbol}>
                    {error.symbol}：{error.error}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              没有符合条件的候选；可放宽方向、分数、量比或 RPS 后重试。
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[78rem] border-collapse text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    {batchReady && <th className="px-1.5 py-1">勾选</th>}
                    <th className="px-1.5 py-1">证券代码/名称</th>
                    <th className="px-1.5 py-1">信号日期</th>
                    <th className="px-1.5 py-1">方向</th>
                    <th className="px-1.5 py-1">命中信号</th>
                    <th className="px-1.5 py-1 text-right">信号收盘价</th>
                    <th className="px-1.5 py-1 text-right">原价参考</th>
                    <th className="px-1.5 py-1 text-right">结构止损位</th>
                    <th className="px-1.5 py-1 text-right">量度目标位</th>
                    <th className="px-1.5 py-1 text-right">盈亏比</th>
                    <th className="px-1.5 py-1 text-right">量比</th>
                    <th className="px-1.5 py-1 text-right">RPS20/50/120</th>
                    <th className="px-1.5 py-1 text-right">风控仓位/共振</th>
                    <th className="px-1.5 py-1 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((row, index) => {
                    const checked = batchSelection.symbols.includes(row.symbol);
                    const disabled = batchFull && !checked;
                    const primary = row.matches[0];
                    const reward = primary?.rewardMultiple ?? null;
                    const volume =
                      primary?.volumeRatio ??
                      row.matches.find((m) => m.volumeRatio != null)
                        ?.volumeRatio ??
                      null;
                    const theoryMatch = rowTheoryMatch(row.matches);
                    const theoryStrategyHint = screenerStrategyHint(
                      theoryMatch?.methodId,
                    );
                    const onlyUnsupportedTheory =
                      row.matches.length > 0 &&
                      row.matches.every(
                        (m) =>
                          m.family === "theory" &&
                          !screenerStrategyHint(m.methodId),
                      );
                    const labHref =
                      visible && run.isSuccess && !onlyUnsupportedTheory
                        ? theoryMatch && theoryStrategyHint
                          ? safeHandoffHref({
                              symbol: row.symbol,
                              frozenDate: row.date,
                              handoffSource: "pattern",
                              strategyHint: theoryStrategyHint,
                              label: matchLabel(theoryMatch),
                              returnTo,
                              scope: "single-symbol-diagnose",
                            })
                          : patternCandidateToLabHref({
                              symbol: row.symbol,
                              frozenDate: row.date,
                              chanCodes: row.matches.flatMap(
                                (m) => m.code ?? [],
                              ),
                              patternKinds: row.matches.flatMap((m) =>
                                m.family === "doubleBreakout"
                                  ? "double-breakout"
                                  : (m.kind ?? []),
                              ),
                              theoryFamilies: row.matches.flatMap(
                                (m) => m.theoryFamily ?? [],
                              ),
                              label: primary ? matchLabel(primary) : undefined,
                              returnTo,
                            })
                        : null;
                    return (
                      <tr
                        key={`${row.symbol}-${row.date}-${index}`}
                        tabIndex={0}
                        role="link"
                        aria-label={`打开 ${row.symbol} ${row.date} 的冻结图表`}
                        className="cursor-pointer border-b border-border/60 hover:bg-muted"
                        onClick={() => open(row, index)}
                        onKeyDown={(event) => {
                          if (
                            event.target === event.currentTarget &&
                            (event.key === "Enter" || event.key === " ")
                          ) {
                            event.preventDefault();
                            open(row, index);
                          }
                        }}
                      >
                        {batchReady && (
                          <td
                            className="px-1.5 py-1"
                            onClick={(event) => event.stopPropagation()}
                            title={
                              disabled
                                ? portfolioHandoffLimitMessage
                                : undefined
                            }
                          >
                            <span className="inline-flex items-center gap-1">
                              <Checkbox
                                aria-label={`选择 ${row.symbol}`}
                                checked={checked}
                                disabled={disabled}
                                onCheckedChange={() =>
                                  batchSelection.toggle(row.symbol)
                                }
                              />
                              {disabled && (
                                <small>{portfolioHandoffLimitMessage}</small>
                              )}
                            </span>
                          </td>
                        )}
                        <td className="px-1.5 py-1">
                          <div className="font-medium">{row.name}</div>
                          <div className="text-muted-foreground tabular">
                            {row.symbol}
                          </div>
                        </td>
                        <td className="px-1.5 py-1 tabular">{row.date}</td>
                        <td
                          className={cn(
                            "px-1.5 py-1 font-medium",
                            row.direction === "long"
                              ? "text-nc-bad"
                              : "text-nc-ok",
                          )}
                        >
                          {row.direction === "long" ? "买点" : "卖点"}
                        </td>
                        <td className="px-1.5 py-1">
                          <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                            {row.matches.map((match, i) => (
                              <span
                                key={`${match.family}-${i}`}
                                title={match.summary}
                                className={cn(
                                  "whitespace-nowrap",
                                  matchColor(match),
                                )}
                              >
                                {matchLabel(match)}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-1.5 py-1 text-right tabular">
                          {priceText(row.signalClose)}
                        </td>
                        <td className="px-1.5 py-1 text-right tabular">
                          {priceText(row.rawClose)}
                        </td>
                        <td className="px-1.5 py-1 text-right tabular">
                          {priceText(row.rawStopPrice)}
                        </td>
                        <td className="px-1.5 py-1 text-right tabular">
                          {priceText(row.rawTargetPrice)}
                        </td>
                        <td className="px-1.5 py-1 text-right tabular">
                          {ratioText(reward)}
                        </td>
                        <td className="px-1.5 py-1 text-right tabular">
                          {ratioText(volume)}
                        </td>
                        <td className="px-1.5 py-1 text-right tabular">
                          {rpsText(row.rps20)} / {rpsText(row.rps50)} /{" "}
                          {rpsText(row.rps120)}
                        </td>
                        <td
                          className="px-1.5 py-1 text-right tabular"
                          title={
                            row.positionPlan?.riskPct == null
                              ? undefined
                              : `止损距离 ${(row.positionPlan.riskPct * 100).toFixed(2)}%`
                          }
                        >
                          {row.positionPlan
                            ? `${row.positionPlan.confluenceGrade}级 · ${row.positionPlan.recommendedShares}股 (${(row.positionPlan.recommendedWeightPct * 100).toFixed(1)}%)`
                            : "—"}
                        </td>
                        <td className="px-1.5 py-1 text-right">
                          {labHref && (
                            <Button asChild size="sm" variant="ghost">
                              <Link
                                href={labHref}
                                prefetch={false}
                                scroll={false}
                                onClick={(event) => event.stopPropagation()}
                              >
                                带入回测
                              </Link>
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            价格口径：信号收盘价为前复权；原价参考、止损位与目标位按信号日原价/前复权比例换算，可执行价仍以原始行情为准。点击任一行打开冻结信号日快照。
          </p>
        </div>
      )}
    </section>
  );
}
