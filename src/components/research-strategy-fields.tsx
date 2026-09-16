import { maParamsSchema } from "~/lib/domain";
import type { ResearchSpec } from "~/lib/strategy-research";
import {
  researchRiskSchema,
  researchStrategies,
  researchStrategyIds,
  researchStrategySchema,
} from "~/lib/research-strategies";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { ResearchManagementFields } from "./research-management-fields";
import { researchManagementSchema } from "~/lib/research-management";
import type { ResearchManagement } from "~/lib/research-management";
import { isCanslimProgressPreset } from "~/lib/research-exit-presets";
import { isCanslimResearch } from "~/lib/research-canslim-strategies";
import { canslimRiskTemplate } from "~/lib/research-canslim-management";
import {
  growthDailyExitTemplate,
  isGrowthDailyExit,
} from "~/lib/research-growth-exits";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./ui/select";

export function applyResearchManagement(
  spec: ResearchSpec,
  management: ResearchManagement,
): ResearchSpec {
  const selected = management.exitPreset;
  return {
    ...spec,
    management,
    holdingDays:
      selected &&
      (isCanslimProgressPreset(selected) ||
        selected.startsWith("sepa-time4")) &&
      selected !== spec.management?.exitPreset
        ? Math.max(60, spec.holdingDays)
        : spec.holdingDays,
  };
}

export function selectResearchStrategy(
  spec: ResearchSpec,
  raw: string,
): ResearchSpec {
  const strategy = researchStrategySchema.parse(raw);
  const { maParams, risk, management: originalManagement, ...shared } = spec;
  let management =
    originalManagement?.pyramid?.kind === "pullback-50-50" &&
    strategy !== "dual-breakout"
      ? (({ pyramid: _pyramid, ...rest }) => rest)(originalManagement)
      : originalManagement;
  if (management?.sepaElite && !strategy.startsWith("sepa-")) {
    const { sepaElite: _elite, ...rest } = management;
    management = rest;
  }
  if (
    (management?.kelly?.provenance === "breakout-quality" ||
      management?.kelly?.provenance === "rolling-switch30") &&
    strategy !== "dual-breakout"
  ) {
    const { kelly: _kelly, ...rest } = management;
    management = rest;
  }
  const selected: ResearchSpec = {
    ...shared,
    strategy,
    ...(strategy === "canslim-priority-weekly10-half" &&
    strategy !== spec.strategy
      ? { holdingDays: 60 }
      : {}),
    ...(strategy === "ma-cross"
      ? { maParams: maParams ?? maParamsSchema.parse({}) }
      : {}),
    ...(strategy === "dual-breakout-structure" || !!management
      ? { risk: risk ?? researchRiskSchema.parse({}) }
      : {}),
    ...(management && strategy !== "dual-breakout-structure"
      ? {
          management:
            (management.stop.kind === "structure" ||
              management.stop.kind === "structure-atr" ||
              management.stop.kind === "max-distance" ||
              management.stop.kind === "nearest-stop" ||
              management.stop.kind === "structure-auto" ||
              management.stop.kind === "breakout-candle" ||
              management.stop.kind === "platform-upper") &&
            strategy !== "dual-breakout"
              ? {
                  ...management,
                  stop: { kind: "percent" as const, fraction: 0.05 },
                }
              : management,
        }
      : {}),
  };
  return isGrowthDailyExit(strategy) && strategy !== spec.strategy
    ? growthDailyExitTemplate(selected)
    : selected;
}

export function ResearchStrategyFields({
  spec,
  onChange,
}: {
  spec: ResearchSpec;
  onChange: (value: ResearchSpec) => void;
}) {
  const definition = researchStrategies[spec.strategy];
  return (
    <>
      <label>
        策略
        <Select
          value={spec.strategy}
          onValueChange={(value) =>
            onChange(selectResearchStrategy(spec, value))
          }
        >
          <SelectTrigger
            aria-label="研究策略"
            className="w-full min-w-0 max-w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {researchStrategyIds.map((id) => (
              <SelectItem key={id} value={id}>
                {researchStrategies[id].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <p className="text-sm text-muted-foreground">
        {spec.management
          ? definition.signal === "technical"
            ? `${definition.description}组合风控追加风险仓位与止损，指标退出继续有效。`
            : `${definition.label}的信号保持不变；交易部分使用下方组合风控，替代资金均分和仅固定持有退出。`
          : definition.description}
      </p>
      {spec.strategy !== "dual-breakout-structure" && (
        <label>
          交易风控
          <Select
            value={spec.management ? "managed" : "fixed"}
            onValueChange={(value) => {
              const { management: _management, risk: _risk, ...base } = spec;
              onChange(
                value === "managed"
                  ? {
                      ...base,
                      management: researchManagementSchema.parse({}),
                      risk: researchRiskSchema.parse({}),
                    }
                  : base,
              );
            }}
          >
            <SelectTrigger aria-label="交易风控">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fixed">
                {definition.signal === "technical"
                  ? "指标退出与最长持有期"
                  : "基础策略固定持有"}
              </SelectItem>
              <SelectItem value="managed">组合止损与风险仓位</SelectItem>
            </SelectContent>
          </Select>
        </label>
      )}
      {isCanslimResearch(spec.strategy) && (
        <Button
          type="button"
          variant="outline"
          className="h-auto w-full whitespace-normal"
          onClick={() => onChange(canslimRiskTemplate(spec))}
        >
          应用CANSLIM 1.5%风险、25%单股及8%止损模板
        </Button>
      )}
      {spec.management && (
        <ResearchManagementFields
          value={spec.management}
          onChange={(management) =>
            onChange(applyResearchManagement(spec, management))
          }
          allowStructure={spec.strategy === "dual-breakout"}
        />
      )}
      {spec.management?.exitPreset &&
        isCanslimProgressPreset(spec.management.exitPreset) && (
          <p className="text-sm text-muted-foreground">
            切换至四周检查预设时，最长持有期至少设为60个交易日；当前为
            {spec.holdingDays}
            日，可独立调整。提前退出或研究期不足时不会补造四周检查。
          </p>
        )}
      {spec.management && (
        <Button
          type="button"
          variant="outline"
          className="h-auto w-full whitespace-normal"
          onClick={() => onChange(swingPositionTemplate(spec))}
        >
          应用波段2%风险、30%单股、3只与60%总仓模板
        </Button>
      )}
      {spec.strategy === "ma-cross" &&
        spec.maParams &&
        (
          [
            ["fast", "短均线天数"],
            ["slow", "长均线天数"],
            ["minChange", "最低日涨幅（%）"],
            ["maxChange", "最高日涨幅（%）"],
            ["minVolumeRatio", "最低量比（前5根均量）"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <Input
              aria-label={label}
              type="number"
              value={spec.maParams![key]}
              onChange={(event) =>
                onChange({
                  ...spec,
                  maParams: {
                    ...spec.maParams!,
                    [key]: event.target.valueAsNumber,
                  },
                })
              }
            />
          </label>
        ))}
      {spec.risk &&
        (
          [
            ["fraction", "单笔计划风险（%权益）"],
            ["maxWeight", "单股市值上限（%权益）"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <Input
              aria-label={label}
              type="number"
              step="0.1"
              value={spec.risk![key] * 100}
              onChange={(event) =>
                onChange({
                  ...spec,
                  risk: {
                    ...spec.risk!,
                    [key]: event.target.valueAsNumber / 100,
                  },
                })
              }
            />
          </label>
        ))}
      {spec.strategy === "dual-breakout-structure" && (
        <p className="text-sm text-muted-foreground">
          持有交易日同时作为最长持有期。结构位不向下移动；跳空和无法成交可能使实际亏损超过计划风险。
        </p>
      )}
    </>
  );
}

export function swingPositionTemplate(spec: ResearchSpec): ResearchSpec {
  return {
    ...spec,
    risk: { fraction: 0.02, maxWeight: 0.3 },
    maxPositions: 3,
    management: {
      ...(spec.management ?? researchManagementSchema.parse({})),
      maxInitialStopDistance: 0.05,
      maxTotalWeight: 0.6,
    },
  };
}
