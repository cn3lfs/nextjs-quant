import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  deployableStrategySpecSchema,
  deploymentMarkets,
  deploymentProvenanceSchema,
  deploymentRiskPolicySchema,
  deploymentScheduleSchema,
  deploymentStatuses,
  executionModes,
  isExecutionModeCompatibleWithVenue,
  isVenueCompatibleWithMarket,
  poolPolicySchema,
  regimeGateSpecSchema,
  universeSpecSchema,
  venueBindingSchema,
  type DeploymentStatus,
  type ExecutionMode,
} from "trading-strategies";
import { z } from "zod";
import { sqlite } from "./index";
import { appendExecutionAuditEvent } from "./execution-audit";

const idSchema = z.string().trim().min(1);
const timestampSchema = z.number().int().safe().nonnegative();
const marketSchema = z.enum(deploymentMarkets);
const statusSchema = z.enum(deploymentStatuses);
const executionModeSchema = z.enum(executionModes);

const configSchema = z
  .object({
    name: z.string().trim().min(1),
    strategySpec: deployableStrategySpecSchema,
    universeSpec: universeSpecSchema,
    regimeGate: regimeGateSpecSchema,
    riskPolicy: deploymentRiskPolicySchema,
    venueBinding: venueBindingSchema,
    poolPolicy: poolPolicySchema,
    schedule: deploymentScheduleSchema,
    provenance: deploymentProvenanceSchema,
  })
  .strict();
const createSchema = configSchema.extend({
  id: idSchema.optional(),
  market: marketSchema,
  status: z.enum(["draft", "active"]).default("draft"),
  executionMode: executionModeSchema.default("shadow"),
  poolPolicy: poolPolicySchema.default({}),
});
const deploymentSchema = configSchema.extend({
  id: idSchema,
  market: marketSchema,
  status: statusSchema,
  executionMode: executionModeSchema,
  pauseReason: z.string().nullable(),
  consecutiveFailures: z.number().int().safe().nonnegative(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
const configPatchSchema = configSchema.partial();

export type CreateDeploymentInput = z.input<typeof createSchema>;
export type DeploymentConfigPatch = z.input<typeof configPatchSchema>;
export type DeploymentRecord = z.infer<typeof deploymentSchema>;

export const pipelineGlobalConfigSchema = z
  .object({
    autoSimEnabled: z.boolean().default(false),
    autoLiveEnabled: z.boolean().default(false),
    updatedAt: timestampSchema.nullable().default(null),
    updatedBy: idSchema.optional(),
  })
  .strict()
  .transform(({ autoSimEnabled, autoLiveEnabled, updatedAt }) => ({
    autoSimEnabled,
    autoLiveEnabled,
    updatedAt,
  }));
export type PipelineGlobalConfig = z.infer<typeof pipelineGlobalConfigSchema>;
const globalConfigKey = "pipeline-global-config";

export function getPipelineGlobalConfig(
  connection: Database.Database = sqlite(),
): PipelineGlobalConfig {
  const row = connection
    .prepare<[string], { payload: string }>(
      "SELECT payload FROM records WHERE id=?",
    )
    .get(globalConfigKey);
  return pipelineGlobalConfigSchema.parse(row ? JSON.parse(row.payload) : {});
}

function setPipelineGlobalSwitch(
  key: "autoSimEnabled" | "autoLiveEnabled",
  enabled: boolean,
  connection: Database.Database,
): PipelineGlobalConfig {
  const value = z.boolean().parse(enabled);
  return connection
    .transaction(() => {
      const config = {
        ...getPipelineGlobalConfig(connection),
        [key]: value,
        updatedAt: Date.now(),
      };
      connection
        .prepare(
          `INSERT INTO records (id,kind,payload,updated_at)
         VALUES (@key,@key,@payload,@updatedAt)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,
           payload=excluded.payload,updated_at=excluded.updated_at`,
        )
        .run({
          key: globalConfigKey,
          payload: JSON.stringify(config),
          updatedAt: config.updatedAt,
        });
      return config;
    })
    .immediate();
}

export function setGlobalAutoSimEnabled(
  enabled: boolean,
  connection: Database.Database = sqlite(),
) {
  return setPipelineGlobalSwitch("autoSimEnabled", enabled, connection);
}

export function setGlobalAutoLiveEnabled(
  enabled: boolean,
  connection: Database.Database = sqlite(),
) {
  return setPipelineGlobalSwitch("autoLiveEnabled", enabled, connection);
}

export { setGlobalAutoSimEnabled as setPipelineGlobalConfig };

type DeploymentConfig = z.infer<typeof configSchema>;
function encodeConfig(config: DeploymentConfig) {
  return {
    name: config.name,
    strategySpecJson: JSON.stringify(config.strategySpec),
    universeSpecJson: JSON.stringify(config.universeSpec),
    regimeGateJson: JSON.stringify(config.regimeGate),
    riskPolicyJson: JSON.stringify(config.riskPolicy),
    venueBindingJson: JSON.stringify(config.venueBinding),
    poolPolicyJson: JSON.stringify(config.poolPolicy),
    scheduleJson: JSON.stringify(config.schedule),
    provenanceJson: JSON.stringify(config.provenance),
  };
}

type DeploymentRow = Omit<DeploymentRecord, keyof DeploymentConfig> &
  ReturnType<typeof encodeConfig>;
const columns = `id,name,market,status,execution_mode AS executionMode,
  strategy_spec_json AS strategySpecJson,universe_spec_json AS universeSpecJson,
  regime_gate_json AS regimeGateJson,risk_policy_json AS riskPolicyJson,
  venue_binding_json AS venueBindingJson,schedule_json AS scheduleJson,
  pool_policy_json AS poolPolicyJson,
  provenance_json AS provenanceJson,pause_reason AS pauseReason,
  consecutive_failures AS consecutiveFailures,created_at AS createdAt,
  updated_at AS updatedAt`;

function decodeDeployment({
  strategySpecJson,
  universeSpecJson,
  regimeGateJson,
  riskPolicyJson,
  venueBindingJson,
  poolPolicyJson,
  scheduleJson,
  provenanceJson,
  ...row
}: DeploymentRow) {
  return deploymentSchema.parse({
    ...row,
    strategySpec: JSON.parse(strategySpecJson),
    universeSpec: JSON.parse(universeSpecJson),
    regimeGate: JSON.parse(regimeGateJson),
    riskPolicy: JSON.parse(riskPolicyJson),
    venueBinding: JSON.parse(venueBindingJson),
    poolPolicy: JSON.parse(poolPolicyJson),
    schedule: JSON.parse(scheduleJson),
    provenance: JSON.parse(provenanceJson),
  });
}

function assertCompatibleVenue({
  market,
  executionMode,
  venueBinding,
}: Pick<DeploymentRecord, "market" | "executionMode" | "venueBinding">) {
  const venue = venueBinding.kind;
  if (!isVenueCompatibleWithMarket(market, venue)) {
    throw new Error(`部署市场与交易通道不匹配：${market} / ${venue}`);
  }
  if (!isExecutionModeCompatibleWithVenue(executionMode, venue)) {
    throw new Error(
      `部署执行模式与交易通道不匹配：${executionMode} / ${venue}`,
    );
  }
}

export function createDeployment(
  raw: CreateDeploymentInput,
  connection: Database.Database = sqlite(),
) {
  const input = createSchema.parse(raw);
  assertCompatibleVenue(input);
  const id = input.id ?? randomUUID();
  return connection
    .transaction(() => {
      const now = Date.now();
      const row = connection
        .prepare<object, DeploymentRow>(
          `INSERT INTO strategy_deployments (
          id,name,market,status,execution_mode,strategy_spec_json,
          universe_spec_json,regime_gate_json,risk_policy_json,venue_binding_json,
          pool_policy_json,schedule_json,provenance_json,created_at,updated_at
        ) VALUES (
          @id,@name,@market,@status,@executionMode,@strategySpecJson,
          @universeSpecJson,@regimeGateJson,@riskPolicyJson,@venueBindingJson,
          @poolPolicyJson,@scheduleJson,@provenanceJson,@now,@now
        ) RETURNING ${columns}`,
        )
        .get({ ...input, ...encodeConfig(input), id, now })!;
      appendExecutionAuditEvent(
        {
          deploymentId: id,
          eventType: "deployment_created",
          details: { status: input.status, executionMode: input.executionMode },
          createdAt: now,
        },
        connection,
      );
      return decodeDeployment(row);
    })
    .immediate();
}

export function getDeployment(
  id: string,
  connection: Database.Database = sqlite(),
) {
  const row = connection
    .prepare<[string], DeploymentRow>(
      `SELECT ${columns} FROM strategy_deployments WHERE id=?`,
    )
    .get(idSchema.parse(id));
  return row ? decodeDeployment(row) : null;
}

const listFilterSchema = z
  .object({
    status: statusSchema.optional(),
    market: marketSchema.optional(),
    limit: z.number().int().min(1).max(1000).default(50),
    after: z.object({ updatedAt: timestampSchema, id: idSchema }).optional(),
  })
  .strict();

export function listDeployments(
  filter: z.input<typeof listFilterSchema> = {},
  connection: Database.Database = sqlite(),
) {
  const { status, market, limit, after } = listFilterSchema.parse(filter);
  const rows = connection
    .prepare<(string | number)[], DeploymentRow>(
      `SELECT ${columns} FROM strategy_deployments WHERE 1=1
       ${status ? "AND status=?" : ""}
       ${market ? "AND market=?" : ""}
       ${after ? "AND (updated_at,id) < (?,?)" : ""}
       ORDER BY updated_at DESC,id DESC LIMIT ?`,
    )
    .all(
      ...(status ? [status] : []),
      ...(market ? [market] : []),
      ...(after ? [after.updatedAt, after.id] : []),
      limit + 1,
    );
  const items = rows.slice(0, limit).map(decodeDeployment);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? { updatedAt: last.updatedAt, id: last.id }
        : null,
  };
}

function requireDeployment(id: string, connection: Database.Database) {
  const deployment = getDeployment(id, connection);
  if (!deployment) throw new Error(`策略部署不存在：${id}`);
  return deployment;
}

function writeDeploymentState(
  deployment: DeploymentRecord,
  connection: Database.Database,
) {
  connection
    .prepare(
      `UPDATE strategy_deployments SET status=@status,execution_mode=@executionMode,
       pause_reason=@pauseReason,consecutive_failures=@consecutiveFailures,
       updated_at=@updatedAt WHERE id=@id`,
    )
    .run(deployment);
  return deployment;
}

export function updateDeploymentStatus(
  id: string,
  status: DeploymentStatus,
  pauseReason?: string,
  connection: Database.Database = sqlite(),
) {
  const nextStatus = statusSchema.parse(status);
  const reason = z.string().trim().min(1).optional().parse(pauseReason);
  return connection
    .transaction(() => {
      const current = requireDeployment(id, connection);
      const nextReason =
        nextStatus === "paused" ? (reason ?? current.pauseReason) : null;
      if (current.status === nextStatus && current.pauseReason === nextReason)
        return current;
      const updated = writeDeploymentState(
        {
          ...current,
          status: nextStatus,
          pauseReason: nextReason,
          consecutiveFailures:
            nextStatus === "active" ? 0 : current.consecutiveFailures,
          updatedAt: Date.now(),
        },
        connection,
      );
      appendExecutionAuditEvent(
        {
          deploymentId: current.id,
          eventType: "deployment_status_changed",
          details: {
            from: current.status,
            to: updated.status,
            pauseReason: nextReason,
          },
          createdAt: updated.updatedAt,
        },
        connection,
      );
      return updated;
    })
    .immediate();
}

export function updateDeploymentMode(
  id: string,
  executionMode: ExecutionMode,
  connection: Database.Database = sqlite(),
) {
  const nextMode = executionModeSchema.parse(executionMode);
  return connection
    .transaction(() => {
      const current = requireDeployment(id, connection);
      assertCompatibleVenue({ ...current, executionMode: nextMode });
      if (current.executionMode === nextMode) return current;
      const updated = writeDeploymentState(
        { ...current, executionMode: nextMode, updatedAt: Date.now() },
        connection,
      );
      appendExecutionAuditEvent(
        {
          deploymentId: current.id,
          eventType: "deployment_execution_mode_changed",
          details: { from: current.executionMode, to: nextMode },
          createdAt: updated.updatedAt,
        },
        connection,
      );
      return updated;
    })
    .immediate();
}

export { updateDeploymentMode as updateDeploymentExecutionMode };

export function updateDeploymentConfig(
  id: string,
  raw: DeploymentConfigPatch,
  connection: Database.Database = sqlite(),
) {
  const patch = configPatchSchema.parse(raw);
  const changes = Object.entries(patch).filter(
    ([, value]) => value !== undefined,
  );
  return connection
    .transaction(() => {
      const current = requireDeployment(id, connection);
      const updated = deploymentSchema.parse({
        ...current,
        ...Object.fromEntries(changes),
        updatedAt: Date.now(),
      });
      assertCompatibleVenue(updated);
      if (!changes.length) return current;
      connection
        .prepare(
          `UPDATE strategy_deployments SET name=@name,strategy_spec_json=@strategySpecJson,
         universe_spec_json=@universeSpecJson,regime_gate_json=@regimeGateJson,
         risk_policy_json=@riskPolicyJson,venue_binding_json=@venueBindingJson,
         pool_policy_json=@poolPolicyJson,
         schedule_json=@scheduleJson,provenance_json=@provenanceJson,updated_at=@updatedAt
         WHERE id=@id`,
        )
        .run({
          ...encodeConfig(updated),
          id: current.id,
          updatedAt: updated.updatedAt,
        });
      appendExecutionAuditEvent(
        {
          deploymentId: current.id,
          eventType: "deployment_config_changed",
          details: { fields: changes.map(([field]) => field) },
          createdAt: updated.updatedAt,
        },
        connection,
      );
      return updated;
    })
    .immediate();
}

export function recordDeploymentFailure(
  id: string,
  reason: string,
  connection: Database.Database = sqlite(),
) {
  const failure = z.string().trim().min(1).parse(reason);
  return connection
    .transaction(() => {
      const current = requireDeployment(id, connection);
      const consecutiveFailures = current.consecutiveFailures + 1;
      const autoPaused =
        (current.status === "active" || current.status === "draft") &&
        consecutiveFailures >= current.riskPolicy.maxConsecutiveFailures;
      const updated = writeDeploymentState(
        {
          ...current,
          consecutiveFailures,
          status: autoPaused ? "paused" : current.status,
          pauseReason: autoPaused ? failure : current.pauseReason,
          updatedAt: Date.now(),
        },
        connection,
      );
      appendExecutionAuditEvent(
        {
          deploymentId: current.id,
          eventType: "deployment_failure",
          details: {
            reason: failure,
            consecutiveFailures,
            autoPaused,
            from: current.status,
            to: updated.status,
          },
          createdAt: updated.updatedAt,
        },
        connection,
      );
      return updated;
    })
    .immediate();
}
