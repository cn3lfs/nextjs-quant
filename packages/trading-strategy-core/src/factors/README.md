# 共享技术因子

`trading-strategy-core/factors` 是财务组合筛选与策略研究共同使用的纯计算层，不依赖应用、文件系统或回测任务。

- 统一 `factorCatalog`、`FactorSpec`、`resolveFactor`、`calculateFactor`，序列与输入等长，缺失为null，计算不修改输入。
- `factorSpecSchema` 和 `factorConditionSchema` 由本层拥有，统一参数默认值、未知项拒绝、比较和上下穿契约。应用与回测包直接消费，避免互相依赖。
- 当前76个模块：22个通用技术指标、41个Qlib模块、13个Alpha101时序公式。Qlib标准窗口展开157/158项，VWAP0缺少已验证输入；Alpha101仅13/101项，不把横截面排名改成时序排名冒充完整库。
- 参数周期单位为根。公开公式原始日频，在五分钟运行属于明确的按根迁移；不声称与聚宽平台数值或收益等价。
- 冻结来源、版本和许可证位于 `docs/data-sources/public-factors/`；主仓独立参考值测试核对157项Qlib特征及全部来源哈希。

```ts
import {calculateFactor,factorConditionSchema} from "trading-strategy-core/factors";
const values=calculateFactor(bars,{id:"sma",parameters:{period:20}}).values;
const condition=factorConditionSchema.parse({left:{id:"sma"},operator:"gt",right:{constant:10}});
```

条件契约不负责撮合、账户、证券池或持久化；这些由消费者按自己的业务执行。
