# 缠论原生捕获 spike（2026-11-22）

> 可行性验证，不是缠论策略回测，也不评价三买信号的收益。

## 目标

验证 `research-chan` 进入诊断矩阵前必须解决的两件事：逐前缀原生观察能否稳定捕获，以及成本是否可接受。

## 环境与身份

- worker：`runtime/czsc-worker.cjs`，DLL：`runtime/czsc/CZSC64.dll`（均由 `pnpm runtime:build` 生成）
- 冻结身份（与捕获结果一致）：

```json
{
  "dllHash": "257ecbfce519ab8790d637386bf56b2860e5678f8854f86b4d4a3e82efb00cae",
  "apiVersion": 22,
  "buildCommit": "27de58024474",
  "configId": "stroke.rule=strict;stroke.endpoint=extreme;stroke.gap=none;segment.method=feature;segment.startBreak=keep;center.strokeFormation=entry;signals.publication=standard",
  "config": 0,
  "anchor": 1
}
```

## 结果：`sh600519`

数据：`E:/new_tdx64` 原始未复权日线 6,047 根，截止 2026-11-20；`first = 140`（预热）。

| 指标             |                                   数值 |
| ---------------- | -------------------------------------: |
| 前缀数           |                                  5,908 |
| 总耗时           |                                87.1 秒 |
| 观察数           |                                  5,908 |
| 审计事件         |               46（首次观察/修订/撤回） |
| 末次前缀活动信号 | 23 个（各观察重复计入，未按 key 去重） |
| 首个信号确认日   |                             2002-07-25 |

短窗口复核：最近 261 个前缀 7.2 秒，身份与信号集合一致；单次 DLL 调用随前缀增长，2,000 根约 8ms、6,047 根约 22ms（首调含 worker 初始化，约 75ms）。

## 结论

- 逐前缀捕获在单标的全历史上可行：约 1.5 分钟/标的，5 标的预计 7–8 分钟，不需要额外优化即可进入下一阶段验证。
- DLL 身份、config、anchor 都能在捕获结果中冻结，满足“原生结构不能回填端点日期”的约束。
- 捕获层已经能产出 `FrozenChanObservation[]`；尚未接入诊断回放。

## 接入缺口

1. `study-rule` 不支持原生观察：`prepareStrategy` 明确拒绝“投影观察”替代逐前缀输入，`createExtendedStudyRule("research-chan")` 返回 null。
2. 诊断 CLI 目前只走 `prepareLabBacktest` → `runPortfolio` 的普通规则路径，没有把 `nativeObservations` 传给 `replayDailyStudy`。
3. 需要新增一条原生适配路径：捕获观察 → 冻结 → 单标的回放 → 与普通 cell 相同的诊断/账本检查；不能把缠论硬塞进 `study-rule`。

## 下一步

1. 在诊断脚本里加 `research-chan` 的原生分支：复用 `captureNativeChanObservations`，把观察交给 `replayDailyStudy` 的 native 入口。
2. 先跑 `sh600519` 单标的，核对成交、账本、DLL 身份披露与耗时。
3. 通过后再扩到五标的；预热 140、固定持有 5 日退出的语义保持 `nativeStudyDefinition` 原样。

## 产物与边界

- 摘要：`.test-data/backtest-diagnose/chan-spike/full-summary.json`
- 脚本：`.test-data/backtest-diagnose/chan-spike/{probe260.mts,full.mts,cost.mts}`
- 只验证了 1 只标的、日线、默认 config；未验证 5 分钟周期、其他 config 或全市场。
- 未做收益、胜率或信号有效性评价；23 个活动信号不是三买策略业绩。
