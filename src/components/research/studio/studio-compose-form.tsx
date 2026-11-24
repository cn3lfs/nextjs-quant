import Link from "next/link";
import { useState } from "react";
import { etfRotationConfigSchema } from "trading-strategies";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import {
  alphaStudioHandoffKey,
  parseAlphaStudioHandoff,
} from "~/lib/research/studio-entry";
import {
  researchStudioDraftSchema,
  type ResearchStudioDraftInput,
} from "~/lib/research/studio-result";
import { api } from "~/trpc/react";
import {
  targetSnapshotSchema,
  type TargetSnapshot,
} from "~/lib/research/alpha-experiment";
import { FrozenJson } from "./frozen-json";
import {
  RiskPolicyFields,
  StudioStep,
  type RiskPolicy,
  type StudioCatalog,
} from "./studio-fields";

type DirectDraft = Extract<
  ResearchStudioDraftInput,
  {
    template: "etf-rotation" | "alpha-formula" | "exit-family";
  }
>;
type EtfConfig = ReturnType<typeof etfRotationConfigSchema.parse>;
const defaultAlphaOptions = { topN: 10, every: 5, maxWeight: 0.1 };
const costs = ["fixed", "base", "double-cost"] as const;
const costLabels = {
  fixed: "固定费率",
  base: "历史费税基准",
  "double-cost": "双倍成本",
};
const cut = "2023-01-01";

function alphaEntry(id: string) {
  try {
    return parseAlphaStudioHandoff(
      sessionStorage.getItem(alphaStudioHandoffKey),
      id,
    );
  } catch {
    return null;
  }
}

function draftFields(alphaId: string) {
  const transfer = alphaId ? alphaEntry(alphaId) : null;
  return {
    compositeId: alphaId,
    snapshot: transfer?.targetSnapshot,
    panelId: transfer?.targetSnapshot.panelId ?? "",
    start: transfer?.targetSnapshot.start ?? "",
    end: transfer?.targetSnapshot.end ?? "",
    initial: String(transfer?.initial ?? 1_000_000),
    costScenario:
      transfer?.costScenario ?? ("base" as DirectDraft["costScenario"]),
    targetOptions: transfer?.targetSnapshot.options ?? defaultAlphaOptions,
    holdoutStart: cut,
    universe: "core-12",
    symbols: "",
    family: "ch14-exits",
    riskPolicy: undefined as RiskPolicy | undefined,
    config: etfRotationConfigSchema.parse({ strategyId: "etf-dual-momentum" }),
    executionReality: false,
  };
}

function NumberField({
  label,
  value,
  onChange,
  min = 1,
  max,
  step = 1,
}: {
  label: string;
  value: number | null;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number | "any";
}) {
  return (
    <label className="block text-sm">
      {label}
      <Input
        className="mt-1"
        type="number"
        min={min}
        max={max}
        step={step}
        value={value != null && Number.isFinite(value) ? value : ""}
        onChange={(event) => onChange(event.target.valueAsNumber)}
      />
    </label>
  );
}

function EtfConfigFields({
  config,
  onChange,
}: {
  config: EtfConfig;
  onChange: (config: EtfConfig) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      <label className="block text-sm">
        防守资产
        <select
          className="mt-1 block w-full"
          value={config.defense}
          onChange={(event) =>
            onChange({
              ...config,
              defense: event.target.value === "cash" ? "cash" : "treasury",
            })
          }
        >
          <option value="treasury">国债 ETF</option>
          <option value="cash">现金</option>
        </select>
      </label>
      {config.strategyId !== "etf-risk-budget" ? (
        <>
          <label className="block text-sm">
            调仓周期
            <select
              className="mt-1 block w-full"
              value={config.cadence}
              onChange={(event) =>
                onChange({
                  ...config,
                  cadence:
                    event.target.value === "daily" ? "daily" : "month-end",
                })
              }
            >
              <option value="month-end">月末</option>
              <option value="daily">每日</option>
            </select>
          </label>
          <NumberField
            label="持有 ETF 数"
            value={config.topK}
            max={3}
            onChange={(topK) => onChange({ ...config, topK })}
          />
        </>
      ) : (
        <>
          <label className="block text-sm">
            风险预算模式
            <select
              className="mt-1 block w-full"
              value={config.mode}
              onChange={(event) =>
                onChange({
                  ...config,
                  mode:
                    event.target.value === "static-60-40"
                      ? "static-60-40"
                      : "inverse-vol",
                })
              }
            >
              <option value="inverse-vol">逆波动风险预算</option>
              <option value="static-60-40">固定 60/40</option>
            </select>
          </label>
          <NumberField
            label="波动回看交易日"
            value={config.volatilityWindow}
            min={2}
            onChange={(volatilityWindow) =>
              onChange({ ...config, volatilityWindow })
            }
          />
          <NumberField
            label="趋势回看交易日（可空）"
            value={config.trendWindow}
            onChange={(trendWindow) =>
              onChange({
                ...config,
                trendWindow: Number.isNaN(trendWindow) ? null : trendWindow,
              })
            }
          />
          <NumberField
            label="单只 ETF 权重上限（%）"
            value={config.maxEtfWeight * 100}
            max={100}
            step="any"
            onChange={(weight) =>
              onChange({ ...config, maxEtfWeight: weight / 100 })
            }
          />
        </>
      )}
      {config.strategyId === "etf-dual-momentum" && (
        <>
          <NumberField
            label="动量回看交易日"
            value={config.momentumWindow}
            onChange={(momentumWindow) =>
              onChange({ ...config, momentumWindow })
            }
          />
          <label className="block text-sm">
            轮动子池
            <select
              className="mt-1 block w-full"
              value={config.pool}
              onChange={(event) =>
                onChange({
                  ...config,
                  pool:
                    event.target.value === "legacy-long-history"
                      ? "legacy-long-history"
                      : "full",
                })
              }
            >
              <option value="full">完整子池</option>
              <option value="legacy-long-history">长历史子池</option>
            </select>
          </label>
        </>
      )}
      {config.strategyId === "etf-sector-rotation" && (
        <>
          <NumberField
            label="退出排名缓冲"
            value={config.exitRankBuffer}
            min={0}
            max={11}
            onChange={(exitRankBuffer) =>
              onChange({ ...config, exitRankBuffer })
            }
          />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={config.requirePositiveMomentum}
              onCheckedChange={(value) =>
                onChange({ ...config, requirePositiveMomentum: value === true })
              }
            />
            只选择正动量
          </label>
        </>
      )}
    </div>
  );
}

function AlphaTargets({
  snapshot,
  options,
  onChange,
  onUnfreeze,
}: {
  snapshot: TargetSnapshot | undefined;
  options: typeof defaultAlphaOptions;
  onChange: (options: typeof defaultAlphaOptions) => void;
  onUnfreeze: () => void;
}) {
  return (
    <>
      {snapshot && (
        <div
          className="flex flex-wrap items-center gap-2 text-sm"
          role="status"
        >
          已带入 Alpha 冻结目标 · {snapshot.start} 至 {snapshot.end}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onUnfreeze}
          >
            改用已保存组合重算目标
          </Button>
        </div>
      )}
      <fieldset disabled={!!snapshot} className="grid gap-2 sm:grid-cols-3">
        <NumberField
          label="持仓上限（只）"
          value={options.topN}
          max={500}
          onChange={(topN) => onChange({ ...options, topN })}
        />
        <NumberField
          label="调仓周期（交易日）"
          value={options.every}
          max={250}
          onChange={(every) => onChange({ ...options, every })}
        />
        <NumberField
          label="单票权重上限（%）"
          value={options.maxWeight * 100}
          max={100}
          step="any"
          onChange={(weight) =>
            onChange({ ...options, maxWeight: weight / 100 })
          }
        />
      </fieldset>
    </>
  );
}

export function StudioComposeForm({
  template,
  alphaId,
  active,
  catalog,
  busy,
  rerun,
  onRun,
}: {
  template: DirectDraft["template"];
  alphaId: string | null;
  active: boolean;
  catalog: StudioCatalog | undefined;
  busy: boolean;
  rerun: DirectDraft | null;
  onRun: (input: DirectDraft) => void;
}) {
  const [draft, setDraft] = useState(() => draftFields(alphaId ?? ""));
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [seenAlpha, setSeenAlpha] = useState(alphaId);
  const [seenRerun, setSeenRerun] = useState<DirectDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pendingAlpha, setPendingAlpha] = useState<string | null>(null);
  const [pendingRerun, setPendingRerun] = useState<DirectDraft | null>(null);
  const alpha = template === "alpha-formula";
  const etf = template === "etf-rotation";
  if (alpha && alphaId !== seenAlpha) {
    setSeenAlpha(alphaId);
    if (alphaId) {
      if (dirty) setPendingAlpha(alphaId);
      else setDraft(draftFields(alphaId));
    } else setPendingAlpha(null);
  }
  if (rerun && rerun !== seenRerun && rerun.template === template) {
    setSeenRerun(rerun);
    if (dirty) setPendingRerun(rerun);
    else applyRerun(rerun);
  }

  function applyRerun(rerun: DirectDraft) {
    setError("");
    const common = {
      start: rerun.start,
      end: rerun.end,
      initial: String(rerun.initial),
      costScenario: rerun.costScenario ?? "base",
    };
    if (rerun.template === "etf-rotation") {
      setDraft({
        ...draft,
        ...common,
        config: etfRotationConfigSchema.parse(rerun.config),
        riskPolicy: rerun.riskPolicy,
        executionReality: !!rerun.executionReality,
      });
    } else if (rerun.template === "exit-family") {
      setDraft({
        ...draft,
        ...common,
        family: rerun.family ?? "ch14-exits",
        holdoutStart: rerun.holdoutStart,
        universe:
          typeof rerun.universe === "string" ? rerun.universe : "custom",
        symbols: Array.isArray(rerun.universe) ? rerun.universe.join(", ") : "",
      });
    } else {
      const source = rerun.source;
      if ("snapshot" in source) {
        const parsed = targetSnapshotSchema.safeParse(source.snapshot);
        if (parsed.success) {
          const snapshot = parsed.data;
          setDraft({
            ...draft,
            ...common,
            snapshot,
            panelId: snapshot.panelId,
            targetOptions: snapshot.options,
            riskPolicy: rerun.riskPolicy,
          });
        } else {
          setError("复跑记录中的 Alpha 冻结目标无效。");
          return;
        }
      } else {
        setDraft({
          ...draft,
          ...common,
          snapshot: undefined,
          compositeId: source.compositeId,
          panelId: source.panelId,
          targetOptions: { ...defaultAlphaOptions, ...source.targetOptions },
          riskPolicy: rerun.riskPolicy,
        });
      }
    }
    setPendingAlpha(null);
    setDirty(false);
  }
  const composites = api.alphaComposites.useQuery(
    { limit: 1000 },
    { enabled: alpha && active },
  );
  const saved = api.alphaCompositeGet.useQuery(
    { id: draft.compositeId },
    {
      enabled: alpha && active && !!draft.compositeId,
    },
  );
  const last = saved.data?.latestEvalSummary?.details;
  const change = (patch: Partial<typeof draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setDirty(true);
    setError("");
  };
  const start =
    draft.start || (alpha && typeof last?.start === "string" ? last.start : "");
  const end =
    draft.end || (alpha && typeof last?.end === "string" ? last.end : "");
  const panelId =
    draft.panelId || (typeof last?.panelId === "string" ? last.panelId : "");
  const currentUniverse =
    draft.universe === "core-12" || draft.universe === "core-30-v1"
      ? draft.universe
      : draft.symbols.split(/[\s,，、]+/).filter(Boolean);
  const costScenario =
    (alpha && draft.costScenario === "fixed") ||
    (!alpha && !etf && draft.costScenario === "double-cost")
      ? "base"
      : draft.costScenario;
  const common = { start, end, initial: Number(draft.initial), costScenario };
  const payload = etf
    ? {
        ...common,
        template,
        universe: "etf-21",
        config: draft.config,
        riskPolicy: draft.riskPolicy,
        executionReality: draft.executionReality,
      }
    : alpha
      ? {
          ...common,
          template,
          universe: "alpha-panel",
          riskPolicy: draft.riskPolicy,
          source: draft.snapshot
            ? { snapshot: draft.snapshot }
            : {
                compositeId: draft.compositeId,
                panelId,
                targetOptions: draft.targetOptions,
              },
        }
      : {
          ...common,
          template,
          universe: currentUniverse,
          family: draft.family,
          holdoutStart: draft.holdoutStart,
        };
  const filter = search.trim().toLowerCase();
  const pool = catalog?.pools.find(
    (row) => row.id === (etf ? "etf-21" : draft.universe),
  );
  const family = catalog?.exitFamilies.find((row) => row.id === draft.family);

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        const result = researchStudioDraftSchema.safeParse(payload);
        if (
          draft.universe === "single" &&
          Array.isArray(currentUniverse) &&
          currentUniverse.length !== 1
        )
          setError("单股证券池须填写一个标的。");
        else if (!result.success) {
          const issue = result.error.issues[0];
          setError(
            issue
              ? [issue.path.join("."), issue.message]
                  .filter(Boolean)
                  .join(" · ")
              : "请检查研究参数。",
          );
        } else if (
          result.data.template === "etf-rotation" ||
          result.data.template === "alpha-formula" ||
          result.data.template === "exit-family"
        ) {
          setError("");
          onRun(result.data);
        }
      }}
    >
      {pendingRerun && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-sm text-nc-warn"
        >
          当前编排存在未保存修改，确认覆盖草稿并复跑？
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setPendingRerun(null);
              applyRerun(pendingRerun);
            }}
          >
            确认覆盖草稿
          </Button>
          <Button
            type="button"
            variant="plain"
            onClick={() => setPendingRerun(null)}
          >
            保留草稿
          </Button>
        </div>
      )}
      {pendingAlpha && !pendingRerun && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-sm text-nc-warn"
        >
          当前因子草稿有未保存修改，确认带入另一个组合？
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setDraft(draftFields(pendingAlpha));
              setPendingAlpha(null);
              setDirty(false);
            }}
          >
            确认覆盖因子草稿
          </Button>
          <Button
            type="button"
            variant="plain"
            onClick={() => setPendingAlpha(null)}
          >
            保留因子草稿
          </Button>
        </div>
      )}
      <StudioStep title="2. 策略选择">
        {etf && (
          <>
            <label className="block text-sm">
              ETF 轮动策略
              <select
                className="mt-1 block w-full sm:max-w-md"
                value={draft.config.strategyId}
                onChange={(event) => {
                  const config = etfRotationConfigSchema.safeParse({
                    strategyId: event.target.value,
                  });
                  if (config.success) change({ config: config.data });
                }}
              >
                <optgroup label="ETF 轮动三族">
                  {catalog?.etfStrategies.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  )) ?? <option value="etf-dual-momentum">多资产双动量</option>}
                </optgroup>
              </select>
            </label>
            <EtfConfigFields
              key={draft.config.strategyId}
              config={draft.config}
              onChange={(config) => change({ config })}
            />
          </>
        )}
        {alpha && (
          <>
            <Input
              aria-label="搜索已保存因子组合"
              placeholder="搜索组合名称或编号"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <label className="block text-sm">
              已保存因子组合
              <select
                className="mt-1 block w-full"
                value={draft.compositeId}
                onChange={(event) =>
                  change({
                    compositeId: event.target.value,
                    snapshot: undefined,
                    panelId: "",
                    start: "",
                    end: "",
                    targetOptions: defaultAlphaOptions,
                  })
                }
              >
                <option value="">选择因子组合</option>
                {draft.compositeId &&
                  !composites.data?.items.some(
                    (item) => item.id === draft.compositeId,
                  ) && (
                    <option value={draft.compositeId}>
                      {saved.data?.name ?? draft.compositeId}
                    </option>
                  )}
                <optgroup label="已保存因子组合">
                  {composites.data?.items
                    .filter(
                      (row) =>
                        row.id === draft.compositeId ||
                        (row.name + " " + row.id)
                          .toLowerCase()
                          .includes(filter),
                    )
                    .map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.name}
                      </option>
                    ))}
                </optgroup>
              </select>
            </label>
            {saved.data && (
              <p className="text-sm text-nc-text-3">
                {saved.data.config.factors
                  .map((factor) => factor.factorId)
                  .join("、")}
              </p>
            )}
            {(composites.error || saved.error) && (
              <p role="alert" className="text-sm text-nc-warn">
                {composites.error?.message ?? saved.error?.message}
              </p>
            )}
            {draft.compositeId &&
              saved.isSuccess &&
              !saved.data &&
              !draft.snapshot && <p role="alert">找不到已保存的因子组合。</p>}
            <AlphaTargets
              snapshot={draft.snapshot}
              options={draft.targetOptions}
              onChange={(targetOptions) => change({ targetOptions })}
              onUnfreeze={() => change({ snapshot: undefined })}
            />
            {!draft.snapshot && (
              <Link href="/lab/analysis" className="text-sm underline">
                在 Alpha 实验室评估并冻结目标
              </Link>
            )}
          </>
        )}
        {!alpha && !etf && (
          <>
            <label className="block text-sm">
              退出策略家族
              <select
                className="mt-1 block w-full sm:max-w-md"
                value={draft.family}
                onChange={(event) => change({ family: event.target.value })}
              >
                {(catalog?.exitFamilies ?? [{ id: "ch14-exits" }]).map(
                  (row) => (
                    <option key={row.id} value={row.id}>
                      {row.id}
                    </option>
                  ),
                )}
              </select>
            </label>
            <p className="text-sm text-nc-warn">
              PBO
              每次仅检验一个同族候选集合。候选共用冻结行情与留出切点，跨族策略须分别运行。
            </p>
            {family && (
              <p className="text-sm text-nc-text-3">
                {family.members.join("、")}
              </p>
            )}
          </>
        )}
      </StudioStep>
      <StudioStep title="3. 证券池与历史区间">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {etf ? (
            <p className="text-sm">证券池 · ETF 21 池</p>
          ) : alpha ? (
            <label className="block text-sm">
              冻结行情面板 ID
              <Input
                className="mt-1"
                value={panelId}
                readOnly={!!draft.snapshot}
                pattern="[a-f0-9]{64}"
                required
                onChange={(event) => change({ panelId: event.target.value })}
              />
            </label>
          ) : (
            <label className="block text-sm">
              证券池
              <select
                className="mt-1 block w-full"
                value={draft.universe}
                onChange={(event) => change({ universe: event.target.value })}
              >
                <option value="core-12">core-12</option>
                <option value="core-30-v1">core-30-v1</option>
                <option value="single">单股</option>
                <option value="custom">自定义（1–12 股）</option>
              </select>
            </label>
          )}
          {Array.isArray(currentUniverse) && !alpha && !etf && (
            <label className="block text-sm">
              标的代码
              <Input
                className="mt-1"
                value={draft.symbols}
                placeholder="sh600000, sz000001"
                onChange={(event) => change({ symbols: event.target.value })}
              />
            </label>
          )}
          <label className="block text-sm">
            开始日期
            <Input
              className="mt-1"
              type="date"
              value={start}
              readOnly={!!draft.snapshot}
              required
              onChange={(event) => change({ start: event.target.value })}
            />
          </label>
          <label className="block text-sm">
            结束日期
            <Input
              className="mt-1"
              type="date"
              value={end}
              readOnly={!!draft.snapshot}
              required
              onChange={(event) => change({ end: event.target.value })}
            />
          </label>
          {!alpha && !etf && (
            <label className="block text-sm">
              留出切点
              <Input
                className="mt-1"
                type="date"
                required
                value={draft.holdoutStart}
                onChange={(event) =>
                  change({ holdoutStart: event.target.value })
                }
              />
            </label>
          )}
        </div>
        {pool && <p className="text-xs text-nc-text-3">{pool.disclosure}</p>}
      </StudioStep>
      <StudioStep title="4. 本金与账户风控">
        <label className="block max-w-xs text-sm">
          期初资金（元）
          <Input
            className="mt-1"
            type="number"
            min={1}
            max={1e9}
            step="any"
            required
            value={draft.initial}
            onChange={(event) => change({ initial: event.target.value })}
          />
        </label>
        {(etf || alpha) && (
          <RiskPolicyFields
            value={draft.riskPolicy}
            onChange={(riskPolicy) => change({ riskPolicy })}
          />
        )}
      </StudioStep>
      <StudioStep title="5. 成本与执行">
        <label className="block max-w-xs text-sm">
          成本情景
          <select
            className="mt-1 block w-full"
            value={costScenario}
            onChange={(event) => {
              const value = costs.find((cost) => cost === event.target.value);
              if (value) change({ costScenario: value });
            }}
          >
            {costs
              .filter(
                (cost) =>
                  !(alpha && cost === "fixed") &&
                  !(!alpha && !etf && cost === "double-cost"),
              )
              .map((cost) => (
                <option key={cost} value={cost}>
                  {cost} · {costLabels[cost]}
                </option>
              ))}
          </select>
        </label>
        {etf && (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={draft.executionReality}
              onCheckedChange={(value) =>
                change({ executionReality: value === true })
              }
            />
            启用九格执行现实（本金 × 5m 执行窗口）
          </label>
        )}
        <FrozenJson value={payload} />
      </StudioStep>
      {error && (
        <p role="alert" className="text-sm text-nc-warn">
          {error}
        </p>
      )}
      <Button
        type="submit"
        disabled={busy || (alpha && !draft.snapshot && !saved.data)}
        aria-busy={busy}
      >
        {busy ? "研究回测运行中…" : "运行研究回测"}
      </Button>
    </form>
  );
}
