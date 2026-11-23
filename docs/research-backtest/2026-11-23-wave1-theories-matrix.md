# Wave 1–3 真实数据验证矩阵：原生缠论全谱、12 股分层成长与威科夫漏斗

日期：2026-11-23  
本地行情与财务源：`E:/new_tdx64`（严格只读，日线截至 `2026-11-20`；财务包 `vipdoc/cw/gpcw*.dat`）  
原生缠论二进制：`runtime/czsc-worker.cjs` + `CZSC64.dll`（API v22，config 0，anchor 1，`dllHash` 前缀 `257ecbfce519ab87`）  
执行隔离：全量通过独立隔离 `QUANT_DATA_DIR` 运行；SQLite `PRAGMA user_version = 23` 零迁移；收尾核验 **0 残留 `czsc-worker` 进程**。

> **口径与幸存者偏差声明**：`core-12`（12 只精简分层验证池）与 `chan-core-7`（7 只原生缠论代表池）用于投资理论机制验证、逐层条件漏斗消融与执行诊断，**不代表无幸存者偏差的全市场历史收益**；历史 ST、退市、首次披露财报版本与真实盘口排队成交仍保留为显式未知项。工程健康（`ok / 0 P0`）与研究有效性分开表述。

---

## 1. 总览：288/288 真实单元全绿、0 阻断、0 P0

| 批次 | 标的池 | 模式与执行档 | 单元数 | 结果 (`ok / blocked / failed`) | 核心验证结论 |
| :--- | :--- | :--- | :---: | :---: | :--- |
| Matrix A | `core-12`（12 股） | `per-symbol` · `strict` | 204 | **204 / 0 / 0** | CANSLIM strict-PIT + `M` + 退出消融、SEPA PIT、威科夫三策略漏斗、VCP/IBS 横向对照全绿 |
| Matrix B1 | `sh600519 + sh688981` | `both` · `strict` | 18 | **18 / 0 / 0** | 跨上市日多标的组合（`firstIndex` 4647/140）首轮冷捕获 3 次 + 暖命中 17 次 |
| Matrix B2 | `sh600519 + sh688981` | `both` · `clamp` | 18 | **18 / 0 / 0** | 共享投影暖缓存 **0 冷 / 20 暖（0 新增 DLL build）** |
| Matrix B3 | `sh600519 + sh688981` | `both` · `cap-0.5-clip` | 18 | **18 / 0 / 0** | 共享投影暖缓存 **0 冷 / 20 暖（0 新增 DLL build）**；容量裁剪实际生效 |
| Matrix B4 | `chan-core-7` 余下 5 股 | `per-symbol` · `strict` | 30 | **30 / 0 / 0** | 每股 1 次冷捕获（5 冷）+ 余下 4 缠论策略 **20 暖命中（0 新增 DLL build）** |
| **合计** | — | — | **288** | **288 / 0 / 0** | **0 P0，0 残留 `czsc-worker`** |

---

## 2. 原生缠论全谱与多标的组合（`chan-core-7` + `sh600519 + sh688981`）

### 2.1 共享投影缓存效率与旧三买回归一致性

- **旧三买逐字节回归**：`sh600519`（`2002-04-05`–`2026-11-20`，5,908 前缀）`research-chan` 与 `research-chan-third` 产出完全一致（46 笔成交），五份产物与既有 strict 基线逐字节一致。
- **0 新增 DLL build 实证**：
  - `sh600519 + sh688981` 首轮（`strict`）共冷捕获 3 次（单股 `sh600519@140` 5,908 前缀 / 104.4s、`sh688981@140` 1,395 前缀 / 5.5s、组合窗 `sh600519@4647` 1,401 前缀 / 41.7s），其余 17 处直接命中缓存；`clamp` 与 `cap-0.5-clip` 两档均为 **0 冷 / 20 暖**。
  - `chan-core-7` 其余 5 股（`sz000001` 8,341 前缀、`sh601318` 4,590、`sz300308` 3,244、`sz000333` 2,999、`sz300750` 1,911）仅在 `research-chan` 首跑各捕获 1 次，`research-chan-first/second/third/hold-cash` 全部命中缓存（**5 冷 / 20 暖**）。

### 2.2 全谱买卖点与 `CH14` 真实卖点退出统计

| 范围与档位 | 策略 | 信号数 | 委托数 | 成交数 | 拒单数 | 容量裁剪成交 | 平仓交易 | 有成交标的数量 |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| 双股单标 `cap-0.5-clip`（2 股） | `research-chan` / `research-chan-third` | 32 | 61 | 61 | 9 | 8 | 29 | 2/2 |
| 双股单标 `cap-0.5-clip`（2 股） | `research-chan-first`（`CH01`） | 1 | 2 | 2 | 0 | 0 | 1 | 1/2 |
| 双股单标 `cap-0.5-clip`（2 股） | `research-chan-second`（`CH02`） | 0 | 0 | 0 | 0 | 0 | 0 | 0/2 |
| 双股单标 `cap-0.5-clip`（2 股） | `research-chan-hold-cash`（`CH14`） | 50 | 38 | 42 | 5 | 10 | 17 | 2/2 |
| 双股组合 `2021-02-08~2026-11-20`（`cap-0.5-clip`） | `research-chan` / `research-chan-third` | 9 | 17 | 16 | 1 | 0 | 8 | 1 组合 |
| 双股组合 `2021-02-08~2026-11-20`（`cap-0.5-clip`） | `research-chan-hold-cash`（`CH14`） | 13 | 11 | 10 | 1 | 0 | 4 | 1 组合 |
| `chan-core-7` 余下 5 股（`strict`） | `research-chan` / `research-chan-third` | 78 | 147 | 138 | 18 | 0 | 69 | 5/5 |
| `chan-core-7` 余下 5 股（`strict`） | `research-chan-first`（`CH01`） | 23 | 45 | 44 | 7 | 0 | 22 | 5/5 |
| `chan-core-7` 余下 5 股（`strict`） | `research-chan-second`（`CH02`） | 13 | 26 | 26 | 1 | 0 | 13 | 5/5 |
| `chan-core-7` 余下 5 股（`strict`） | `research-chan-hold-cash`（`CH14`） | 160 | 104 | 98 | 12 | 0 | 48 | 5/5 |

---

## 3. 12 股分层池成长股消融（CANSLIM PIT / `M` / 退出 / SEPA PIT）

### 3.1 CANSLIM 逐层过滤与真实退出消融（`core-12` · `strict`）

| 策略层级 | 说明 | 信号数 | 委托数 | 成交数 | 拒单数 | 平仓交易 | 有成交股数 |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| `research-growth` | 纯价量基线（`canslim-high-98` + 5-bar） | 1,670 | 1,339 | 1,275 | 117 | 637 | 12/12 |
| `research-canslim-pit` | + strict-PIT 财务（`C1/A1/A2`，公告后首日可见） | 128 | 99 | 96 | 9 | 48 | 7/12 |
| `research-canslim-pit-m` | + `sh000300` `M` 大盘制度（当日缺失 fail-closed） | 68 | 53 | 52 | 2 | 26 | 7/12 |
| `research-canslim-pit-ma20` | 同 CANSLIM+`M` 入场 + `MA20` 收盘破位退出 | 24,461\* | 36 | 36 | 0 | 18 | 7/12 |
| `research-canslim-pit-ma50` | 同 CANSLIM+`M` 入场 + `MA50` 收盘破位退出 | 23,591\* | 22 | 22 | 1 | 11 | 7/12 |
| `research-canslim-pit-stop8` | 同 CANSLIM+`M` 入场 + `8%` 固定止损（实成交成本） | 42 | 16 | 16 | 1 | 7 | 7/12 |
| `research-canslim-pit-stop7` | 同 CANSLIM+`M` 入场 + `7%` 固定止损敏感性 | 42 | 16 | 16 | 2 | 7 | 7/12 |
| `theory-vcp-close` | 横向对照：日线 VCP 收盘突破 | 33 | 33 | 28 | 6 | 14 | 5/12 |
| `classic-ibs` | 横向对照：经典 IBS 短线均值回归 | 52,338 | 27,308 | 21,753 | 6,611 | 10,876 | 12/12 |

*\*注：`MA20` / `MA50` 退出规则按日输出布尔退出信号，因此 `signals` 计数含空仓日退出信号（撮合引擎对空仓忽略退出信号，零误下单）。*

- **12 股分层扩展效果**：在 5 蓝筹基线上 `research-canslim-pit` 仅 2 只成交；扩展至 `core-12` 后，**7/12 只标的产生真实成交**（`sh601899` 28、`sz300308` 22、`sh600519` 18、`sz000858` 12、`sz300274` 10、`sz002594` 4、`sz300750` 2），共 96 笔成交。
- **重复财务记录显式披露**：`sz300750`（宁德时代）在 `vipdoc/cw/gpcw20251231.dat` 中存在 2 条重复记录（`sourceIssuesCount = 29`，其余标的为 `27`），诊断披露面板与 `run.json` 均已显式列出，不静默丢弃或补造。

### 3.2 SEPA strict-PIT 漏斗实证（`core-12`）

- 财务侧 strict-PIT（`FN230`/`FN232`/`FN281`）在 12 股中已有 **7 只**满足 `strict-pass` 或 `tolerant-pass`（如 `sh600519` 864 严通 + 277 宽通日、`sz000858` 573 + 287、`sz300308` 385 + 121、`sh600276` 345 + 352、`sz300274` 299、`sh601899` 154、`sz000001` 42），价格侧亦有 248 次趋势突破候选。
- 但 `sepaVcpScore >= 6` 且满足「≥2 次收缩 + 逐次收缩 ≥30%」的严格形态条件在 12 股全历史上仅触发 **1** 次（`sh601318`），且当日与 PIT 财务通过日不重合，因此 `research-sepa-pit` / `m` / `stop8` / `ma50` 联合入场为 **0 笔成交**（204/204 工程状态 `ok`）。按研究纪律不篡改 VCP 阈值，保留真实漏斗记录供后续独立研究。

---

## 4. 威科夫三策略 12 股逐层漏斗（零阈值改动）

| 策略 | 标的数 | 父事件 (`parentEvents`) | 缩量回踩 (`pullbackShrinkage`) | 价格带候选 (`candidates`) | 次日放量突破确认 (`nextDayVolumeConfirm`) | 入场信号 (`entrySignals`) | 实测成交 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `wy-lps-daily` | 12 | 102 | 1 | 0 | 0 | 0 | 0 |
| `wy-reaccumulation-daily` | 12 | 31 | 0 | 0 | 0 | 0 | 0 |
| `wy-trend-pullback-daily` | 12 | 17,217 | 680 | 99 | **0** | 0 | 0 |

结论：在 12 只覆盖主板/创业板/科创板与周期/消费/医药/科技 Representative 池上，三策略仍保持零入场；其中 `wy-trend-pullback-daily` 产生 99 个 MA20 缩量回踩候选但 0 次通过次日放量突破确认（`≥1.5×` 20 日均量），`wy-lps-daily` 与 `wy-reaccumulation-daily` 在回踩缩量/价格带阶段即衰减至 0。该瓶颈已精确量化，未人为放宽原规则参数。
