# 三库公开行情 API 实测对比（2026-09-14）

本页保留补齐前的对照结果；后续实现及验收以 [tstdx 能力补齐](../2026-09-15/04-tstdx-feature-parity.md) 为准。

本轮按 [xmtdx 0.2.1](https://pypi.org/project/xmtdx/) 的 22 个公开 `get_*` 方法与 [rustdx-complete 1.11.0](https://crates.io/crates/rustdx-complete) 的行情查询入口逐项运行，再与项目 tstdx 的 9 个数据方法对比。运行发布源码/编译产物，不用其他提供商回退。

“全部”指本次列出的行情数据 API 入口，不表示所有证券、日期、参数组合均已验收。指标、日历、缓存、CLI 东财下载和 vipdoc 文件解析不是本次 TCP 对比范围。缺少对应实现明确记为未实现，不补写假接口。

## 方法对照

三个基准节点：180.153.18.170、124.71.187.122、115.238.56.198，端口 7709。基准股票 sh600000，报价另含 sz300750，指数 sh000001；日期区间 20260910—20260914。每次查询独立连接，套件最多 3 个进程并发，连接超时 3 秒，进程总预算 45 秒。xmtdx 同步/异步均实测，基准结果一致。

| xmtdx 方法                     | xmtdx 实测                                             | Rust 对应入口及结果                                                  | tstdx 对应入口及结果           |
| ------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------ |
| `get_security_count`           | 有数据：沪 27892、深 24239、北 382                     | `stock_count` 数量相同                                               | 未实现                         |
| `get_security_list`            | 沪深首批各 1000；北交所超时                            | `SecurityList` 沪深各 1000，北交所超时                               | 未实现                         |
| `get_security_list_all`        | 沪深 A 股 5224 条                                      | `stocks` 沪 27892、深 24239；包含其他证券，口径不同；北超时          | 未实现                         |
| `get_market_stat`              | 报价身份校验失败，无有效统计                           | 未实现                                                               | 未实现                         |
| `get_security_quotes`          | 空回包触发证券身份校验失败                             | `quotes` 返回空数组                                                  | `securityQuotes` 明确报错      |
| `get_price_limits`             | 输入昨收 9.26，得到 10.19 / 8.33；K线失败后按规则计算  | `limit_up_price/limit_down_price` 相同；纯本地计算                   | 未实现                         |
| `get_security_bars`            | 缺正文，解码失败                                       | `bars` 返回空数组                                                    | `barPage` 明确报错             |
| `get_index_bars`               | 缺正文，解码失败                                       | `index_bars` 返回空数组                                              | `indexBarPage` 明确报错        |
| `get_bars`                     | 自动路由到股票接口后失败                               | 股票用 `bars`、指数用 `index_bars`；均空                             | 没有自动路由封装               |
| `get_bars_range`               | 首批 K 线失败，无法形成区间                            | `bars_range/index_bars_range/k` 均空                                 | 未实现区间封装                 |
| `get_minute_time_data`         | 240 点；源码优先查当天历史分时                         | `minute` 240 点，直接协议 `MinuteTime` 也有数据                      | `minutes` 240 点               |
| `get_history_minute_time_data` | 240 点                                                 | `history_minute` 240 点                                              | `historyMinutes` 240 点        |
| `get_transaction_data`         | 空数组                                                 | `transaction` 空数组                                                 | `transactionPage` 空数组       |
| `get_history_transaction_data` | 3 条                                                   | `history_transaction` 3 条                                           | `historyTransactionPage` 3 条  |
| `get_fund_flow`                | 所依赖的报价失败                                       | 未实现                                                               | 未实现                         |
| `get_history_fund_flow`        | 直连接口无有效结果，兼容回退依赖的 K 线失败            | 未实现                                                               | 未实现                         |
| `get_xdxr_info`                | 浦发 88 条                                             | `xdxr` 88 条                                                         | `xdxr` 88 条                   |
| `get_finance_info`             | 有快照，但字段语义存在疑点                             | `finance` 有快照，同样需验口径                                       | `finance` 有快照，同样需验口径 |
| `get_company_info_category`    | 1 个栏目                                               | `f10_categories` 1 个栏目                                            | 未实现                         |
| `get_company_info_content`     | 按实际目录的文件/偏移/长度读取，7961 字符              | `CompanyInfoContent/f10` 均得到 7961 字符                            | 未实现                         |
| `get_block_info`               | 概念 269、指数 117、风格 161 个板块                    | `block` 返回扁平成分：41205 / 11557 / 20098 条，不能与板块数直接比较 | 未实现                         |
| `get_report_file`              | `tdxhy.cfg` 150332 字节；`gpcw.txt/base_info.zip` 为空 | 未提供通用报告文件入口，板块下载不等同此接口                         | 未实现                         |

所有证券数量均是本次响应，并不代表 A 股数量或永久有效值。财务快照日期为 20260828；法人股等字段超过总股本，三库一致也不能证明字段解释正确。涨跌停只验证该正常主板样本的计算结果，不代表历史规则、ST、新股规则已验收。

## Rust 额外封装与连接入口

- `k`、`bars_range`、`index_bars_range`、`k_adjusted(Qfq/Hfq)` 均执行，返回空 K 线；没有取得有效复权序列。
- `k_batch`、`bars_batch` 各查询两只股票，每项均为空；外层数组有两个对象不能算两只成功。源码内部创建默认连接池，未沿用指定 host，日志标记 `host_scope=library-default-pool`，不冒充同节点比较。
- `BlockInfoMeta` 与 `BlockInfoChunk` 均执行并有数据；高层 `block` 执行完整分片下载。F10 的目录、单栏内容、全部栏目封装均执行。
- `heartbeat`、`reconnect`、`retry` 正常路径通过；`check_alive`、`check_alive_protocol`、`check_alive_by_rtt`、`tcp_connect_ok` 已执行。正常路径不等于所有断线故障注入通过。
- xmtdx 的模块测速、同步/异步类测速、`from_best_host`、连接/关闭及上下文入口均执行；短间隔异步心跳任务存活，随后并发查询沪深数量成功。长期保活未验收。

## 内容对齐与差异

浦发 20260914 历史分时三库全部 240 点价格/量逐点一致。宁德历史分时末价 337.11，与此前腾讯日线样本相同；上一轮 xmtdx 与 tstdx 的两股票三日期全部逐点一致。

Rust 当日原始协议与高层 `minute` 的 240 点一致。宁德当日/历史分时的第 120、121 点同样存在两点差异，与 tstdx 前一轮观察相同，说明差异不是项目独有的解析现象。xmtdx 的高层当日方法优先读取历史，不能将它当作当日协议的独立验证。

历史成交尾部出现 15:00 后记录、方向 5，保留原值。当前成交在盘后均为空，不能断言盘中也不能用。所有历史深度、复权、量额单位和证券市场的全组合测试仍需单独样本。

三库均能握手，且其他命令有数据；不能继续以“整个 TCP 网络不通”解释 K 线失败。K线/报价已核对同样缺正文或空回包，尚未获得官方客户端同节点同请求的对照，仍不能确定协议变更或访问策略的具体原因。

## 覆盖计数与复现

- xmtdx：152 个调用样本（22 方法 × 2 模式 × 3 节点，再补 20 个市场/文件/周期样本）；78 非空、61 异常、13 空。另有连接辅助检查。
- Rust：108 个网络/连接/封装样本；67 非空、37 空、2 超时错误、2 批量对象（其中四个子结果全部空）。另补本地涨跌停计算 1 项，共 109 项。非空也包含数量、心跳和测速，不能当作股票行情成功率。
- tstdx：47 个公开 API 调用样本（9 方法 × 3 节点，加 10 个周期的股票/指数各一项）；15 非空、29 异常、3 空。全可用断言保持失败，不修改断言掩盖不可用项。
- “调用样本”不是底层 TCP 请求数：全列表、板块与批量封装内部还会分页。xmtdx/Rust 均额外测周期 0—11；tstdx 支持的 10 个周期全测。

工具保留在 [独立包 probes](../../packages/tstdx/tests/probes/README.md)，原始输出仅在临时目录：`quant-xmtdx-all-20260914.jsonl`、`quant-rustdx-all-20260914.jsonl`、`quant-tstdx-all-20260914.json`，以及连接/本地计算补测文件。报告提供摘要，不建立一次性结果归档库。

项目公开入口复现：

```powershell
pnpm tstdx:build
$env:QUANT_TSTDX_ALL = '1'
$env:QUANT_TSTDX_REPORT = Join-Path $env:TEMP 'quant-tstdx-all-20260914.json'
pnpm exec vitest run tests/tstdx-all-live.test.ts
Remove-Item Env:QUANT_TSTDX_ALL
Remove-Item Env:QUANT_TSTDX_REPORT
```

## 独立包交付

按用户追加授权，将协议、客户端、连接池、固定样本和离线测试整理到 [packages/tstdx](../../packages/tstdx/README.md)，通过 workspace 包依赖接入终端。终端仅保留数据库/环境变量节点设置及兼容导出。包内没有终端路径、SQLite、Next.js、zod 或其他运行时依赖；市场/证券校验保留原正则边界，Bar 类型由包自己定义。

包有自己的构建、类型声明、测试和 npm exports；tarball 已在项目外临时目录解包，使用原生 Node `import "tstdx"` 成功查询宁德历史分时 240 点、末价 337.11。没有发布 npm，也没有生成桌面安装包。独立包并未补写上述未实现接口，网络失败状态保持真实。

## 最终验证

- 独立包离线测试 59 项通过；独立包与终端 typecheck 通过。
- 终端受影响的 87 项回归通过（另 1 项原有跳过）；连接池/MCP/节点适配后续定向复查 31 项通过。
- 拆分前后公开 tstdx 实网 47 项的状态、数量及返回数据全部一致。可用性矩阵仍因 K 线/报价/当前成交失败而不通过，拆包没有弱化校验。
- 全量 2183 通过、22 跳过、1 失败：`workflow-scripts.test.ts:155` 盘后 MarketOnly=False 与固定 True 预期冲突，为此前已有失败。
- 最终 `pnpm build` 通过，包含 runtime worker 重建；构建使用隔离 QUANT_DATA_DIR。完整格式检查、diff 检查和 frozen-lockfile 离线安装通过。
- 生成的 npm tarball 仅用于仓库外导入及实网冒烟，无 npm 发布、Git 提交、推送或桌面打包。
