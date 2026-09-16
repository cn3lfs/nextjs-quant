import type { ResearchSpec } from "~/lib/strategy-research";
import type { ResearchManagement } from "~/lib/research-management";
import {
  riskRouteSchema,
  riskRouteNames,
  resolveRiskRoute,
  riskRoutingBoundary,
  stopDiagnosisSchema,
  diagnoseStops,
  diagnosisTemplate,
  stopDiagnosisBoundary,
  type RiskRoute,
} from "~/lib/research-risk-routing";
import {
  riskRepairSchema,
  riskRepairTemplate,
  riskRepairBoundary,
} from "~/lib/research-risk-repair";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
export function ResearchRiskCompositionFields({
  spec,
  onChange,
  apply,
}: {
  spec: ResearchSpec;
  onChange: (s: ResearchSpec) => void;
  apply: (s: ResearchSpec, m: ResearchManagement) => ResearchSpec;
}) {
  return (
    <section className="space-y-3 text-sm">
      <p>组合、场景路由与持仓修复</p>
      <div className="flex flex-wrap gap-2">
        {Object.entries(riskRouteNames).flatMap(([scenario, label]) =>
          (["primary", "alternative"] as const)
            .filter(
              (branch) =>
                branch === "primary" ||
                !["unmonitored", "records100"].includes(scenario),
            )
            .map((branch) => (
              <Button
                type="button"
                variant="outline"
                key={`${scenario}-${branch}`}
                onClick={() => {
                  const route: RiskRoute = riskRouteSchema.parse({
                    version: "risk-route-v1",
                    provenance: "manual-scenario",
                    knownOn: spec.start,
                    scenario,
                    branch,
                  });
                  const resolved = resolveRiskRoute(route);
                  const {
                    stopDiagnosis: _d,
                    riskRoute: _r,
                    riskExtension: _e,
                    management: _m,
                    ...base
                  } = spec;
                  const next = resolved.management
                    ? apply(
                        {
                          ...base,
                          strategy: "dual-breakout",
                          risk: { fraction: 0.01, maxWeight: 0.2 },
                          holdingDays: 60,
                        },
                        resolved.management,
                      )
                    : { ...base, riskExtension: resolved.extension! };
                  onChange({ ...next, riskRoute: route });
                }}
              >
                路由{label}·{branch === "primary" ? "首选" : "备选"}
              </Button>
            )),
        )}
      </div>
      {spec.riskRoute && (
        <>
          <p data-testid="risk-route" className="break-all">
            {JSON.stringify(spec.riskRoute)} {riskRoutingBoundary}
          </p>
          <Button
            variant="outline"
            type="button"
            onClick={() => {
              const { riskRoute: _r, ...next } = spec;
              onChange(next);
            }}
          >
            解除路由
          </Button>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        {(["timing-v1", "atr-resize-v1", "naive-3-to-8-control"] as const).map(
          (variant) => (
            <Button
              type="button"
              variant="outline"
              key={variant}
              onClick={() => {
                const { riskRoute: _r, riskExtension: _e, ...base } = spec;
                onChange({
                  ...apply(
                    {
                      ...base,
                      strategy: "dual-breakout",
                      risk: { fraction: 0.01, maxWeight: 0.2 },
                      holdingDays: 60,
                    },
                    diagnosisTemplate(),
                  ),
                  stopDiagnosis: {
                    version: "stop-diagnosis-v1",
                    provenance: "manual-scenario",
                    cutoff: spec.validationStart,
                    variant,
                    records: [],
                  },
                });
              }}
            >
              诊断
              {
                {
                  "timing-v1": "入场时机修正",
                  "atr-resize-v1": "ATR校准并缩放仓位",
                  "naive-3-to-8-control": "3%放宽8%不缩股反例",
                }[variant]
              }
            </Button>
          ),
        )}
      </div>
      {spec.stopDiagnosis && (
        <label className="block">
          开发段诊断记录（缺失时不可执行）
          <Textarea
            aria-label="开发段诊断记录"
            key={JSON.stringify(spec.stopDiagnosis)}
            defaultValue={JSON.stringify(spec.stopDiagnosis, null, 2)}
            onBlur={(e) => {
              try {
                const stopDiagnosis = stopDiagnosisSchema.parse(
                  JSON.parse(e.currentTarget.value),
                );
                e.currentTarget.setCustomValidity("");
                onChange({ ...spec, stopDiagnosis });
              } catch {
                e.currentTarget.setCustomValidity("诊断输入非法");
                e.currentTarget.reportValidity();
              }
            }}
          />
          <span className="block break-all">
            {JSON.stringify(diagnoseStops(spec.stopDiagnosis))}
          </span>
          <span>{stopDiagnosisBoundary}</span>
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        {(
          ["cycle-switch", "add-raise", "add-reduce", "held-reduce"] as const
        ).map((kind) => (
          <Button
            type="button"
            variant="outline"
            key={kind}
            onClick={() =>
              onChange({ ...spec, riskRepair: riskRepairTemplate(kind) })
            }
          >
            修复
            {
              {
                "cycle-switch": "预定换周期",
                "add-raise": "加仓后抬线",
                "add-reduce": "加仓后减仓",
                "held-reduce": "既有持仓减仓",
              }[kind]
            }
          </Button>
        ))}
      </div>
      {spec.riskRepair && (
        <>
          <label className="block">
            预登记持仓情景（请填写真实研究日期与成本）
            <Textarea
              aria-label="预登记持仓情景"
              key={JSON.stringify(spec.riskRepair)}
              defaultValue={JSON.stringify(spec.riskRepair, null, 2)}
              onBlur={(e) => {
                try {
                  const riskRepair = riskRepairSchema.parse(
                    JSON.parse(e.currentTarget.value),
                  );
                  e.currentTarget.setCustomValidity("");
                  onChange({ ...spec, riskRepair });
                } catch {
                  e.currentTarget.setCustomValidity("修复情景非法或事后预案");
                  e.currentTarget.reportValidity();
                }
              }}
            />
            <span>{riskRepairBoundary}</span>
          </label>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              const { riskRepair: _r, ...next } = spec;
              onChange(next);
            }}
          >
            移除修复情景
          </Button>
        </>
      )}
    </section>
  );
}
