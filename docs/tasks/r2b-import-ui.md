# 任务书 R2b：导入向导与复盘页面

你是执行者。R1–R5 的解析、存储、回合、净值、归因、服务层已全部验收，
**三份真实文件的端到端导入已跑通**。本任务做**最后一块：tRPC 路由与页面**。

先读 `AGENTS.md`、`docs/conventions.md`（**§4 UI 规范是硬性的**）、
`docs/invariants.md`，以及 `src/server/trade-review-service.ts`、
`src/server/delivery-import-service.ts`、`src/server/delivery-store.ts`。

## 0. 不可越界

- 不改解析层、存储层、复盘引擎、迁移、`src/server/mcp.ts` 的**对外行为**。
  只在 `api/root.ts` 追加过程、新建组件与页面。
- 不 commit / push / 打包；不新增依赖。
- 既有 1517 个用例必须继续通过。

## 1. 文件读取走「服务端按路径读」，不要做浏览器上传

交割单是 **GB18030 二进制**，`file.text()` 会按 UTF-8 解码得到乱码；
几百 KB 的文件转 base64 走 tRPC 也有请求体风险。

**沿用 `cls-review` 的既有范式**：页面给目录 → 服务端列出候选文件 → 用户点选 →
服务端读取字节并解析。参考 `clsReviewFiles` / `clsReviewPreview` / `clsReviewImport`
（`src/server/api/root.ts` 约 233–252 行）。

## 2. tRPC 过程（追加到 `api/root.ts`）

数据库入口沿用 `import { sqlite as chartSqlite } from "../db"`。

- `deliveryFiles(dir)` — 列出目录下候选文件（`.xls` / `.txt` / `.csv`），
  返回文件名、大小、修改时间。目录只读，不写入。
- `deliveryPreview({ path, account, source })` — 调 `previewDeliveryImport`，
  **绝不写库**。返回列映射、未映射列、诊断、逐行状态与汇总计数。
- `deliveryImport({ path, account, source })` — 调 `commitDeliveryImport`。
- `deliveryBatches()` / `deliveryRevoke(batchId)` — 批次列表与撤销。
- `tradeReviewSnapshot({ account })` — 调 `buildTradeReviewSnapshot`。
- `tradeReviewExport({ account })` — 调 `exportTradeReview`，返回可下载 JSON。

路径入参用 Zod 校验长度；账户别名 `min(1).max(64)`。

## 3. 页面 `/trade-review`

页面本身只做组合（参考 `src/app/cls-review/page.tsx` 的极简结构），
业务放 `src/components/trade-review-*.tsx`。

### 3.1 导入向导（写库前必须完整展示）

目录输入 → 文件列表 → 选账户别名与来源 → **预览** → 确认导入。
预览面板必须显示，缺一不可：

- **将写入 N 行 / 已存在 M 行 / 冲突 K 行 / 待核对 J 行 / 异常 I 笔**
- **列映射结果**：哪列映射到哪个字段、**未映射的列**、重复列
- **诊断信息**（解析器给的 warnings，如「手续费按佣金处理」「已识别账号列并脱敏」
  「按资金流水形态解析」「N 笔逆回购豁免核对」）
- 有冲突时**禁用导入按钮**并显示冲突明细（导入会整批回滚，先让用户看清）

**不做「先写了再说」**。用户没点确认就不能写库。

### 3.2 批次管理

批次列表（文件名、账户、来源、导入时间、成交/现金流笔数），
每行可**撤销**。撤销前要二次确认（用 `ui/dialog`），
并说明「撤销只影响该批次，其他批次不受影响」。

### 3.3 复盘展示

分区展示快照内容，**每个不可得的量都要显示原因，不能留空白**：

- **回合表**：用 `DataTable`（服务端已排序分页；**禁止**客户端全量加载重排）。
  列：标的、开仓日、平仓日、持有交易日、买均价、卖均价、数量、费用、净收益、收益率。
  **移动加权与 FIFO 两套结果要能切换**（`ui/tabs` 或分段控件），不要只显示一套。
- **买卖点**：日内位置、区间位置、MFE/MAE、卖后走势。缺日线的标的列在
  「因缺行情无法分析」清单里。
- **资金曲线与风险**：最大回撤、夏普、Sortino、Calmar、TWR、月度收益表、回撤区间明细。
  **夏普/回撤若因净值中断而不可得，必须显示中断原因与实际使用的交易日数。**
- **归因**：按标的/品种/持有期/RPS 分档/行业/概念/星期分组。
  样本不足的组要标注「样本不足，不稳定」；「未知」组单独显示。
  必须有一句话说明**分组是描述性的，不代表因果**。
- **必须显著呈现的口径**（真实数据已证明会误导）：
  - **未解释资金残差**（真实账户为 `17554.45`）——独立显示，**不得自动平账**；
  - `openingUnknown` 的回合（中签建仓等证据不足）收益留空的说明；
  - 被排除的**作废流水**笔数与金额；
  - 费用来源（按发生金额反推 / 按分项求和）。
- **导出**：下载 JSON（用 Blob，下载后回收 URL——参考既有导出实现）。

## 4. UI 规范（`conventions.md` §4，违反即不通过）

- **不写原生 `<input>` `<select>` `<button>` `<table>` `<textarea>`**，
  一律用 `src/components/ui/` 下的组件（已有 alert / badge / button / card /
  checkbox / collapsible / data-table / dialog / input / label / select /
  separator / switch / table / tabs / tooltip 等）。
- 颜色只用 token（`--primary` / `--muted` / `--border` / `--card`…），
  **不写死十六进制**。图标只用 `lucide-react`。
- 间距字号用 Tailwind 工具类，**不新增 `globals.css` 规则**。
- **组件内不做数据获取**：数据由容器组件取好后以 props 传入，便于测试直接渲染。
- 中文文案，与既有页面语气一致。

## 5. 测试

- 组件测试：渲染导入预览（有冲突 / 无冲突两种）、断言冲突时导入按钮禁用、
  断言未映射列与诊断可见、断言残差与 `openingUnknown` 说明可见。
  参考既有组件测试的写法（`tests/` 下已有多个）。
- 路由测试：用内存库贯通 `预览 → 导入 → 批次 → 撤销`，断言预览不写库。
- 不连生产库；不依赖用户真实文件；用 `tests/fixtures/delivery/` 的合成样本。

## 6. 自证（全部执行，贴真实输出）

```
npx vitest run
npx tsc --noEmit
npx prettier --check src electron scripts tests *.ts *.js *.json *.yml
npx next build
```

注意：`prettier --check` 在本仓库**本来就有 10 个既有文件不通过**
（含用户维护的 `mcp.ts`）。你只需保证**自己新增/修改的文件**通过，
并在报告里说明既有失败项与你无关、你没有去改它们。

## 7. 报告格式

改了哪些文件、关键设计选择及理由、上述命令真实结果、
你认为仍有问题但没动的地方、以及你没做到的部分。
