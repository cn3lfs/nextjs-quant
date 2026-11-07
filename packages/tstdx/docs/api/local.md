# 本地客户端数据

通达信专用格式、源字段和 IO 在本包维护。宿主提供安装路径、用户操作授权和 DLL 部署；应用自己的数据库、缓存发布、研究档案、证券池选择和财务计算不进入本包。没有应用路径别名或仓库外层依赖。

| 入口                    | 职责                                                           |
| ----------------------- | -------------------------------------------------------------- |
| `tstdx` / `tstdx/wire`  | TCP 客户端与协议编解码；原入口保持兼容                         |
| `tstdx/local`           | Node 本地文件解析、只读 IO、目录检查、来源哈希和缓存           |
| `tstdx/financial-model` | 纯 FN/GP/BK/SC/GO 字典、单位、日期和源值投影；不导入 Node 模块 |
| `tstdx/native`          | 可选 Koffi/Windows DLL 桥接，CSV/WDZ→LC5、核对、合并和显式修复 |
| `tstdx/local-import`    | 无FFI的CSV预览、显式导入、备份恢复和撤销；不管理应用批次数据库 |

## 格式覆盖

| 格式/函数                                                                                   | 返回与边界                                                                                      |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `parseBars`、`readSnapshot`、`readTailSnapshot`、`readHistoricalSnapshot`、`scan`           | DAY/LC5，32字节记录；价格精度显式、年份回绕、OHLC修正与剔除说明；尾窗有条目/字节上限            |
| `parseNames`、`securityNames`                                                               | TNF 50字节头、360字节记录、GB18030；只允许sh/sz/bj，坏记录布局保留旧兼容空结果                  |
| `parseInfoharborNames`、`readInfoharborNames`                                               | 补充名称；无交易所的代码只按已知A股代码族定位                                                   |
| `parseTdxLocalBlocks`、`readTdxLocalBlocks`、`readTdxBlockDefinitionNames`                  | 行业/概念/指数与地域/风格定义；读取前后签名核对，分类和成员不混用                               |
| `parseTdxCodeChanges`、`readTdxCodeChanges`                                                 | 北交所代码切换证据；不拼接新旧证券历史                                                          |
| `parseGbbqFile`、`parseGbbq`、`readGbbq`                                                    | 29字节股本事件、解密、每股分红/股数换算；详细入口含被拒记录原因。旧入口继续返回事件Map          |
| `adjustmentFactors`、`applyAdjustment`、`deriveHistoricalFloatShares`、`deriveVolumeRatios` | 日期限定的复权和量能可比性。缺少股本证据不造比例，不把现有股本回填历史                          |
| `parseFinancialReport`、`financialPackage`、`packageRecord`                                 | 财报DAT/ZIP与索引；20字节占位单列，658槽位不等于658个已验证科目；DAT/ZIP共享内容哈希            |
| `parseFinancialSeries`、`parseStockFileList`、`parseLocalFinancialMd5`                      | GP/BK/SC每条13字节，组号/日期/两个float32/偏移；清单MD5与长度；日期0留存并诊断                  |
| `parseLocalBaseDbf`、`parseLocalBaseMap`                                                    | 基础资料的自描述列/数值与文本映射编号；保留原字串、删除标记、记录偏移。旧列名不认证GO含义或单位 |
| `parseTdxDailyIncrement`、`downloadDailyIncrement`、`extractDailyIncrement`                 | COD/MD1、固定白名单ZIP；下载为显式调用，404表示尚未发布，不是空成功                             |
| `inspectFullDayPackage`                                                                     | 只提取调用者指定的证券，验证路径、重复成员、数量/容量和记录；临时目录自行清理                   |
| `readLocalTradingDates`                                                                     | 指数实际观测日期；不是完整官方交易日历，不联网补造未来日期                                      |
| `parseFiveMinuteCsv`、`encodeFiveMinuteBar`、`mergeFiveMinuteBars`                          | 纯CSV/LC5转换；不执行源目录写入                                                                 |

`financialCatalog` 冻结 FN478、GP52、BK15、SC42、GO48 项官方定义。诊断FN5651–5658的本地槽位尚未核验，GO的本地业务映射也未证实；未确认字段保留原值及状态，不能当作已认证指标使用。当前下载财报可能包含后续修订。

财报索引只有六位代码，不含完整市场身份。宿主必须先确认A股公司类型与交易所；例如SH000001是指数，不能因代码相同借用SZ000001公司的财报。股票/板块/市场序列则使用完整文件名身份。

## 示例

```ts
import { readSnapshot, financialPackage, packageRecord } from "tstdx/local";
import { projectFinancialFields } from "tstdx/financial-model";
const root = "E:/new_tdx64";
const price = await readSnapshot(root, "sh600519", "day");
const file = await financialPackage(root, "gpcw20260930.dat");
const row = packageRecord(file, "600519");
const fields = row
  ? projectFinancialFields(row.values, false, undefined, 2026)
  : [];
// 行业身份由宿主提供证据；不能仅凭示例中的 false 判断真实公司类型。
```

普通本地读取只读。文件版本校验包含身份、容量和纳秒时间；单文件上限64MiB，原始缓存48MiB；投影/研究缓存由宿主管理。交易日期参考强制重读。不要修改读取结果中的原始Buffer。

## 可选原生入口

```ts
import {
  configureTdxNativeDirectory,
  importFiveMinuteDirect,
} from "tstdx/native";
configureTdxNativeDirectory("C:/my-app/runtime/tdx-import");
// 只有宿主获得明确导入授权后，才调用下面的写接口。
await importFiveMinuteDirect(
  "C:/input/600519.csv",
  "E:/new_tdx64/vipdoc/sh/fzline/sh600519.lc5",
);
```

`koffi` 是可选peer。原生入口与普通读取入口分离，不向TCP/纯模型消费者加载FFI。源码及独立构建位于 `native/`，Windows上执行 `pnpm build:native` 产出 `native/bin/`；宿主也可通过 `native/build.ps1 -OutputDirectory <目录>` 指定输出。编译需要clang/lld，当前测试不会安装工具或写通达信目录。

来源方法与未确认项见[静态核对记录](../research/client-static-analysis.md)。固定裁剪文件与来源指纹位于 `tests/fixtures/local/manifest.json`；包复制到其他工程后，离线测试仍使用包内fixture。
