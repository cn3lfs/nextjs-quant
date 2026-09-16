import { isWyckoffVsa, wyckoffInputsSchema } from "~/lib/research-wyckoff-vsa";
import { ResearchRiskCompositionFields } from "./research-risk-composition-fields";
import {
  riskExtensionSchema,
  riskExtensionTemplate,
  evaluateRiskExtension,
  riskExtensionBoundary,
} from "~/lib/research-risk-extensions";
import { Textarea } from "./ui/textarea";
import { contextRiskMaxPositions } from "~/lib/research-context-risk";
import {
  riskPresetParameters,
  riskPresetBase,
} from "~/lib/research-risk-presets";
import { growthIntradayBase } from "~/lib/research-growth-intraday";
import { growthDailyBase } from "~/lib/research-growth-daily";
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
  const next: ResearchSpec = {
    ...spec,
    riskRoute: undefined,
    stopDiagnosis: undefined,
    management,
    ...(management.contextRisk
      ? {
          strategy: "dual-breakout" as const,
          maParams: undefined,
          risk: { fraction: 0.02, maxWeight: 0.2 },
          maxPositions: contextRiskMaxPositions(management.contextRisk),
        }
      : {}),
    ...(management.riskPreset
      ? {
          strategy: riskPresetBase(management.riskPreset),
          maParams: undefined,
          risk: {
            fraction: riskPresetParameters(management.riskPreset).fraction,
            maxWeight: riskPresetParameters(management.riskPreset).maxWeight,
          },
        }
      : {}),
    ...(management.volatilityStop
      ? {
          strategy: "dual-breakout" as const,
          maParams: undefined,
          risk: { fraction: 0.01, maxWeight: 0.2 },
        }
      : {}),
    ...(management.swingDiscipline
      ? {
          strategy: "dual-breakout" as const,
          maParams: undefined,
          risk: { fraction: 0.03, maxWeight: 0.2 },
          maxPositions: 3,
        }
      : {}),
    ...(management.growthIntraday
      ? {
          strategy: growthIntradayBase(management.growthIntraday),
          ...(management.growthIntraday === "RK-C-swing-system"
            ? { risk: { fraction: 0.01, maxWeight: 0.2 }, holdingDays: 60 }
            : {}),
          maParams: undefined,
        }
      : {}),
    ...(management.growthDaily
      ? {
          strategy: growthDailyBase(management.growthDaily),
          maParams: undefined,
          risk: {
            fraction: management.growthDaily === "SE-P-standard" ? 0.02 : 0.015,
            maxWeight: management.growthDaily === "SE-P-standard" ? 0.3 : 0.25,
          },
          maxPositions: management.growthDaily === "SE-P-standard" ? 8 : 5,
        }
      : {}),
    holdingDays:
      management.contextRisk ||
      management.growthIntraday === "RK-C-swing-system" ||
      management.growthDaily ||
      management.volatilityStop ||
      management.riskPreset
        ? 60
        : selected &&
            (isCanslimProgressPreset(selected) ||
              selected.startsWith("sepa-time4")) &&
            selected !== spec.management?.exitPreset
          ? Math.max(60, spec.holdingDays)
          : spec.holdingDays,
  };
  if (!isWyckoffVsa(next.strategy)) delete next.wyckoffInputs;
  return next;
}

export function selectResearchStrategy(
  spec: ResearchSpec,
  raw: string,
): ResearchSpec {
  const strategy = researchStrategySchema.parse(raw);
  const {
    maParams,
    risk,
    wyckoffInputs,
    management: originalManagement,
    ...shared
  } = spec;
  let management =
    originalManagement?.pyramid?.kind === "pullback-50-50" &&
    strategy !== "dual-breakout"
      ? (({ pyramid: _pyramid, ...rest }) => rest)(originalManagement)
      : originalManagement;
  if (management?.contextRisk && strategy !== "dual-breakout") {
    const {
      contextRisk: _id,
      contextRiskInputs: _inputs,
      ...rest
    } = management;
    management = rest;
  }
  if (
    management?.riskPreset &&
    strategy !== riskPresetBase(management.riskPreset)
  ) {
    const { riskPreset: _riskPreset, ...rest } = management;
    management = rest;
  }
  if (management?.swingDiscipline && strategy !== "dual-breakout") {
    const { swingDiscipline: _swing, ...rest } = management;
    management = rest;
  }
  if (management?.volatilityStop && strategy !== "dual-breakout") {
    const {
      volatilityStop: _volatilityStop,
      volatilityInputs: _volatilityInputs,
      ...rest
    } = management;
    management = rest;
  }
  if (management?.sepaElite && !strategy.startsWith("sepa-")) {
    const { sepaElite: _elite, ...rest } = management;
    management = rest;
  }
  if (
    management?.growthIntraday &&
    strategy !== growthIntradayBase(management.growthIntraday)
  ) {
    const {
      growthIntraday: _intraday,
      openingPlans: _plans,
      marketAdmissionInputs: _admission,
      intradayExecutionInputs: _execution,
      ...rest
    } = management;
    management = rest;
  }
  if (
    management?.growthDaily &&
    strategy !== growthDailyBase(management.growthDaily)
  ) {
    const { growthDaily: _daily, ...rest } = management;
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
    ...(isWyckoffVsa(strategy) && wyckoffInputs ? { wyckoffInputs } : {}),
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
      {isWyckoffVsa(spec.strategy) && (
        <label className="min-w-0 break-words [overflow-wrap:anywhere]">
          VSA 历史排除与市值证据（JSON；缺失时不可用）
          <Textarea
            aria-label="VSA历史证据"
            className="w-full min-w-0"
            key={`${spec.strategy}:${JSON.stringify(spec.wyckoffInputs ?? [])}`}
            defaultValue={JSON.stringify(spec.wyckoffInputs ?? [], null, 2)}
            onBlur={(event) => {
              try {
                const rows = wyckoffInputsSchema.parse(
                  JSON.parse(event.currentTarget.value),
                );
                event.currentTarget.setCustomValidity("");
                onChange({ ...spec, wyckoffInputs: rows });
              } catch {
                event.currentTarget.setCustomValidity(
                  "请输入有效的逐证券逐日VSA证据",
                );
                event.currentTarget.reportValidity();
                const { wyckoffInputs: _rows, ...rest } = spec;
                onChange(rest);
              }
            }}
          />
          <span className="text-xs text-muted-foreground">
            每行含
            symbol、date、availableAt（北京时间）、source、limit、corporateAction、openingCrash、specialDate、marketCapYuan；未知不可填
            false。
          </span>
        </label>
      )}
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
      <label>
        期权/做空扩展计算（不进入A股成交与净值）
        <Select
          value={spec.riskExtension?.kind ?? "off"}
          onValueChange={(kind) => {
            const { riskExtension: _old, ...rest } = spec;
            onChange(
              kind === "off"
                ? rest
                : {
                    ...rest,
                    riskExtension: riskExtensionTemplate(
                      kind as "protective-put" | "collar" | "short-script",
                    ),
                  },
            );
          }}
        >
          <SelectTrigger aria-label="期权做空扩展">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off">关闭扩展</SelectItem>
            <SelectItem value="protective-put">保护性看跌到期情景</SelectItem>
            <SelectItem value="collar">领口到期情景</SelectItem>
            <SelectItem value="short-script">做空脚本诊断（扩展）</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <ResearchRiskCompositionFields
        spec={spec}
        onChange={onChange}
        apply={applyResearchManagement}
      />
      {spec.riskExtension && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {riskExtensionBoundary}
          </p>
          <Textarea
            aria-label="扩展固定情景JSON"
            key={JSON.stringify(spec.riskExtension)}
            defaultValue={JSON.stringify(spec.riskExtension, null, 2)}
            onBlur={(event) => {
              try {
                const value = riskExtensionSchema.parse(
                  JSON.parse(event.currentTarget.value),
                );
                event.currentTarget.setCustomValidity("");
                onChange({ ...spec, riskExtension: value });
              } catch {
                event.currentTarget.setCustomValidity(
                  "扩展情景参数无效，请核对合约覆盖、价格与单位",
                );
                event.currentTarget.reportValidity();
              }
            }}
          />
          <pre
            className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs"
            aria-label="扩展情景结果"
          >
            {JSON.stringify(evaluateRiskExtension(spec.riskExtension), null, 2)}
          </pre>
        </div>
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
