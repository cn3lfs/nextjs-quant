# 下一阶段主实施计划：底座提速、投资理论闭环与 `/lab` 诊断产品化

日期：2026-11-23  
基线提交：`master@64a6055e`（前阶段 M1 原生缠论 / M2 CANSLIM strict-PIT / M3 94-key 健康基线已交付，详见[前阶段计划](../research-backtest/2026-11-23-phase-plan.md)）  
状态：**已定稿，待下个会话按 Wave 0 → Wave 3 执行**

---

## 1. 阶段目标与四项核心决策

本阶段采用 **全栈高杠杆闭环路线（先破底座瓶颈 → 再做投资理论纵深 → 最后把研究诊断能力搬上工作台）**，已锁定以下四项关键决策：

1. **Wave 0 先破瓶颈**：先解决全量门禁满载超时与交割单分页 500 万行扫描，使后续所有 Wave 的验证快速、稳定、无抖动。
2. **数据库零不必要迁移原则**：SQLite `user_version`（当前 `v23`）**仅在表结构或数据契约发生不可逆变化时才升级**（旧桌面包会拒绝更高版本库）。`delivery-workspace-query.ts` 性能降阶优先采用零迁移的查询与连接级版本缓存修复；仅当实测 `EXPLAIN QUERY PLAN` 证明纯查询优化仍无法达标时，才讨论升 `v24` 迁移。
3. **12 只精简分层验证池（小而精、够验证理论）**：不做大而重的 35–50 股铺量，固定 12 只已在本地 `E:/new_tdx64`（日线截至 `2026-11-20`）核验存在的代表标的，覆盖主板/创业板/科创板、长历史与晚上市、蓝筹与高成长/周期/医药，并显式披露幸存者偏差与数据边界。
4. **CLI 与 `/lab` 共用同一诊断服务**：将 `scripts/lib/backtest-diagnose/` 核心准备与 15 项诊断校验抽入 `src/server/research/diagnose/`，保证命令行与 `/lab` 界面 100% 同口径，并打通 `/scan` 候选一键带入 `/lab`。

---

## 2. 精简 12 只分层研究样本池（本地已核验）

> **口径声明**：本池用于投资理论机制验证、条件漏斗消融与执行诊断，**不代表无幸存者偏差的全市场历史收益**；历史 ST、退市与首次披露财报版本缺口继续显式保留为未知项。

| 分组 | 代码 | 标的 | 板块 / 风格 | 承担的专项验证角色 |
| :--- | :--- | :--- | :--- | :--- |
| 基线回归（5） | `sh600519` | 贵州茅台 | 主板 · 消费 | 长历史回归基线、缠论三买 5,908 前缀性能对拍 |
| 基线回归（5） | `sz000001` | 平安银行 | 主板 · 金融 | 周末/日历外日期边界回归 |
| 基线回归（5） | `sh601318` | 中国平安 | 主板 · 金融 | 大盘蓝筹低弹性对照 |
| 基线回归（5） | `sz000333` | 美的集团 | 主板 · 制造消费 | 稳健蓝筹对照 |
| 基线回归（5） | `sz300750` | 宁德时代 | 创业板 · 新能源 | 高成长龙头 + `gpcw20251231.dat` 重复记录边界披露 |
| 理论扩展（7） | `sz300308` | 中际旭创 | 创业板 · 科技/AI光模块 | 业绩爆发型成长股（CANSLIM C/A + SEPA 加速验证） |
| 理论扩展（7） | `sh688981` | 中芯国际 | 科创板 · 半导体 | `2020-07-16` 晚上市、20% 涨跌幅、多标的组合 `firstIndex` 对齐 |
| 理论扩展（7） | `sz300274` | 阳光电源 | 创业板 · 新能源 | 强趋势/VCP 波动收缩与回撤退出验证 |
| 理论扩展（7） | `sz002594` | 比亚迪 | 主板（原中小板）· 新能源车 | 大周期反转 + 业绩高成长代表 |
| 理论扩展（7） | `sh600276` | 恒瑞医药 | 主板 · 医药 | 长周期下跌转震荡（威科夫吸筹/回调验证） |
| 理论扩展（7） | `sh601899` | 紫金矿业 | 主板 · 有色周期 | 资源强周期趋势与趋势回调（`wy-trend-pullback`）验证 |
| 理论扩展（7） | `sz000858` | 五粮液 | 主板 · 消费 | 同行业双股对照（检验组合同日竞仓与板块共性） |

**算力控制**：
- 纯价量、SEPA/CANSLIM strict-PIT、威科夫漏斗与量价短线对照在 **全部 12 只** 上运行（秒级至十余秒级）。
- 原生缠论（单进程串行 `CZSC64.dll`）优先在 **5 只基线 + 2 只代表扩展股（`sh688981`、`sz300308`）** 上运行全谱买卖点与多标的组合验证；通过共享投影缓存确保单只股票仅触发 **1 次** 全历史 DLL 捕获。

---

## 3. 多 Agent Wave 实施蓝图

编排规范遵循全局 `multi-agent-commander` 与本仓 `.agents/fleet.profile.json`：当前会话作为指挥官；核心引擎/底层架构派 `codex-astra`（`gpt-6.2-astra:high`）；日常并行与单测派 `codex-sol`（`gpt-6.2-sol:high`）与 `claude-deepseek`（本机 Claude Code 默认模型，不传 `--model`/`--effort`，显式 `--permission-mode bypassPermissions`）；每波收口自动链式 `codex-sol-review`（`gpt-6.2-sol:high` 只读评审）。默认降级严格限定在 GPT ↔ Claude 之间，不自动消耗 Gemini 额度。

### Wave 0 · 底座清障：门禁去抖提速 + 交割分页零迁移降阶

**目标**：消除满载门禁超时抖动，修掉 `deliveryBatchPage` 翻页扫描 500 万行的生产/测试共用性能瓶颈，补齐 workspace 包测试覆盖。

| Task ID | 引擎 | 职责与改造要点 | 独占文件边界 (`owns[]`) |
| :--- | :--- | :--- | :--- |
| `w0-delivery-paging` | `codex-astra` | **零迁移优先修复** `delivery-workspace-query.ts`：<br/>1. `deliveryAccountVersion(db, account)` 改为基于 SQLite 原生 `(PRAGMA data_version, total_changes())` 组合的连接级 WeakMap 缓存，同一连接/跨连接无写入时 O(1) 命中，保留同数撤销替换 100% 精确失效；冷缓存亦减少冗余物化。<br/>2. 修复 `where` 在 `keyword === ""` 时仍全表执行 `instr(lower(b.file_name), '') > 0` 的无效扫描。<br/>3. 优化翻页重复 `SELECT count(*)`（同 `(version, filter)` 缓存或完整遍历走单次只读快照）。<br/>4. 在隔离库实测万批 500 页与 `EXPLAIN QUERY PLAN`：若已达标则**不升 `user_version`（保持 v23）**；若实测仍超标再附证据评估局部索引迁移。 | `src/server/db/delivery-workspace-query.ts`<br/>`tests/portfolio-ledger/delivery-workspace-query.test.ts` |
| `w0-gate-deflake` | `codex-sol` | **拆除 23 次 CLI 冷启动与重任务争用**：<br/>1. 在 `vitest.config.ts` / `scripts/lib/test-projects.ts` 中显式拆分重任务组（真实 CLI / TS ESLint / 大数据用例 `maxWorkers: 1`），常规隔离组按实测确定并行度。<br/>2. 改造 4 个热点测试（`lint-rules.test.ts`、`five-minute-audit.test.ts`、`five-minute-estimate.test.ts`、`financial-replay-cli.test.ts`）：核心业务逻辑改进程内调用（不删减有效断言），每个正式 CLI 入口仅保留最小真实子进程冒烟，同步 `execFileSync` 改为带硬超时和 Windows 进程树回收的异步执行。<br/>3. 核对并纳入 `tstdx`、`quant-execution`、`quant-rps` 三个 workspace 包自有测试到统一门禁，补齐 `local-check.mjs` 分项目/分步耗时统计。 | `vitest.config.ts`<br/>`package.json`<br/>`scripts/lib/test-projects.ts`<br/>`scripts/lib/local-check.mjs`<br/>`tests/engineering-validation/lint-rules.test.ts`<br/>`tests/market-chart/five-minute-audit.test.ts`<br/>`tests/market-chart/five-minute-estimate.test.ts`<br/>`tests/research-backtest/backtest/financial-replay-cli.test.ts` |
| `w0-review` | `codex-sol-review` | `dependsOn: ["w0-delivery-paging", "w0-gate-deflake"]`，只读审查断言保真、撤销替换失效反例、进程回收与零迁移合理性。 | 只读 (`--uncommitted`) |

**Wave 0 验收门槛**：
- `delivery-workspace-query.test.ts` 万批 500 页不漏不重同序，满载耗时 **≤5 秒**（原 30 秒超时），单页 **P95 ≤100 ms**；覆盖同数撤销替换失效、跨连接写入失效与空关键词/字面关键词匹配用例；优先保持 `user_version = 23` 零迁移。
- 同机 `pnpm check`：根 Vitest **≤210 秒**，空闲完整门禁 **≤330 秒**，满载 **≤420 秒**，连续运行零超时、零残留子进程、零断言削弱；所有 workspace 包测试纳入统一清单。

---

### Wave 1 · 投资理论纵深双轨：原生缠论买卖点闭环 + 成长 SEPA/CANSLIM 与 12 股分层验证

**目标**：把原生缠论从“仅单股三买 + 5-bar 退出”升级为“共享投影 + 一二三买 + `CH14` 真实卖点退出 + 多标的组合”；把成长股从“5 蓝筹 2 成交 + 5-bar 退出”升级为“SEPA/VCP + PIT 财务 + CANSLIM `M` 制度 + 8%/MA50 真实退出 + 12 股池消融”，并复验威科夫在 12 股池上的逐层漏斗。

| Task ID | 引擎 | 职责与改造要点 | 独占文件边界 (`owns[]`) |
| :--- | :--- | :--- | :--- |
| `w1-chan-multi` | `codex-astra` | **缠论原生共享投影 + 买卖点闭环 + 组合 `firstIndex` 解禁**：<br/>1. 升级 `FrozenChanObservation`（提升契约版本并向后兼容校验）：单次逐前缀捕获保留一/二/三类买卖点（有符号 `kind`）、背驰与中枢关系，供 `chan-first-native`（`CH01`）、`chan-second-native`（`CH02`）、`chan-third-native`（`CH03`）与 `chan-hold-cash-native`（`CH14` 首次确认卖点退出，受阻保留卖出意图）共用，同股 **0 新增 DLL build**。<br/>2. 缓存键绑定当前 DLL SHA / API 版本 / config / 投影版本，明确区分“历史冻结重放”与“当前 DLL 计算”。<br/>3. 解除 `attachNativeChan` 的多标的 `firstIndex` 必须相等限制：把 `firstIndex`、起点日与基线日绑定到每只标的的 `instrument.external.chan`，策略本体只声明 profile、方向与退出规则；组合固定同窗取各成员预热就绪日最大值。<br/>4. 严格维持单宿主单串行 `czsc-worker` 与因果无前视校验（基线点不回填、撤销/再现不复买、空仓卖点不下单、跌停卖出持续待执行）。 | `packages/trading-strategies/src/native-study.ts`<br/>`packages/trading-strategies/src/strategy-object.ts`<br/>`packages/trading-strategies/tests/native-study.test.ts`<br/>`src/server/strategies/strategy-center-native.ts`<br/>`src/server/strategies/chan/czsc.ts`<br/>`scripts/lib/backtest-diagnose/chan-native*`<br/>`tests/research-backtest/diagnose/chan-*.test.ts` |
| `w1-growth-sepa-pool` | `codex-sol` | **成长股完整闭环（SEPA + CANSLIM `M` + 真实退出）+ 12 股分层池与威科夫漏斗**：<br/>1. 扩展 `src/server/financial/canslim-pit-series.ts` 与新模块 `sepa-pit-series.ts`：披露 CANSLIM 全部 C1/C2/C3/A1/A2/A3 逐项覆盖与边际通过率，对接 `evaluateSepaFinance`（`FN230/232/281`）与 `vcpFacts` / `sepaVcpScore`；单列披露 `gpcw20251231.dat` 中 `300750` 重复记录缺口。<br/>2. 接入 CANSLIM `M` 大盘制度过滤器（冻结本地 `sh000300` 已完成日线，`sh000001` 仍作基准日历，严禁前视）与真实成长退出消融对照：`5-bar 对照` vs `8% 固定止损`（含 `7%` 敏感性）vs `MA20/MA50 收盘破位退出`。<br/>3. 固化 12 只分层验证池配置（可复用 preset，如 `--pool core-12`），补充威科夫（`wy-lps`/`wy-reaccumulation`/`wy-trend-pullback`）逐层漏斗统计（父事件→回踩缩量→候选→次日放量确认→订单→成交）及量价/`theory-vcp-close`/`classic-ibs` 横向对照测试。 | `src/server/financial/**`<br/>`scripts/lib/backtest-diagnose/universe*`<br/>`scripts/lib/backtest-diagnose/growth*`<br/>`scripts/lib/backtest-diagnose/wyckoff*`<br/>`tests/research-backtest/diagnose/canslim-*.test.ts`<br/>`tests/research-backtest/diagnose/sepa-*.test.ts`<br/>`tests/research-backtest/diagnose/universe-*.test.ts` |
| `w1-wire-cli` | `codex-astra` | `dependsOn: ["w1-chan-multi", "w1-growth-sepa-pool"]`，在 `scripts/lib/backtest-diagnose/{strategy-specs,prepare-request,run,report,types}.ts` 与 `scripts/backtest-diagnose.ts` 中完成新缠论 key（`research-chan-first` / `second` / `third` / `hold-cash`）、SEPA/CANSLIM-M key 与 `--pool core-12` 的统一接线。 | `scripts/backtest-diagnose.ts`<br/>`scripts/lib/backtest-diagnose/{strategy-specs,prepare-request,run,report,types}.ts`<br/>`src/server/research/lab-backtest.ts` |
| `w1-review` | `codex-sol-review` | `dependsOn: ["w1-wire-cli"]`，重点核查前视泄露、跨标的 `firstIndex` 对齐、公告日边界、跳空/T+1 止损执行、旧三买回归一致性。 | 只读 (`--uncommitted`) |

**Wave 1 验收门槛**：
- **缠论回归与扩展**：`sh600519` 旧 `research-chan` 三买逐笔 100% 复现；同股运行 `CH01/CH02/CH03/CH14` 首次恰好 5,908 次 build，新增策略与暖缓存 **0 次新增 build**；`sh600519 + sh688981`（不同上市日/不同预热索引）多标的组合 `strict`/`clamp`/`cap-0.5-clip` 全通过且 0 P0；空仓卖点不下单、跌停卖单顺延、0 残留 `czsc-worker`。
- **成长与 12 股池实证**：12 股池上产出严格漏斗对照（纯价量 → VCP/趋势 → strict-PIT 财务 → `M` 大盘制度；以及 `5-bar` vs `8%止损` vs `MA50` 退出）与威科夫逐层计数，0 P0；公告日前一日不可见、公告后首交易日可见、负基数/缺期/重复记录单测全绿。

---

### Wave 2 · 共享诊断服务抽离 + `/lab` 产品化落地 + `/scan` 一键带入

**目标**：消除 CLI 与 `/lab` 的双套回测诊断分叉；在 `/lab` 首次可视化展示三档执行情景对比、15 项体检抽屉与原生缠论/PIT 披露；打通 `/scan` 筛选候选一键带入 `/lab`。

*(严格采用 Stage 1 Foundation 锁契约 → Stage 2 Dual-Track UI/接线并行 → Stage 3 Dedicated Gate 评审)*

| Task ID | 引擎 | 职责与改造要点 | 独占文件边界 (`owns[]`) |
| :--- | :--- | :--- | :--- |
| `w2-diagnose-service` | `codex-astra` | **Stage 1（先锁契约与服务）**：<br/>1. 抽离 `src/server/research/diagnose/` 统一服务：封装策略 key 解析、日历对齐、因果价格证明、外部证据（原生缠论/PIT 财务）冻结、执行档位（`strict`/`clamp`/`cap-0.5-clip`）与 15 项诊断判定。<br/>2. CLI (`scripts/lib/backtest-diagnose/*`) 瘦身为薄封装（参数解析、路径校验、退出码、CSV/Markdown 落盘）。<br/>3. 在 `src/server/api/routers/strategy-lab.ts`（或专用子 router 并入 `root.ts`）暴露两类只读/任务能力：① 只读浏览已有隔离诊断报告档案（含口径身份、漂移告警、大载荷分页保护）；② 通过现有 `backtest/compute` 任务队列提交成组执行情景诊断运行（保留显式授权开关，常规默认不变，诊断专用 `record-only` 不渗入普通 Lab）。 | `src/server/research/diagnose/**`<br/>`src/server/api/routers/strategy-lab.ts`<br/>`src/server/api/root.ts`<br/>`scripts/lib/backtest-diagnose/**`<br/>`tests/research-backtest/diagnose/service-parity.test.ts` |
| `w2-lab-ui` | `claude-deepseek` | **Stage 2 轨道 A**（`dependsOn: ["w2-diagnose-service"]`）：<br/>在 `/lab` 实现诊断产品化视图：<br/>1. **执行情景对比卡**：同冻结样本并排展示 `strict` / `clamp` / `cap-0.5-clip` 成交数、拒单原因、容量裁剪、费用与回撤差值（成交额缺失时显式提示容量未生效）。<br/>2. **15 项回测体检抽屉**：按实际检查 ID 分组呈现通过/告警/失败/未评估/阻断，支持定位到信号日、订单或账本差额；单独标明工程健康 vs 研究有效性。<br/>3. **原生缠论 & CANSLIM PIT 披露面板**：展示 DLL 身份/前缀边界/耗时与价格→财务→大盘→成交漏斗及公告日边界说明。 | `src/components/research/diagnose/**`<br/>`src/components/research/lab-backtest.tsx`<br/>`src/components/workbench/task-evidence.tsx`<br/>`src/components/portfolio/portfolio-result-view.tsx` |
| `w2-scan-handoff` | `codex-sol` | **Stage 2 轨道 B**（`dependsOn: ["w2-diagnose-service"]`）：<br/>打通 `/scan` 筛选候选一键「带入回测」到 `/lab`：<br/>1. 从公式、形态与 RPS 冻结候选生成稳定的回测预览参数（携带标的、冻结日期、策略映射与口径提示，明确区分单标的诊断与历史池研究）。<br/>2. 严格遵守 `retained-routes.tsx` 页面保活与[架构状态表](../architecture.md#页面模型与状态归属)：显式点击应用草稿，绝不静默覆盖 `/lab/backtest` 保活中的未保存草稿，浏览器前进/后退按 URL 恢复不串旧快照。<br/>3. 补齐跨页交接与状态恢复契约测试。 | `src/lib/screening/screen-candidate-navigation.ts`<br/>`src/components/workbench/screen-view.tsx`<br/>`src/components/screening/pattern-screen-panel.tsx`<br/>`src/components/market/stock-rps-ranking.tsx`<br/>`tests/workbench/scan-to-lab-handoff.test.ts` |
| `w2-review` | `codex-sol-review` | `dependsOn: ["w2-lab-ui", "w2-scan-handoff"]`，核查 CLI/Lab 口径 100% 一致性、默认生产回测行为零渗漏、保活路由草稿安全、`src/server/mcp.ts` 与用户维护文案零触碰。 | 只读 (`--uncommitted`) |

**Wave 2 验收门槛**：
- **CLI 与 `/lab` 同口径对拍**：对三买（`research-chan`）、`research-canslim-pit`、`hold` 分别运行 `strict`/`clamp`/`cap-0.5-clip`，冻结输入摘要、订单、成交、拒单原因与 15 项体检结果 **100% 一致**；回放阶段 0 次重读行情或调用 DLL；任务取消不落盘成功档案。
- **UI 与跨页交互**：`/lab` 能正常渲染四批既有 CLI 诊断产物与新成组运行结果（覆盖正常、零信号、阻断、缺文件四种边界态）；`/scan` → `/lab` 换候选、返回原列表、原保活草稿恢复全部通过单测与本地页面验证。

---

### Wave 3 · 集成验收、研究报告落盘与清理收尾

1. **真实数据复验**：基于 `E:/new_tdx64`（只读）跑通本阶段新矩阵（缠论多买卖点+组合、12 股池 SEPA/CANSLIM/威科夫漏斗），落盘研究记录至 `docs/research-backtest/2026-11-XX-*.md`。
2. **完整工程门禁**：集中运行 `pnpm check`（含新增的 3 个包测试），核对 `check-result.json` 的 `elapsedMs` 与 `timedOut: false`（验证 Wave 0 提速目标实际生效）。
3. **文档与临时产物清理**：更新 `docs/next-plan.md` 与交付总结；使用 `fleet clean --apply` 清理所有 `.test-data/fleet/` 临时运行目录与一次性测试目录。
4. **等待授权**：提交、推送与桌面打包分别汇报证据并等待用户明确授权后再执行。

---

## 4. 全程硬约束（不可违背）

- **只读与库隔离**：`E:/new_tdx64` 与外部 Blocks 严格只读；任何触达 SQLite 的命令/测试必须设置 `.test-data/` 下的隔离 `QUANT_DATA_DIR`，禁止打开默认生产库、禁止删库或降低 `user_version`。
- **零不必要迁移**：`v23` 保持稳定，不因普通查询优化或缓存需求随意升 schema；如确有实测证据需迁移，先汇报 `EXPLAIN QUERY PLAN` 证据与回滚影响。
- **受保护资产**：绝不修改、回退或纳入提交 `src/server/mcp.ts` 及用户维护的 UI 文案。
- **单进程缠论约束**：保持单宿主唯一串行 `czsc-worker`，绝不改为 TS 近似或并行 DLL 池。
- **无未授权副作用**：不真实下单、不外发通知/数据、不打印凭证/密钥；提交、推送、正式打包分别等待明确授权。
- **多 Agent 纪律**：`claude-deepseek` 不传 `--model`/`--effort`、不设 `ANTHROPIC_MODEL`、显式 `--permission-mode bypassPermissions`；Codex 三引擎显式 `high` 思考强度；默认降级限定 GPT ↔ Claude，保留 Gemini 额度。
