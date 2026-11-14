/** Product policy only. Data readiness and saved subscriptions are separate. */
export type CapabilityOperation = "read" | "configure" | "compute" | "schedule";
type Capability = {
  label: string;
  state: "active" | "paused";
  reasonCode: "available" | "optimization-pause";
  reason: string;
  operations: readonly CapabilityOperation[];
};
function activeCapability(
  label: string,
  operations: readonly CapabilityOperation[],
): Capability {
  return {
    label,
    state: "active",
    reasonCode: "available",
    reason: "",
    operations,
  };
}
export const capabilityPolicyVersion = 2;
export const capabilities = {
  alerts: activeCapability("统一提醒引擎", ["read", "configure", "schedule"]),
  market: activeCapability("行情与证券池", ["read", "configure", "compute"]),
  nativeChart: activeCapability("原生缠论图表", ["read", "compute"]),
  rps: activeCapability("RPS", ["read", "configure", "compute"]),
  onlineScreen: activeCapability("在线选股", ["read", "compute"]),
  financial: activeCapability("财务资料与筛选", [
    "read",
    "configure",
    "compute",
  ]),
  backtest: activeCapability("现行回测", ["read", "configure", "compute"]),
  strategyCenter: activeCapability("策略中心", ["read", "compute"]),
  research: activeCapability("现行研究与报告", [
    "read",
    "configure",
    "compute",
  ]),
  news: activeCapability("新闻与主题复盘", [
    "read",
    "configure",
    "compute",
    "schedule",
  ]),
  portfolio: activeCapability("账户账本与交易复盘", [
    "read",
    "configure",
    "compute",
  ]),
  dataImport: activeCapability("五分钟数据导入", ["read", "compute"]),
  settings: activeCapability("数据连接与设置", [
    "read",
    "configure",
    "compute",
  ]),
  integrations: activeCapability("MCP 数据集成", [
    "read",
    "configure",
    "compute",
  ]),
  notifications: activeCapability("通知渠道与投递", [
    "read",
    "configure",
    "compute",
  ]),
  tasks: activeCapability("任务管理", ["read", "configure"]),
  cryptoSimulation: activeCapability("数字货币模拟账户", [
    "read",
    "configure",
    "compute",
    "schedule",
  ]),
  formulaScreen: {
    label: "公式选股",
    state: "active",
    reasonCode: "available",
    reason: "",
    operations: ["read", "configure", "compute"],
  },
  breakout: {
    label: "双突破图表",
    state: "active",
    reasonCode: "available",
    reason: "",
    operations: ["read", "compute"],
  },
  signalMonitor: {
    label: "信号监控",
    state: "active",
    reasonCode: "available",
    reason: "新提醒由统一引擎管理；本页保留历史订阅与渠道。旧调度不再运行。",
    operations: ["read", "configure"],
  },
  signalLedger: {
    label: "信号台账",
    state: "active",
    reasonCode: "available",
    reason: "提醒历史由统一引擎向前积累；旧批次保留查询，不补跑。",
    operations: ["read", "configure"],
  },
  intraday: {
    label: "盘中预选",
    state: "active",
    reasonCode: "available",
    reason: "完成行情与持仓保护已合入统一提醒；本页保留历史预选查询。",
    operations: ["read", "configure"],
  },
} as const satisfies Record<string, Capability>;
export type CapabilityId = keyof typeof capabilities;
export type CapabilityBinding = {
  capability: CapabilityId;
  operation: CapabilityOperation;
};
export function isCapabilityBinding(
  value: unknown,
): value is CapabilityBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Record<string, unknown>;
  return (
    typeof binding.capability === "string" &&
    Object.hasOwn(capabilities, binding.capability) &&
    typeof binding.operation === "string" &&
    ["read", "configure", "compute", "schedule"].includes(binding.operation)
  );
}
export function capabilityAllows(
  id: CapabilityId,
  operation: CapabilityOperation,
) {
  const policy: Capability = capabilities[id];
  return policy.operations.includes(operation);
}
