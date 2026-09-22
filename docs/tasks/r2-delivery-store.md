# 任务书 R2：交割单导入的存储与服务层

你是执行者。管理者已完成 R1（解析层）并验收通过。本任务**只做存储与服务层，不做 UI**。

先读 `AGENTS.md`、`docs/conventions.md`、`docs/invariants.md`、
`docs/archive/2026-09-22/trade-review/trade-review-plan.md`（§2 决策、§3 数据模型、§4 已交付的解析层）。

## 0. 不可越界

- **不得修改** `src/lib/delivery-table.ts`、`src/lib/delivery-import.ts`、
  `tests/delivery-import.test.ts`、`tests/fixtures/delivery/*`。
  这些是 R1 已验收产物。若你认为其中有 bug，**在最终报告里写出来，不要自行修改**。
- **不得修改** `src/server/mcp.ts` 及其 UI 文案（归用户所有）。
- **不得修改已有的迁移数组元素**（`src/server/db/migrations.ts` 中现有 9 条），
  只能在数组末尾追加第 10 条。降低 `user_version` 或改写历史迁移会毁掉现有数据库。
- **不得连接生产库**。所有验证用 `new Database(":memory:")` + `migrate(db)`，
  范式见 `tests/rps-store.test.ts` 与 `tests/intraday-store.test.ts`。
  不得设置或依赖默认 `QUANT_DATA_DIR`。
- **不得 git commit / push / 打包**。改动留在工作区。
- 不新增 npm 依赖。

## 1. 交付物

### 1.1 迁移（追加为第 10 条）

三张表，语义见 `docs/archive/2026-09-22/trade-review/trade-review-plan.md` §3，但按以下修订落地：

```sql
CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  source TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  file_name TEXT NOT NULL,
  imported_at INTEGER NOT NULL,
  payload TEXT NOT NULL);
CREATE UNIQUE INDEX import_batches_file ON import_batches(account,file_hash);

CREATE TABLE trade_fills (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  symbol TEXT,                 -- 可空：可转债/ETF/逆回购等无 sh|sz|bj 归属的品种
  code TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES import_batches(id),
  payload TEXT NOT NULL);
CREATE INDEX trade_fills_account_date ON trade_fills(account,trade_date,code);
CREATE INDEX trade_fills_batch ON trade_fills(batch_id);

CREATE TABLE cash_flows (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  flow_date TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES import_batches(id),
  payload TEXT NOT NULL);
CREATE INDEX cash_flows_account_date ON cash_flows(account,flow_date);
CREATE INDEX cash_flows_batch ON cash_flows(batch_id);
```

`symbol` 必须可空——这是 R1 已确立的语义（非沪深北品种计入资金、不进个股分析）。
不要为了"整齐"给它 NOT NULL 或填空串。

### 1.2 `src/server/portfolio/delivery-store.ts`

导出 `class DeliveryStore { constructor(readonly db: Database.Database) }`，
构造只接收连接，不自己打开数据库（与 `TradeLedgerStore`、`RpsStore` 一致）。

方法：

- `commitImport(input): ImportResult` —— **单个 immediate 事务**完成全部写入。
  `input` 至少包含：`account`、`source`、`fileHash`、`fileName`、`importedAt`、
  R1 的 `DeliveryImport` 结果、以及已脱敏的原始行（用 `redactRow`）。
- `batches()`、`fills(account?)`、`cashFlows(account?)` —— 读取，按日期稳定排序。
- `revokeBatch(batchId)` —— 删除该批次的 fills、cash flows 与批次行，返回删除计数。

**幂等与冲突（这是本任务的核心，不要简化）**：

1. 行 id = `sha256(account + "|" + fingerprintSource)`，`fingerprintSource` 由 R1 给出。
2. 已存在同 id 且 payload **相同** → 计入 `duplicate`，不写入、不报错。
3. 已存在同 id 但 payload **不同** → **整批事务回滚并抛错**，错误信息里带上前若干条
   冲突的 id 与差异摘要。语义对齐 `TradeLedgerStore.record` 的
   「交易编号已用于不同内容」。**不得静默覆盖，也不得只跳过冲突行继续写。**
4. 同 `account` + `fileHash` 的批次已存在 → **不新建批次**，直接返回既有 `batchId`
   并置 `alreadyImported: true`。（否则撤销语义会变得不可预期。）
5. `import_batches.payload` 保存：列映射、诊断、脱敏后的原始行、
   `unresolved` 明细、解析统计。**账号列必须已被 `redactRow` 替换为 `***`**，
   真实账号不得进入任何一张表。

### 1.3 `src/server/portfolio/delivery-import-service.ts`

- `previewDeliveryImport(bytes: Uint8Array, options)` → 解析 + 逐行定状态
  （`new` / `duplicate` / `conflict`），**绝不写库**。返回给 UI 的摘要必须包含：
  将写入笔数、已存在笔数、冲突笔数、待核对行数（`unresolved`）、
  异常笔数（`anomalies` 非空）、列映射与未映射列、诊断。
- `commitDeliveryImport(bytes, options)` → 调用 store 落库。
- `options` 用 R1 已导出的 `importOptionsSchema` 校验（Zod）。
- 文件 hash 用 `node:crypto` 的 sha256。
- 本文件可以用 `sqlite()`，但**必须允许注入连接以便测试**
  （例如可选参数或导出一个接收 `Database` 的内部函数）。

### 1.4 `tests/delivery-store.test.ts`

必须覆盖且断言具体数值，不要只断言"没抛错"：

1. 首次导入三个 fixture，各自写入的 fills / cashFlows 条数正确。
2. **重复导入同一文件**：新增 0 条，`duplicate` 计数正确，`alreadyImported` 为真，
   批次表仍只有 1 行。
3. **同指纹异内容**：构造一条 id 相同但价格不同的记录 → 抛错，且**库内无任何新增**
   （逐表 count 断言回滚彻底）。
4. `revokeBatch`：该批 fills / cashFlows / 批次行全部清零，**另一批次完全不受影响**。
5. **脱敏**：含账号列的文件导入后，遍历三张表的全部 payload，
   断言真实账号字符串不出现在任何一处。
6. **迁移**：`migrate` 连续执行两次不报错；在只应用了前 9 条迁移的库上追加第 10 条后，
   既有表的数据仍在（证明新迁移不破坏旧库）。

## 2. 自证（必须全部执行并把真实输出贴进报告）

```
npx vitest run tests/delivery-store.test.ts tests/delivery-import.test.ts
npx vitest run                      # 全量，基线：248 文件通过 / 5 跳过，1396 用例通过 / 6 跳过
npx tsc --noEmit
npx prettier --check src/server/delivery-*.ts tests/delivery-store.test.ts src/server/db/migrations.ts
```

失败就修到通过。**不许把没跑过的命令写成跑过了**，也不许把失败说成通过——
管理者会复跑全部命令核对。

## 3. 报告格式

最后输出：改了哪些文件、关键设计选择及理由、上述四条命令的真实结果、
你认为有问题但没动的地方（尤其是 R1 解析层）、以及你**没做到**的部分。
