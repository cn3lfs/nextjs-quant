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
    state: "paused",
    reasonCode: "optimization-pause",
    reason:
      "信号监控已暂停。可查看记录和保存订阅设置，暂停期间不计算新信号；保存设置不会恢复调度。",
    operations: ["read", "configure"],
  },
  signalLedger: {
    label: "信号台账",
    state: "paused",
    reasonCode: "optimization-pause",
    reason:
      "信号台账自动计算已暂停。可查看已有记录，暂停期间不创建或补跑批次。",
    operations: ["read", "configure"],
  },
  intraday: {
    label: "盘中预选",
    state: "paused",
    reasonCode: "optimization-pause",
    reason:
      "盘中预选与收盘核对已暂停。可查看记录和保存参数，暂停期间不执行或补跑；保存设置不会恢复调度。",
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
