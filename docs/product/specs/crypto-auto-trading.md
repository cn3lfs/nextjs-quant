# 数字货币现货模拟交易架构（2026-11-11）

用户授权：BTCUSDT/ETHUSDT，币安/OKX/Bybit，模拟账户，先跑通自动双均线。采用 keel 架构技能设计，coding-protocol 实现；不保留旧交易接口兼容层。历史记录只读保留，不改写。

## 决策与边界

采用应用内交易领域模块，不引入独立服务、消息总线或通用策略插件框架：当前是个人 Electron/Node 单机工作台，SQLite 和现有进程租约足以满足一致性；三平台差异通过一个 SpotAdapter 明确隔离。纯策略继续归 trading-strategies，账户和订单只归 crypto-trading，UI/tRPC 不直接签名下单。行情适配不等于交易适配，不跨平台替代策略行情。

主链：页面配置 -> 领域服务启动 -> 后台10秒调度 -> 对账 -> 已收盘K线 -> 纯规则 -> 账户资金/规则检查 -> 持久化意图 -> 平台发送一次 -> 查询订单与真实成交 -> 本地持仓投影。

- model.ts：唯一跨任务类型、Config、SpotAdapter；金额使用现有 big.js。
- adapter.ts：createSpotAdapter(config, credential)，三平台签名、时间同步、REST、交易规则、环境行情、订单/成交分页与去重；无数据库或策略控制权。
- service.ts：配置/凭证生命周期、SQLite记录、资金和持仓、发送前意图、恢复与异常状态。事实以交易所订单和成交为准，SQLite保存决策事实和可重建投影。
- router/UI：显式配置、诊断、启动摘要、启停、订单成交和错误展示；运行时仅调度服务。

## 唯一契约与职责

model.ts 的 SpotAdapter 为实施契约。service.ts 导出 cryptoBotStatus(id)、saveCryptoBot(config)、saveCryptoBotCredential({id,apiKey,apiSecret,passphrase?})、diagnoseCryptoBot(id)、controlCryptoBot({id,action:start|pause|stop})、cancelCryptoBotOrder({id,clientId})、tickCryptoBots()。status 返回 {bot,credentialConfigured,orders}；未知账户返回 bot:null。save 返回 BotState。diagnose 返回 Snapshot。每个平台环境一个账户/实例，id=venue-network；币安支持demo/testnet，其余仅demo。credentials按账户ID使用DPAPI，返回值不包含秘密。

## 规则与恢复

1小时SMA5/20默认，每币启动可用USDT的40%，参数可配置但两币总上限80%。首次只建立均线基线，不补发旧信号；暂停/停止不清仓、不重置资金。只有空仓金叉买入，持仓死叉卖出，买入按USDT预算下单（向下保留两位并预留1%费用），基础币估算仅用于规则预检；卖出按基础币数量向下量化。手续费预留1%。已持有数量只来自本策略成交，外部存量不接管。

每账户串行；后台单宿主租约，领域写操作与tick共享账户互斥，发送前SQLite原子写唯一clientId。订单先写发送意图再进行I/O，崩溃后按客户端编号查询，未知结果不重发。部分成交按成交ID去重，手续费币种决定持仓/现金影响。终态也必须确认累计成交和成交明细一致后释放资金；无法收敛暂停账户，允许继续对账。外部余额变化检测暂停。关闭应用/休眠后先对账并基线重建，不补历史交易。手动旧入口退休或改为同一领域入口，不能成为第二资金写入者。

模拟环境硬编码，拒绝自定义私有域名和实盘配置；凭证变更须停止且无未完成订单。停机不承诺后台常驻。无交易凭证时可完成离线流程验证，不能声称平台联调通过。

## 分工和验收

平台Agent负责adapter.ts及适配测试；执行Agent负责service/store及恢复测试；界面Agent负责router、root接线、UI及旧入口退休；主Agent负责model、纯策略、runtime接线、集成修复与最终验收。各Agent读取coding-protocol，只编写测试不单独运行，集成后统一检查。所有验证数据库隔离，不访问默认生产库。

验收：均线、连续已收盘K线、精度/规则、签名/模拟路由、重复发送、超时/崩溃/重启、部分成交/扣币手续费、外部余额、双币预算、暂停竞态、三平台真实响应fixture。集中执行类型、测试、构建/runtime、desktop:prepare；失败按原因修复复验。不承诺一次必过，不把fixture当平台实测。不提交/推送/打包，不动MCP保护文件。

官方依据：Binance https://developers.binance.com/docs/binance-spot-api-docs ; OKX https://www.okx.com/docs-v5/en/ ; Bybit https://bybit-exchange.github.io/docs/v5/demo 、/order/create-order 、/market/instrument 。OKX模拟header和Passphrase、Bybit Demo私有域及现货数量单位分别处理。

## 策略与执行扩展点

以后增加策略时，新增纯 evaluator，输入已完成行情及策略参数，输出可审计决策（策略ID/版本、参数、输入K线时点、目标方向及指标证据）；现有订单状态机、余额约束、平台适配和对账流程共用，不允许策略直接签名、下单或改写持仓。v1采用显式双均线 evaluator，不预建动态脚本/LLM代码执行或插件加载器。

以后扩展执行方式时，在订单意图/适配器边界增加明确能力（如限价、有效期），保留统一事实与恢复，不把平台差异泄漏到纯策略。合约需要独立持仓/保证金领域模型，不能给现货模型添开关冒充支持。本轮仅市价现货，是可扩展边界而非全品种交易引擎。

典型维护路径：修改均线只涉及策略包/evaluator；增加交易平台只实现SpotAdapter及凭证配置；调整恢复/资金规则只改领域服务；UI不是第二交易执行器。冻结决策证据使参数变更不改变旧单含义。


## 首版账户身份限制

本版没有交易所账户 UID 的已核验契约。为避免更换凭证后把另一账户资金或成交混入已冻结账本，模拟实例首次启动后禁止更换凭证（包括停止后），界面明确禁用并说明尚不支持密钥轮换；首次启动前可在停止且无未完成订单时更新。后续须先实现账户身份核验，再开放同账户密钥轮换，不通过重置或删除账本绕过。账户诊断仅是请求时快照，不是实时权益；每币预算展示为冻结启动 USDT 乘配置比例。

最终集成收口：买入quoteBudget明确区分报价币预算与基础币估算数量，三平台实际成交数量为事实；运行时合并重叠调度，前一轮未完成不新增排队。
