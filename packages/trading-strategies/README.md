# trading-strategies

独立的代表性交易策略目录。它只暴露每个大方向的一种标志性策略和证据边界，不复制研究引擎，也不把中间回测文件打包进来。

## 当前代表

| 方向 | 代表 | 当前状态 |
| --- | --- | --- |
| 双突破 | `sw-double-prior20` | B3 完成归档，标签为样本不足 |
| 技术指标共振 | `sw-confluence` | B3 完成归档，标签为样本不足 |
| 量价 | `vp-up-expanded-confirm` | B3 完成归档，标签为样本不足 |
| Wyckoff | `wy-sos-daily` | B4 部分归档，当前观察无事件 |
| 缠论 | `chan-third-native` | B4 部分归档，czsc 基线未独立验证 |
| 成长股 | `canslim-high-98` | 已实现，未真实回测 |
| 价值 | `FA08` | 工程版本，S7 未开始 |
| 情绪 | `MS04` | 工程版本，S7 未开始 |
| 产业链 | `IC04` | 工程版本，S7 未开始 |

完整方法仍在工作台的 method-map 和源代码中保留，用于溯源、审计和后续研究；本包的“代表”不是删除其他研究方法，也不是性能排名。`FA08`、`MS04`、`IC04` 是 method ID，不冒充 preset；缠论和 Wyckoff 代表当前只达到 raw-only 证据级别。

## 开发

```powershell
pnpm --filter trading-strategies test
pnpm --filter trading-strategies typecheck
pnpm --filter trading-strategies build
```

固定输入测试和历史回测统计都是程序/研究证据，不是盈利证明。A 股交易规则、复权、证券池时点和缺失数据边界以工作台文档为准。

公开标识：`id` 是稳定代表 ID，`methodId` 是方法，`presetId` 是可选参数预设。无预设保持缺失；未回测条目不允许 evidence，已观察条目的 evidence.readiness 必须匹配。

工作台通过 workspace 依赖接入研究页的“九方向代表策略”。选择代表只填写已有研究预设；无 preset 的三个方法仅作参考。根 `dev`、`build`、`typecheck`、`test` 均先构建本包，根 `test` 也显式运行包内测试。
