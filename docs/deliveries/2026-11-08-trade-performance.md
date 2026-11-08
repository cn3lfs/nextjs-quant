# 交易轮次指标结构化与研究链路提交

2026-11-08。按用户“结构化到代码里，然后提交”，把手工补算提升为统一纯计算、研究自动输出、应用查询/导出及绩效页面。提交范围同时包含此前尚未提交的中证800持仓风控、EMA50退出与因果入场过滤；不纳入其他任务的RPS修改，不推送或打包。

## 统一计算与口径

`quant-performance`0.2.0拥有`pairPositionCycles`与`evaluateTrades`。同一股票由空仓到全清算一轮，加仓和部分卖出合并，支持多个股票、反复开仓、现金分红、送转与付费配股；同日公司行动在成交之前，同日成交保留原顺序。只读重建现金流与股数以评价，不执行交易，不依赖回测、数据库、文件或UI。源数据不完整、倒序、重复行动、超量卖出、非法费用等拒绝，不能默默跳过生成假配对。

交易净损益计入模型已记费用和公司行动现金。平均盈利/平均亏损绝对值分别在赢/输子样本内求均值，盈亏比为两者之比；利润因子为总盈利/总亏损绝对值，不能混用。胜率分母为全部闭合轮次，含持平；净损益绝对值≤1e-8本币计持平，未平仓（含部分止盈）整轮排除。没有盈利或亏损样本时对应比率null并附原因，不能显示无穷大。金额不是交易收益率，也不是FIFO逐买单胜率。

报告版本升级`performance-report-v2`，新增独立`trade-performance-v1`字段`trades`；没有交易证据为null，真实零交易为空样本及逐项缺失原因。原`daily-performance-v1`、年季月公式与日收盘回撤保持，交易卡片明确为全程，不随所选年份/月份偷偷裁剪持仓。

## 代码链路

- `packages/quant-performance/src/trades.ts`：纯规范成交/公司行动配对、轮次评价及类型；包根公开导出，独立测试。
- `scripts/lib/csi800-trade-evaluation.ts`：CSI800只读证据映射，不依赖可选止损台账，原基线也有统计。
- `scripts/research-csi800-position-risk.ts`、`scripts/lib/csi800-factor-matrix.ts`：五组风控对照及经典矩阵自动输出`tradeEvaluation`。研究版本4仅增加评价，不改选股与交易。
- `scripts/evaluate-csi800-trades.ts`：只读补评旧冻结结果，验证行情哈希，写入新目录，保存配对明细、输入结果哈希及评价源码哈希，按股票/开平日期逐轮交叉核对旧风险台账。
- `src/server/performance/backtest-evaluation.ts`：从实验冻结成交映射为规范输入；评价查询与完整JSON导出使用相同计算，读取不修改档案。当前应用实验拒绝跨已知除权事件，不能把研究中的公司行动支持误认为应用已支持该类撮合。
- `src/components/performance/performance-report.tsx`：沿用现有布局，新增全程计数和平均盈利、平均亏损、盈亏比、胜率、利润因子、每轮平均净损益六张卡，显示单位、公式及缺失原因，不在客户端另算指标。

## 冻结样本验证

对`.data/csi800-ema50-entry-20261108-1421/`的五组结果只读补评至`.data/csi800-trade-evaluation-20261108-final/`。新代码当前完整模式1345轮、425赢/920输、14未平仓；平均盈利5646.39元，平均亏损1718.67元，盈亏比3.285，胜率31.60%，利润因子1.518，平均每轮净损益608.58元。与先前人工补算一致；逐轮独立风险台账最大误差约6.5e-11元。未覆盖层的基线也成功配出489轮，胜率57.26%，不再以缺少风险台账冒充零交易。

完整新流水线冻结于`.data/csi800-trade-metrics-replay-20261108-1558/`，五组均自动生成结构化交易指标；`execution-comparison.json`对照旧结果验证全部五组每一天净值及每笔成交精确相同。原绩效数字和前述研究判断均未被评价代码改变。新完整模式仍为年化8.64%、回撤13.95%，不是因加入胜率就认定策略优秀。

只读补评命令（输出目录必须尚不存在）：

```powershell
$env:QUANT_DATA_DIR = 'D:\github\nextjs-quant\.data\csi800-trade-evaluation-new'
pnpm exec tsx scripts/evaluate-csi800-trades.ts .data/csi800-ema50-entry-20261108-1421
```

完整重放沿用[风控规格](../product/specs/csi800-position-risk.md#6-实现与复现)命令，输出五组的`stats.tradeEvaluation`及总表。大体积输入、结果、截图仍在忽略目录/系统TEMP，不提交档案；代码、规则及测试可复现。

## 验证与提交

纯评价包14项及API/包边界定向测试通过，包含独立应用目录外ESM调用。真实浏览器控制传输验证六张卡、闭合/未闭合计数、年季月切换、加载/错误恢复及1440/400/320px无溢出通过。固定含两笔盈利/亏损的手算样本明确区分盈亏比4与利润因子8；超量卖出/负费用/伪造未平仓利润等负对照能够拒绝，不以弱化断言通过。

最终`pnpm test`通过：应用11944项，workspace策略5项、核心18项、回测60项、绩效14项，原有28项跳过。`pnpm typecheck`、`pnpm build`（含worker）、`pnpm desktop:prepare`通过。首轮类型检查发现新增测试遗漏`get<T>`泛型，已修复；最终检查通过，未修改运行逻辑规避检查。

控制传输浏览器及生产构建＋真实RPC/隔离SQLite浏览器均通过：六项指标显示、空样本/未平仓、年季月切换和JSON导出，页面胜率与导出一致。生产浏览器首次因standalone未准备静态资源，超时于旧“恢复实验”入口；确认`.next/standalone/.next/static`缺失后，使用现有`desktop:prepare`补齐并复验通过，未打包或替换release。测试截图在系统TEMP的`quant-performance-*.png`。日志见`.data/trade-performance-{tests,typecheck,build,format}-20261108.log`。

本次代码及新增文档的定向Prettier、`git diff --cached --check`通过。全仓`format:check`仍失败：102个本次提交范围外的文件格式问题，另有无关RPS任务加入的`packages/quant-rps/*.ts`空glob；与暂存文件交集为0。保留这些无关修改，不批量格式化或更改其他任务脚本。检查在共享工作区进行，提交不包含RPS源代码、根package/lockfile或受保护的`src/server/mcp.ts`。

本轮不迁移数据库，不修改正式库或外部行情，不发送通知或交易。用户已授权本地提交；提交只包括本条研究与交易评价链路，其他工作区修改保留，未推送。
