# THSDK（`hq.dll` v2.0.2）Windows x64 真实 ABI 与全能力样本实证记录

- 核验日期：2026-11-19
- 核验环境：Windows x64 / Node.js v22 / `koffi ^3.2.1`（零 Python / `pandas` 依赖）
- 发行包基线：PyPI `thsdk-2.0.2.tar.gz`（SHA-256：`12b950a81df0ddc80f577dca3aed11660e8f0c5ef59b5ef4a21846ae3915f40a`）
- 原生组件：`thsdk/libs/windows/amd64/hq.dll`
  - 体积：`11,536,896` 字节
  - PE 校验：`MZ` + `PE\0\0` + `Machine = 0x8664`（AMD64）
  - SHA-256：`d396628429f0c08809b069a20a8dd38bd4718d0361f48f41a061f688aa8323f0`

---

## 1. Windows x64 `koffi` ABI 与内存实证（Wave 0A）

| 检查项       | 实测结果                                                                                                                                                                  | 关键工程结论（写入 Wave 1 实现规范）                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 函数签名     | `void *CallAlloc(const char *request_json)`<br>`void FreeResult(void *ptr)`                                                                                               | 返回值必须声明为 `void *`（严禁 `const char *` 丢指针），并在 `try/finally` 内调用 DLL 导出的 `FreeResult(ptr)`                                                                |
| C 字符串解码 | `koffi.decode(ptr, "char", -1)`                                                                                                                                           | **实测踩坑确认**：`koffi.decode(ptr, "str")` 会把 JSON 首 8 字节当二级指针解引用导致崩溃；必须使用 `koffi.decode(ptr, "char", -1)` 解码后立即校验 `Buffer.byteLength <= 8 MiB` |
| 三重握手     | `abi_version === "2.0.0"`、`go_version === "go1.27.0"`；未知字段探针 `thsdk_protocol_probe: true` 返回 `ok: false, code: "invalid_request"`；`methods` 返回 80 项完整清单 | 启动握手零认证依赖，完整校验后才允许派发业务请求                                                                                                                               |
| 内存与限频   | 连续 200 次 `CallAlloc` + `FreeResult` 零崩溃，堆增量仅 121 KB；原生 50ms 限频窗口即时返回 `code: "rate_limited"`                                                         | 宿主队列强制 ≥60ms 间隔 + 单次 `retry_after_ms` 退避                                                                                                                           |
| 进程退出     | 结束前调用 `_close` 并直接 `process.exit(0)`，**不调用 `library.unload()`**                                                                                               | Go `c-shared` 运行时退出稳定返回 `exit 0`                                                                                                                                      |
| 会话复用     | 同 `session_dir` 二次仅传 `{ session_dir }` 调 `auth`                                                                                                                     | <100ms 复用 `account.session`，无需重复提交账密                                                                                                                                |

---

## 2. 证券市场代码映射实证（`resolve_securities`）

| 观澜规范代码            | 资产类型               | THSDK `market` | THSDK `code`        | 完整代码     |
| ----------------------- | ---------------------- | -------------- | ------------------- | ------------ |
| `sh600519` / `sh688981` | 沪市主板 / 科创板 A 股 | `USHA`         | `600519` / `688981` | `USHA600519` |
| `sz000001` / `sz300033` | 深市主板 / 创业板 A 股 | `USZA`         | `000001` / `300033` | `USZA300033` |
| `sh510300`              | 沪市 ETF / 场内基金    | `USHJ`         | `510300`            | `USHJ510300` |
| `sz159915`              | 深市 ETF / 场内基金    | `USZJ`         | `159915`            | `USZJ159915` |
| `sh000001`              | 上证指数（特例映射）   | `USHI`         | `1A0001`            | `USHI1A0001` |
| `sz399001`              | 深证指数               | `USZI`         | `399001`            | `USZI399001` |
| `bj830799`              | 北交所 A 股            | `USTA`         | `830799`            | `USTA830799` |
| 行业/概念板块指数       | 同花顺板块指数         | `URFI`         | `881273` / `882010` | `URFI881273` |

> **关键坑点**：ETF 必须使用 `USHJ`/`USZJ`（而非 `USHA`/`USZA`，误传 `USHA510300` 会返回 `no_data`）；上证指数需映射为 `USHI1A0001`。

---

## 3. 全能力真实字段与单位实证（Wave 0B）

| 能力域                   | 方法名                                                                                           | 实测状态 | 精确字段结构、时间编码与单位核验                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **日/周/月 K 线**        | `list_security_k_lines`                                                                          | `ok`     | `time`: `YYYYMMDD` 整数（如 `20261119`）；`open/high/low/close`：ETF 完整保留 3 位小数（`510300`: `4.068/4.075/4.036/4.054`）；**`volume` 单位为股/份，`turnover` 单位为元**（茅台 `6192213100 / 4269153 = 1450.45` 元/股；300ETF `11293465500 / 2790941700 = 4.046` 元/份）；`adjust`: `0=不复权 / 1=前复权 / 2=后复权`（后复权茅台 `10021.448`） |
| **分钟 K 线（1m~120m）** | `list_security_k_lines`                                                                          | `ok`     | `time`: **32 位位打包整数**（如 `132881344` = `2026-11-19 15:00`），解码公式：`year=(t>>>20)+1900, month=(t>>>16)&0xf, day=(t>>>11)&0x1f, hour=(t>>>6)&0x1f, minute=t&0x3f`；仅支持 `start=-count, end=0` 负向计数                                                                                                                                 |
| **五档盘口**             | `list_security_order_books`                                                                      | `ok`     | `bids`/`asks` 各最多 5 项 `{ price, volume }`，**`volume` 为股/份**；不含昨收/涨速/内外盘，需在独立可空 `QuoteBook` 中如实留空（`null`）                                                                                                                                                                                                           |
| **分价表**               | `list_security_price_volume_levels`                                                              | `ok`     | 茅台返回 1,390 档 `{ price, volume, in_volume?, out_volume?, transaction_count, out_volume_rate? }`                                                                                                                                                                                                                                                |
| **集合竞价**             | `list_security_call_auction_quotes`                                                              | `ok`     | 入参 `phase: "opening"                                                                                                                                                                                                                                                                                                                             | "closing"`, `date: ISO-8601 +08:00`；返回 `[{ time: unix_sec, price, cur_volume, bid2_vol, ask2_vol }]` |
| **当日/历史分时**        | `list_security_intraday_bars`                                                                    | `ok`     | 入参 `date: "0"`（当日）或 `"YYYYMMDD"`；返回 241 点 `{ time(位打包), price, volume(累计股), turnover(累计元) }`                                                                                                                                                                                                                                   |
| **每日资金流**           | `list_security_daily_capital_flows`                                                              | `ok`     | 返回 `turnover` 及主动/被动 × 特大/大/中/小单共 14 项金额（单位：元）                                                                                                                                                                                                                                                                              |
| **热度排名**             | `get_security_popularity_rank`                                                                   | `ok`     | 返回 `rank_info: { rank, rank_amount, rank_change }`                                                                                                                                                                                                                                                                                               |
| **涨停归因与异动**       | `analyze_security_limit_up` / `list_market_change_events` / `list_securities_by_realtime_signal` | `ok`     | `analyze_security_limit_up` 返回单股涨停归因结构；`list_market_change_events` 返回含 `published_at`（ISO `+08:00`）、`title`、`main_title`、`unresolved_codes` 的异动事件；非交易/收盘后 `realtime_signal` 可返回 `no_data`（需显式表达为空而非故障）                                                                                              |
| **板块与概念**           | `get_security_concept_tags` / `list_security_block_memberships` / `get_security_industry`        | `ok`     | 返回概念标签（`bond`/`normal` + `score`）、所属 40 个板块（含 `block.id` 与成分数）、行业归属（`URFI881273 白酒`）                                                                                                                                                                                                                                 |
| **问财 NLP**             | `query_wencai` / `list_wencai_hot_blocks`                                                        | `ok`     | `query_wencai` 返回 `fields`（含单位/类型/时间戳）+ `rows[{ security, cells }]`；`list_wencai_hot_blocks` 返回热门概念/行业榜（含 `tag`、`hot_tag`、`etf_name`）                                                                                                                                                                                   |
| **7×24 快讯与研报**      | `list_news_flash_items` / `list_security_research_reports`                                       | `ok`     | 快讯返回 `items[{ id, seq, title, digest, url, tags, ctime, rtime }]`；研报入参 `traversal: { mode: "page" }`，返回 `items[{ item_id, time, title, url, abstract, org, researcher }]`                                                                                                                                                              |
