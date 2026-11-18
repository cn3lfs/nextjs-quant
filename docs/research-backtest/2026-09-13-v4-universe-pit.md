# 任务书 V4：证券池时点审计

V 系列第 4 批。只读、零外部请求。

## 1. 问题

`roadmap §2` 要求 A500 使用当前名单时"提示生存者偏差"。现在这是一句文案。
文案挡不住误读：读者看到「500 只成分、区间 2021–2026」，默认这 500 只在 2021 年就都在池子里，
而事实上其中一部分当时还没上市、名单本身也是今天的名单。

更要命的是**看不见的那一半**：区间内退市的股票根本不在通达信目录里，
也就不在任何一次筛选、RPS 或样本研究的分母里。这部分样本缺失不会报错、不会留空，
它只是**不存在**——而它恰好是表现最差的一批。

本批把能数清楚的数清楚，并把数不清楚的明确标成数不清楚。

## 2. 交付

### 2.1 `src/lib/universe-audit.ts`（新建，纯函数）

输入：证券池（symbol 列表 + 名单来源与快照时间）、研究区间 `[start, end]`、
每只标的的证据（见 §2.2）。输出：

| 字段 | 含义 |
| --- | --- |
| `total` | 池内标的数 |
| `notListedAtStart` | 有上市日证据且 **上市日 > start** 的只数（区间起点时不该在池里） |
| `listedDuring` | 上市日落在区间内的只数 |
| `delistedDuring` | 有退市日证据且退市日 ≤ end 的只数 |
| `codeChanged` | 区间内发生过代码变更的只数（来自 `readTdxCodeChanges`） |
| `noEvidence` | 没有上市/退市日证据的只数 |
| `localCoverageStartsAfter` | 本地行情首个交易日晚于 `start` 的只数 |
| `rosterAsOf` | 名单快照时间；无快照时间则 null + reason |

每一项同时给出**明细列表**（symbol + 依据日期 + 证据来源），服务端分页。

### 2.2 证据来源与硬约束

- 上市/退市日：**只读 `storedSecurityLifecycle(symbol)` 的既有缓存**。
  **严禁**在审计里调用 `verifySecurityLifecycle` 或任何远程接口——
  500 只标的会变成 500 次外部请求，且 `roadmap` 的数据源边界不允许审计动作触发外呼。
  未缓存的一律计入 `noEvidence`，不猜
- 代码变更：`readTdxCodeChanges(root)`，只读本地文件
- 本地行情覆盖：既有证券主档/覆盖信息，**不新建扫描**
- 名单快照时间：A500 名单文件的记录时间；取不到就 null + reason，不用文件 mtime 冒充

### 2.3 不可知项必须显式（本批最重要的一条）

输出必须包含 `unknowable` 段，内容固定为结构化事实而非自由文案：

```ts
unknowable: {
  /** 区间内退市且已从本地目录消失的标的：本地数据无法枚举 */
  vanishedFromSource: "本地通达信目录只含当前存在的证券，区间内退市后被移除的标的无法枚举";
  /** 因此下面这个数是下界 */
  delistedDuringIsLowerBound: true;
  /** 名单本身是今天的名单，不是区间各时点的历史成分 */
  rosterIsCurrentSnapshot: boolean;
}
```

页面必须把 `delistedDuring` 显示为「**≥ N 只**」而不是「N 只」。
这不是措辞洁癖：写成精确值就等于宣称已经枚举完整，而我们没有。

### 2.4 接入

股票池浏览与 A500 研究的结果区各加一个「时点审计」入口，展示 §2.1 的汇总与明细。
研究结果页（E3 样本研究、RPS 概念排名）在有区间概念的地方引用同一汇总，
**不各写一份**。

`notListedAtStart > 0` 或 `rosterIsCurrentSnapshot` 为真时，
研究结果区顶部显示一行固定提示：「本次结果的证券池含生存者偏差，
幅度未知且不可由本地数据估计」。**不要给"影响约 x%"这类估计数**——
估不出来。

## 3. 测试（`tests/universe-audit.test.ts` 新建）

- **逐项手算**：8 只标的的合成证据，覆盖全部七个计数字段，注释写明每只归入哪一类
- **边界日期**：上市日 **等于** `start` 算已上市（不计入 `notListedAtStart`）；
  退市日等于 `end` 计入 `delistedDuring`。两条各一测
- **无证据不猜**：缓存缺失的标的进 `noEvidence`，**断言它没有被本地行情覆盖日期顶替**
- **零外呼**：断言审计函数与其服务端入口不引用 `verifySecurityLifecycle` /
  `request`（用模块依赖断言或注入替身，二选一，写清理由）
- **下界标记**：`delistedDuringIsLowerBound` 恒为 `true`，有一条测试固定它
- **代码变更**：区间内变更计入、区间外不计入
- **空池**：total = 0 时全部计数为 0，不抛错，`rosterAsOf` 仍如实输出

## 4. 验收

- 审计过程零外部请求，有测试保证
- `delistedDuring` 在页面显示为「≥ N」
- 不给偏差幅度估计
- 不新增依赖、不新增迁移、不新建扫描路径
- `invariants.md` 补一条：审计只读缓存、退市数为下界、名单快照时间不得用 mtime 替代
- `pnpm typecheck` / `pnpm test` / 改动文件 prettier 通过
