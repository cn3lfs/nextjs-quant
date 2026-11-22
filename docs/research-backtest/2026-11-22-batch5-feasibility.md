# 缠论 / 成长 / RPS 回测可行性（2026-11-22）

> 可行性评估，不是回测结果，也不改变任何默认能力。结论用于决定下一阶段是否立项。

## 1. 缠论原生（`research-chan`）

**已具备**：`nativeStudyStrategies = ["research-chan"]`，规则由 `createNativeStudyRule` 提供；运行时包含 `CZSC64.dll` 与 `czsc-worker.cjs`（`runtime/czsc/`）。冻结身份包含 `dllHash`、`apiVersion`、`buildCommit`、`configId`、`config=0`、`anchor=1`。

**缺什么**：诊断链路当前只走 `study-rule`，而缠论需要逐前缀的原生观察（`captureNativeChanObservations` → `nativeObservations`），并且 `prepareStrategy` 明确禁止用投影观察替代。要跑通需要：

1. 为每个标的、每个 bar 前缀调用原生 worker，产出 `FrozenChanObservation`；
2. 冻结 DLL 身份并在报告中披露；
3. 预热 140 根，确认端点语义（首次已确认且未撤销的三买）；
4. 处理逐前缀调用的时间成本与失败恢复。

**结论**：可做，但不能复用 `study-rule` 适配器；需要独立的“原生观察捕获 → 冻结 → 回放”路径。建议下一阶段先做 1 个标的的端到端验证，再扩展到 5 标的。不把缠论塞进本批 `study-rule` 矩阵。

## 2. 成长 / CANSLIM

**现状**：`research-growth` 是价格/量能代理（`canslim-high-98` 预设），已经能通过 `study-rule` 执行，属于“规则自检”级别，不读财务。

**真正的 CANSLIM 需要 PIT 财务**：

- 本地财务模型已有 `reportDate`、`announcementDate`、`availableFrom` 字段；`localFinancialTheory` 的 strict 模式要求 `announcementDate > reportDate` 且 `availableFrom <= asOf`，缺失公告日的报告会被排除。
- 本地文件来自 `E:/new_tdx64/vipdoc/cw/*.dat`（逐证券）与 `T0002/hq_cache/*cwdata.dat`，具备可用基础。
- 未核实：五只标的的财务覆盖深度、公告日完整率、追溯重述与更正记录。

**结论**：先做数据审计（覆盖率、公告日缺失率、`availableFrom` 与交易日对齐），再决定能否做 PIT 成长回测。审计通过前，`research-growth` 只能作为价格代理，不能声称是 CANSLIM。

## 3. RPS / 经典横截面

**现状**：`quant-rps` 的回填使用“当前存活证券与当前名称”，代码注释已披露生存者偏差和历史 ST 偏差；仓库没有历史指数成分、退市清单或历史名称变更表。

**结论**：当前只能做“当前池”的规则自检，不能做历史横截面外推。要做可信的 RPS/经典横截面研究，先补历史成分与退市覆盖（外部数据，需单独授权）。本阶段不立项。

## 建议顺序

| 优先级 | 事项                                           | 前置条件                                                                |
| ------ | ---------------------------------------------- | ----------------------------------------------------------------------- |
| 1      | 威科夫 LPS / 再吸筹 / 趋势回踩零入场的原因排查 | 本批已完成诊断，见[威科夫报告](2026-11-22-wyckoff-family-diagnostic.md) |
| 2      | 财务数据审计（成长 PIT）                       | 本地 `cw` 覆盖与公告日完整率                                            |
| 3      | 缠论原生单标的端到端                           | DLL 身份冻结与逐前缀捕获                                                |
| 4      | 历史成分/退市数据                              | 外部数据授权                                                            |

## 边界

- 本文件不新增回测结果，不改变研究默认口径。
- 任何“可行性”结论都以本地数据实际覆盖为准，不用当前存活样本冒充历史可得样本。
