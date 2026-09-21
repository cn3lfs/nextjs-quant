# B1 未完成交接（2026-09-16）

本次没有新增B1实现，不将来源阅读、报告诊断或下述缺口核对算作子任务完成。D0b/D0c之后尚未完成B1子任务1；子任务2–5也未开始。L3 未执行。

## 机器审计状态

由 `pnpm exec tsx scripts/audit-trading-methods.ts` 输出：全表 before/after 均为 total 695 / planned 552 / variants 138 / implemented 5，changes=[]；B1 planned 128 / variants 25 / implemented 0。本次新增完成ID为空。以下ID直接取 deliveryBatches.B1.pendingIds，不另手工推算。所有条目仍缺的直接原因是本次未完成实现与子任务验证，不能统称为外部数据阻塞。

### 评分与入口评分

`CA-S-C1`, `CA-S-C2`, `CA-S-C3`, `CA-S-A1`, `CA-S-A2`, `CA-S-A3`, `CA-S-N1`, `CA-S-N2`, `CA-S-S1`, `CA-S-S2`, `CA-S-L1`, `CA-S-L2`, `CA-S-I1`, `CA-S-I2`, `CA-S-M1`, `CA-S-M2`, `CA-S-M3`, `CA-S-C1-turnaround`, `CA-S-A1-turnaround`, `CA-S-A1-loss-exclusion`, `CA-S-N1-rumor2`, `CA-S-N1-product`, `CA-S-N1-management`, `CA-S-N1-policy`, `CA-S-N1-contract`, `CA-S-N1-incentive`, `CA-S-N1-forecast50`, `CA-S-S1-limitup`, `CA-S-S1-crash`, `CA-S-S2-unlock`, `CA-S-S2-buyback`, `CA-S-L1-ipo`, `CA-S-I1-turnover`, `CA-S-M1-200`, `CA-S-total-absolute`, `CA-S-total-ratio`, `CA-S-C-downgrade`, `CA-S-M-warning`, `CA-S-missing`, `CA-B-C1`, `CA-B-C2`, `CA-B-C3`, `CA-B-A1`, `CA-B-A2`, `CA-B-A3`, `CA-B-N1`, `CA-B-S1`, `CA-B-S2`, `CA-B-L1`, `CA-B-L2`, `CA-B-I1`, `CA-B-I2`, `CA-B-M1`, `CA-B-M2`, `CA-B-M3`, `CA-S-weighted-ratio`, `CA-S-ipo-year-confidence`

### 其他成长股方法

`SE01`, `SE02`, `SE03`, `SE04`, `SE05`, `CA01`, `CA02`, `CA03`, `CA04`, `CA05`, `CA06`, `CA07`, `CA08`, `SE05-weekly-ma`, `SE05-elite`, `CA-K-kelly25`, `SE-K-kelly`, `SE-E-five`, `SE-E-volume-levels`, `SE-E-intraday50`, `SE-E-close`, `SE-R-min`, `SE-R-max`, `SE-R-min-cap`, `SE-D-be15`, `SE-D-review23`, `SE-D-time4`, `SE-D-bear4`, `SE-D-targets`, `SE-D-partial2030`, `SE-D-gapup3`, `SE-D-gapdown3`, `SE-E-volume50`, `SE-E-earnings13`, `SE-P-tplus`, `SE-P-standard`, `SE-E-exclusions`, `SE-E-checklist`, `SE-K-quality`, `CA-K-quality`, `WY-K-quality`, `SE-K-script-quality`, `CA-E-five`, `CA-E-rs80`, `CA-E-markettrend`, `CA-E-catalyst`, `CA-R-pivot-max`, `CA-D-volume-sell`, `CA-D-distribution5`, `CA-P-full`, `CA-P-add23`, `CA-D-gapup3`, `CA-D-gapdown3`, `CA-E-earnings5`, `CA-E-cooldown`, `CA-E-reward25`, `CA-E-m6`, `CA-D-review1430`, `CA-E-exclusions`, `CA-T-handle-third`, `CA-T-sector`, `CA-T-smallcap`, `CA-T-earnings-window`, `CA-T-window120`, `CA-T-gate2-fallback`, `CA-E-five-soft`, `CA-E-checklist70`, `CA-E-soft-overrides`, `CA-E-reported5`, `CA-L-query-screen`, `CA-E-ipo60-risk`

## 下一个子任务的确切起点

从 `canslim-analyst/references/canslim-scoring.md` 全文及入口简表差异开始，按 canslim-audit 的评分表逐项实施；不是只加1–2个预设。已核对可复用 canslim-earnings/finance/volume/float/market/follow-through/institutions/new-high/scorecard，现有报告模块不能直接算历史策略实现。

首先补研究输入的时点适配及明确版本，然后在 research-canslim-strategies.ts 家族声明、research-rule-series.ts 历史计算入口及 research-signals → research-run 真实链路接入，逐项绑定method-map并加入注册驱动契约。现有 research-dataset 仅采集行情、基准和公司行动；buildCanslimDossier 明确拒绝 historicalAsOf；canslimRs/sectorRank 即使可算观察分，也保留历史池/行业归属未经核验的missing，不得解除后直接当完整因子。

待核验历史字段：季度/年度EPS、营收与利润同比、ROE口径、每股现金流的披露与修订版本；逐日流通股本与当时已知解禁/回购计划；机构股数/家数/比例及前十持有人分类版本；催化事件身份、公开/采集/落地/失效时间；沪深300完整日历；RS同日历史证券池与行业成员及可比价格。覆盖区间目前未核验，不能声称这些字段任何历史区间已可用，也不能推断全球源不存在数据。缺失不填零，报告文字不变历史因子。

评分冲突延续既有审计：入口二值与细则分层分名；114分项和/原称116/百分比权重分名；N1传闻2/0分、A1删除亏损年分母、M1标题200/正文250分别冻结版本；CA-B-N2已实现不重做。本次未新增策略裁定或预设。子任务1完成后跑L2，再按原顺序entry-exit → SEPA两道门 → VCP/枢纽 → RS机构催化；批末才跑L3。
