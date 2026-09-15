# 本地财务包

通达信客户端下载到本地的**专业财务数据**包，位于安装目录的 `vipdoc/cw/`（部分版本为 `tdxfin/`）。与协议 `finance` 快照相比，它的关键优势是**包头写明报告期**，而且字段数量多得多。

本包只提供**纯 Buffer 解析**：不下载、不落盘、不读取路径、不接入任何研究档案。文件从哪来、怎么更新由调用方决定。

```ts
import { parseFinancialReport, parseFinancialFileList } from "tstdx";
```

## 01. 解析财务报告包

**参数说明：**

- `bytes`：`Uint8Array`，`gpcw*.dat` 原始字节，或**只含一个 DAT** 的 `gpcw*.zip`
- `filename`：可选，仅用于回显来源与校验扩展名（必须是 `.dat` 或 `.zip`）

**返回值：** `TdxFinancialReport`

```ts
type TdxFinancialReport = {
  sourceFilename?: string;
  sourceSha256: string;
  formatVersion: number;
  reportDate: number; // YYYYMMDD，来自包头
  recordCount: number;
  fieldCount: number;
  records: TdxFinancialRecord[];
};

type TdxFinancialRecord = {
  code: string; // 六位数字，不含市场前缀
  marker: number;
  dataOffset: number;
  values: number[]; // fieldCount 个 float32
};
```

**调用方法：**

```ts
import { readFileSync } from "node:fs";
import { parseFinancialReport } from "tstdx";

const report = parseFinancialReport(
  readFileSync("E:/new_tdx64/vipdoc/cw/gpcw20260630.dat"),
  "gpcw20260630.dat",
);

console.log(report.reportDate); // 20260630
console.log(report.recordCount); // 5562
console.log(report.fieldCount); // 584

const record = report.records.find((r) => r.code === "600519");
console.log(record?.values.length); // 584
```

ZIP 输入会自动解压（只支持内含单个 DAT）。`sourceSha256` 是**输入字节**的哈希，可用于追溯是哪一份文件产出了某个结论。

## 02. 解析远程文件清单

**参数说明：**

- `bytes`：`gpcw.txt` 的原始字节，必须是合法 UTF-8

**返回值：** `TdxFinancialFile[]`

```ts
type TdxFinancialFile = { filename: string; md5: string; filesize: number };
```

**调用方法：**

```ts
import { parseFinancialFileList } from "tstdx";

const list = parseFinancialFileList(readFileSync("gpcw.txt"));
```

每行必须是 `文件名,MD5,字节数` 三段。文件名要匹配 `gpcw<YYYYMMDD>.zip` 且日期合法，MD5 必须是 32 位十六进制，重复文件名会**抛错**。

## 字段下标由调用方核验

**本包不提供 584 个槽位的字段名映射。** 通达信的专业财务字段表随报告版本变化，而且部分槽位在历史上被复用过。解析器只保证：

- 包头、索引表、数据区的边界与长度自洽
- 每个 float 是有限数（非有限值抛错）
- 证券代码是六位数字

字段的含义、单位、口径**必须由调用方按对应报告版本自行核验**，不能直接当成已核验的财务事实。

### 一个可复现的核验方法

把协议 `finance` 快照的字段值拿到财务包里反查等值槽位，就能建立映射并同时验证单位。本仓库 2026-09-15 用 30 只标的做过一次（沪深主板、创业板、银行、地产、白酒、新能源），得到的结论：

| 槽位 | 含义                   | 命中率 |
| ---- | ---------------------- | ------ |
| 39   | 总资产                 | 30/30  |
| 20   | 流动资产               | 30/30  |
| 26   | 固定资产               | 30/30  |
| 32   | 无形资产               | 30/30  |
| 53   | 流动负债               | 30/30  |
| 68   | 长期负债               | 30/30  |
| 270  | 净资产（股东权益合计） | 30/30  |
| 73   | 主营收入               | 30/30  |
| 74   | 主营利润               | 30/30  |
| 85   | 营业利润               | 30/30  |
| 91   | 利润总额               | 30/30  |
| 94   | 税后利润               | 30/30  |
| 95   | 净利润                 | 30/30  |
| 67   | 未分配利润             | 30/30  |
| 106  | 经营现金流             | 30/30  |
| 16   | 存货                   | 23/24  |
| 10   | 应收账款               | 23/24  |
| 64   | 资本公积               | 29/30  |
| 82   | 投资收益               | 28/30  |
| 241  | 股东户数               | 26/30  |
| 237  | 总股本（报告期末）     | 24/30  |
| 3    | 每股净资产（归母）     | 12/12  |

这些数字**是本仓库在一个特定日期、一份特定报告版本上的观测**，不是协议规范。换报告期或换版本需要重新核验。金额单位是**元**。

几个容易踩的坑：

- 槽位 3 是**归母**每股净资产，而槽位 270 是**股东权益合计**（含少数股东权益与永续债）。用 `270 / 237` 自算每股净资产会让银行与券商偏高、市净率偏低，与市场口径不一致。
- 槽位 237 是**报告期末**总股本。报告期之后有增发或回购时它不等于最新股本，算市值要另取最新值。
- 协议 `finance` 的 `totalCashFlow` 在 584 个槽位里找不到等值项。

## 未来期占位包

通达信目录里常有尚未发布的报告期占位文件（例如当年的 `gpcw20261231.dat`）。这些文件的字段数异常，解析会抛 `财务字段数量超限`。**这是预期行为**，调用方应当捕获并跳过，而不是让整批读取失败：

```ts
for (const file of files) {
  let report;
  try {
    report = parseFinancialReport(readFileSync(file));
  } catch (error) {
    console.warn("跳过", file, String(error));
    continue;
  }
  // ...
}
```

## 与协议 finance 的分工

| 需求                   | 用哪个                                 |
| ---------------------- | -------------------------------------- |
| 明确的报告期           | 本地财务包（包头）                     |
| 完整报表明细           | 本地财务包（584 槽位 vs 协议 30 字段） |
| 多期历史、同比环比     | 本地财务包（目录里通常有十几期）       |
| **最新**股本（算市值） | 协议 `finance`（本地只有报告期末口径） |
| 上市日期               | 协议 `finance` 的 `ipoDate`            |
| 不依赖网络、加载要快   | 本地财务包                             |

两者配合使用时，注意每股类指标要用**报告期末**股本（报告期的利润要配报告期的股本），市值类指标才用最新股本。
