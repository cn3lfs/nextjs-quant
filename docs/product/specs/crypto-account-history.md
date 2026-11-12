# Feature: 数字货币账户持仓与历史成交同步

> Size: M | Status: locally verified (live account not tested) | Updated: 2026-11-12

## 产品定义（product-delivery）

个人用户需要在同一页面看到交易平台现在持有什么、过去实际成交了什么；现有策略数量与最近200笔本策略订单不能回答账户整体情况。成功标准：已配置模拟账户同步后，能查看BTC/ETH/USDT余额和BTCUSDT/ETHUSDT的账户成交，按时间/币对/方向/来源分页阅读，重复同步无重复记录。

A1 延续已授权三平台模拟现货，不扩展实盘/合约。A2 当前关注BTC/ETH两交易对，当前资产显示BTC、ETH、USDT。A3 首次默认最近30天，可选范围补同步（单次最多90天）；平台自身保留期如实披露。不是历史全覆盖或成本/盈亏系统。

**R1 当前持仓 (Must)**
- R1.1 GIVEN 已配置账户 WHEN 同步成功 THEN 显示平台总量、可用、冻结、更新时间，BTC/ETH现价与估算市值可得时显示；与策略持仓数量明确区分。
- R1.2 GIVEN 行情失败 WHEN 余额成功 THEN 数量仍可见，估值为空并说明；不得用0假装估值。
- R1.3 GIVEN 暂停/停止的策略 WHEN 查看账户 THEN 仍可只读同步，不启动策略、不下单或接管原有持仓。

**R2 历史成交 (Must)**
- R2.1 GIVEN 账户有本策略以外成交 WHEN 同步 THEN 同样入库并显示时间、币对、买卖、数量、价格、金额、手续费及原币种、平台成交/订单编号。
- R2.2 GIVEN 同一订单多次成交或多次同步 WHEN 查询 THEN 每笔成交独立显示且不重复；与已有本策略订单编号匹配才标“本策略”，未知来源标“平台成交”，不臆称手动交易。
- R2.3 GIVEN 多页成交 WHEN 翻页或筛选 THEN 服务端稳定分页（默认50、最多100），总数来自完整筛选集合，不截断最近200条。
- R2.4 GIVEN 平台保留期/分页上限或请求失败 WHEN 同步结束 THEN 已获取记录保留，显示失败/部分同步、覆盖范围与原因，不能把未查询或不可得历史当成没有成交。

**R3 账户与状态 (Must)**
- R3.1 GIVEN 多个平台/环境 WHEN 切换 THEN 数据、同步状态与凭证版本隔离；同步不改变策略资金基线、策略持仓或A股账本。
- R3.2 GIVEN 无凭证/首次同步/空结果/失败 WHEN 阅读 THEN 分别展示未配置、加载、该已查询范围无记录、失败且保留旧快照的状态。
- R3.3 GIVEN 页面可见且账户已配置 WHEN 进入或满60秒 THEN 自动进行账户增量同步；隐藏页面停止轮询，保留手动同步和自选范围补同步。

Should：账户读取独立于策略执行锁，长历史回补不阻塞自动交易。暂不提供成本、盈亏、持仓来自哪一笔买入、跨币换算、CSV或实盘。

## 页面流程

沿用DESIGN.md Nocturne主题和现有Panel/Table/Select/Button。所选账户下先显示“平台当前持仓”，再显示“历史成交明细”。账户同步状态、快照时间、范围/保留期提示靠近同步按钮；历史提供起止日期、币对、方向、来源、查询及上一页/下一页。宽表仅在容器内滚动。策略配置与本策略订单保留原区块；独立账户组件接收所选id与凭证是否配置。

## 架构决策（keel，Decision -> Closed）

增加crypto-trading领域内部的账户只读同步服务，不把账户全部历史塞入策略订单表，也不从历史推算当前账户余额。交易所余额是当前持仓事实；交易所每笔成交是历史事实；本地缓存/分页仅是可追溯副本。纯策略包不变。相比复用策略project()/baseline，此结构避免手动成交被当作策略资产，且能支持之后多个策略共用同一账户读模型。

平台adapter新增独立AccountHistoryAdapter能力，保留SpotAdapter现有执行契约不变，工厂返回更完整类型。账户同步使用独立跨进程读同步租约，短时读取配置/DPAPI上下文使用现有账户锁；网络回补不持有执行写锁。凭证保存更新随机revision；缓存与成交按账户+revision隔离，每次提交前检查revision，旧请求不得写入新账户视图。首次启动后的凭证限制不变。

每次先同步账户快照（数量事实与可选估值分别处理），再按平台时间窗口逐交易对取历史并持久化；增量从上次完成时间回退1小时重扫，首轮30天。显式补同步只处理指定范围，不向后移动增量水位。每页/时间窗失败保留已完成范围；只在BTC/ETH的近期范围完整后推进水位。成交编号按账户/revision/币对/订单ID/平台成交ID唯一，已记录业务字段冲突报错，不能改写事实。后台崩溃后通过租约pid存活判定显示中断并允许重试。余额刷新不依赖历史是否完整。

不新增依赖或数据库schema迁移，使用现有records和SQL JSON过滤/分页。没有旧接口转发层，新增的是有独立事实职责的账户读模型。无通知、交易写入、重置账本、自动调整基线。

## 接口契约（实现前锁定）

account-model.ts维护PlatformTrade、AccountSnapshot、AccountSyncState及页面输入输出类型。adapter新增tradeHistory(symbol,from,to):Promise<PlatformTrade[]>，时间为UTC毫秒半开区间[from,to)，不按本系统订单ID筛选，分页完整或明确抛错。

- getCryptoAccountReadContext(id)内部服务：短锁读取{config,credential,revision}，不接入API；凭证revision变更原子记录。
- syncCryptoAccount({id,from?,to?}) mutation：默认增量/首轮最近30天，显式范围最多90天；返回AccountSyncState。
- cryptoAccountView({id,symbol?,side?,source?,from?,to?,page=1,pageSize=50}) query：返回{snapshot,sync,rows,total,page,pageSize}，rows来源动态关联全量策略订单，不碰执行账本。

同步和query输入严格校验；当前快照每次成功读取覆盖，历史追加去重。平台限制依据官方myTrades、OKX fills-history、Bybit execution/list及Demo文档核对，展示保留期限制；不得为补齐显示伪造成交。

## Tasks

- [x] T1 -> R2.1/R2.2/R2.4 三平台非订单限定历史查询、窗口/分页/非法响应fixture。
- [x] T2 -> R1/R2/R3 账户同步服务、持久化、范围覆盖、版本隔离、分页、故障恢复。
- [x] T3 -> R1/R2/R3 页面和tRPC，产品状态与筛选/同步/翻页流程。
- [x] T4 -> 全部 主Agent集中集成、类型/全仓测试/build/runtime/desktop:prepare/隔离浏览器验收，记录未执行真实平台联调。

## 验收映射与发布

R1 -> 数量/冻结/行情缺失fixture与页面；R2 -> 三平台手动来源样本、分页重复、完整范围失败样本；R3 -> 版本切换、无凭证、失败保留快照、停止策略只读同步、界面可见性。Agent各自读取coding-protocol实现并编写测试，不单独跑检查；由主Agent集中验收修复。保留用户工作区与MCP保护文件，不提交/推送/打包。真实账户数据不在本地fixture验证中冒充已同步。

用户可见变更：数字货币页面新增平台当前持仓和账户历史成交，可同步已有成交并按范围筛选阅读。

## 集成复核修正

官方Demo文档只明确Bybit订单保留7天，不能推断execution/list的全部成交硬截止为7天；因此按用户请求范围实际分窗读取，不主动丢弃较早成交。提示平台真实保留期和空响应的证据边界。官方来源：[Bybit Demo](https://bybit-exchange.github.io/docs/v5/demo)、[成交接口](https://bybit-exchange.github.io/docs/v5/order/execution)、[OKX](https://www.okx.com/docs-v5/en/)、[Binance](https://developers.binance.com/docs/binance-spot-api-docs)。

历史读取按每实例250ms最小起始间隔串行，覆盖分页及跨交易对读取，不修改下单/撤单/执行对账节奏。初次和范围回补可较慢，页面显示逐窗进度。成交唯一键包含订单号，避免跨订单共用撮合成交编号导致遗漏。OKX接口按记录创建时间过滤，而页面按fillTime展示；读取到观察时刻后筛选成交时间，1小时增量重叠不能保证抓到任意延迟的旧记录，可显式重扫旧范围。

## Test results（2026-11-12）

| Criterion | Test | Result |
|---|---|---|
| R1.1/R1.2/R1.3 | 服务fixture余额/冻结/报价缺失、无策略状态写入；页面平台2BTC与策略0.1对照 | 本地通过，真实余额接口未联调 |
| R2.1/R2.2 | 三平台外部成交/同毫秒1000+/跨订单编号/不明来源、71行浏览器来源筛选 | 本地通过，真实成交导入未执行 |
| R2.3 | 205行SQL稳定分页；浏览器50+21及ETH卖出12条 | 通过 |
| R2.4 | 游标循环、缺失费用、冲突、失败保留、Bybit较早记录、未覆盖提示 | 本地通过 |
| R3.1/R3.2 | revision在途检查、停止账户只读/失败保留、浏览器账号隔离/无凭证禁用 | 通过 |
| R3.3 | 可见初次请求及失败暂停实测；60秒定时与隐藏清理实现审查 | 部分实测；成功后连续实源轮询未测（无真实凭证） |

主工程12138项+包194项全仓基线通过，保留28项既有跳过；最后节流与保留期修正另跑71项相关回归通过。最终类型、构建/runtime、desktop:prepare通过，具体缺陷修正、边界和验证产物见[交付](../../deliveries/2026-11-12-crypto-account-history.md)。不声明已同步真实账户，不发布或打包。
