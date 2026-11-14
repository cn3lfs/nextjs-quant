/** Only reviewed summaries cross the diagnostics boundary; never raw provider errors. */
export const runtimeErrorEvents = {
  "alert-engine": {
    module: "统一提醒",
    stage: "完成行情求值",
    summary: "提醒求值失败或证据缺失，请检查数据就绪状态。",
  },
  "notification-send": {
    module: "通知服务",
    stage: "发送",
    summary: "本次投递失败，请检查通知记录中的重试状态。",
  },
  "crypto-order": {
    module: "数字货币模拟",
    stage: "提交意图",
    summary: "模拟委托提交未正常完成，策略已暂停；以账户核对结果为准。",
  },
  "czsc-worker": {
    module: "缠论图表",
    stage: "原生计算",
    summary: "图表原生计算失败，请检查数据和原生运行库。",
  },
  "discipline-worker": {
    module: "纪律复盘",
    stage: "计算线程",
    summary: "纪律复盘计算失败，请检查输入和运行环境。",
  },
  "workflow-rps": {
    module: "RPS 工作流",
    stage: "观测计算",
    summary: "本次 RPS 观测未完成，请检查工作流状态。",
  },
  "rps-worker": {
    module: "RPS",
    stage: "计算线程",
    summary: "RPS 计算失败，请检查计算状态和运行环境。",
  },
  "rps-schedule": {
    module: "RPS",
    stage: "启动计算",
    summary: "本次自动计算未启动，请在 RPS 页面检查并重试。",
  },
  "cls-review": {
    module: "财联社复盘",
    stage: "检查资料",
    summary: "复盘资料读取或核验失败，请检查复盘状态。",
  },
  "cls-review-state": {
    module: "财联社复盘",
    stage: "保存状态",
    summary: "复盘检查状态未能保存，请检查数据目录。",
  },
  "signal-ledger": {
    module: "信号台账",
    stage: "计算线程",
    summary: "信号台账计算失败，请检查台账状态。",
  },
  "intraday-worker": {
    module: "盘中预选",
    stage: "计算线程",
    summary: "盘中预选计算失败，请检查执行状态。",
  },
  "runtime-start": {
    module: "运行服务",
    stage: "启动恢复",
    summary: "启动恢复未完成，请检查任务状态后重试。",
  },
  "scheduler-tick": {
    module: "调度服务",
    stage: "周期检查",
    summary: "本次调度检查失败，后续周期会再次检查。",
  },
  "notification-drain": {
    module: "通知服务",
    stage: "投递队列",
    summary: "通知队列处理失败，请检查渠道和订阅状态。",
  },
  "crypto-tick": {
    module: "数字货币模拟",
    stage: "周期检查",
    summary: "模拟账户周期检查失败，请检查账户连接和策略状态。",
  },
  "monitor-data": {
    module: "信号监控",
    stage: "读取数据",
    summary: "监控数据读取失败，本次证券检查未完成。",
  },
  "monitor-trading-status": {
    module: "信号监控",
    stage: "交易状态",
    summary: "证券交易状态核验失败，未生成新信号。",
  },
  "job-run": {
    module: "后台任务",
    stage: "执行",
    summary: "任务执行失败，可打开任务查看状态及来源。",
  },
  "job-state-write": {
    module: "后台任务",
    stage: "保存状态",
    summary: "任务失败状态未能保存，请检查数据目录后刷新。",
  },
  "job-cancellation-watch": {
    module: "后台任务",
    stage: "取消检查",
    summary: "取消状态暂未读到，下次检查会重试。",
  },
  "worker-request": {
    module: "计算线程",
    stage: "计算请求",
    summary: "计算请求未完成，请检查数据和运行环境后重试。",
  },
  "worker-idle": {
    module: "计算线程",
    stage: "空闲退出",
    summary: "空闲计算线程异常退出，后续请求将创建新线程。",
  },
} as const;

export type RuntimeErrorEvent = keyof typeof runtimeErrorEvents;
export type RuntimeErrorEntry = {
  id: string;
  event: RuntimeErrorEvent;
  module: string;
  stage: string;
  summary: string;
  code: string;
  firstSeen: number;
  lastSeen: number;
  count: number;
  retryCount: number;
  jobId: string | null;
  requestId: string | null;
};
export type RuntimeErrorReport = {
  entries: RuntimeErrorEntry[];
  available: boolean;
  unrecordedInThisProcess: number;
};
