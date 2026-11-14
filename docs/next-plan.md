# 当前实施计划

更新：2026-11-14。范围以 [roadmap](roadmap.md)、[P0–P5 方案](optimization-plan-2026-11-13.md)和用户最新授权为准；验证只在[优化交付](deliveries/2026-11-13-optimization.md)维护。

## 当前：优化方案 A–E 已完成，待新指令

A–E 已全部提交（e5063bb、fe73255、67f3e33、ec38764、a77c2e9，另有 WDZ 迁出 f73f7db 与清理 7d10995），状态与接手入口见[2026-11-14 交接](handoff-2026-11-14.md)。完整 pnpm check --build 七阶段退出 0：主工程 6,328 + 包级 194 通过、27 既有跳过；未推送、未正式打包。

## 接下来两项

1. P1 尚未覆盖的外部数据成功态、历史盘中批次与行业/概念 RPS 有数据态、Electron 原生焦点，按实际可用环境只读补验。
2. 剩余 25 处数据层外 SQLite 调用按登记理由维持；只有实测瓶颈证明需要时再迁移或设计物理表，没有预设 schema 升级。

## 持续边界

- 公式、双突破与现行研究/回测可用；旧样本/执行链已退役，不增加兼容转发。
- 监控、信号台账、盘中预选的计算/调度暂停；保存允许配置不恢复调度，重启不补跑、不补发。
- 仅行情、筛选、回测显式保留实例；普通页面的 URL、内存草稿、sessionStorage 与服务器事实按[架构状态表](architecture.md#页面模型与状态归属)归属，返回不自动重提写入。
- 原通达信/外部 Blocks 只读，凭证在仓库外 DPAPI；任何可能初始化数据库的验证先使用隔离 QUANT_DATA_DIR。不改用户库、不降低 user_version。
- 数字货币模拟交易及其他市场保留已有授权范围；本轮不扩展实盘、合约或真实外部调用。`src/server/mcp.ts` 与用户维护文案不动。

## 待用户手动事项

无。2026-11-14 管理者已执行 Zod junction 修复、WDZ 迁出（f73f7db）、退役合成标定清理（7d10995），以及 P0/P1 验收库、单元测试临时目录、A–E 各批任务产物的清理脚本（均先预演、按哈希核验后删除）；浅色打包与历史工具清理脚本复核时已无目标。`.next/cache` 的审阅清理脚本因构建缓存已变化而拒绝执行，属可再生缓存，未处理。

## 其他有效范围

- 统一策略中心继续依据[规格](product/specs/unified-strategy-center.md)、[方法盘点](strategy-inventory.md)与[归属计划](strategy-consolidation-plan.md)；695 项登记不等于全部可执行，历史结构/公告时点及九代表研究仍按原范围推进。
- 浅色界面依据[开发计划](product/full-site-redesign/development-plan.md)与[覆盖表](product/full-site-redesign/development-coverage.md)；该任务自己的提交/打包授权不能移用于本派单。
- 成交执行质量仍仅规划，本轮不扩展；原专项计划文件当前缺失，接续前恢复任务书及输入。五分钟导入依据[手册](wdz-import.md)及[规格](product/specs/tdx-five-minute-import.md)，已有近似量只供看图，不自动覆盖估算或扩展外部目录写入。
- 其他模块按[模块地图](modules/README.md)维护；保持排序分页、缺失语义与原生串行边界，多核公式池、多图布局和跨周期画线不顺带扩展。
