# tstdx

纯 TypeScript / Node.js 实现的通达信 7709 行情协议客户端。把通达信客户端使用的 TCP 二进制协议翻译成 Promise 接口，可在 Node 服务、脚本或 Electron 主进程里直接调用。

不依赖 Next.js、SQLite 或任何量化终端；运行依赖只有 `iconv-lite`（用于 F10 的 GBK 编解码）。另提供纯 Buffer 的通达信本地财务包解析，本包自身不读取磁盘路径。

要求 Node.js >= 22，ESM only。当前 `private: true` 防止误发布，尚未发布到 npm。

```ts
import { createTdxClient } from "tstdx";

const client = createTdxClient();
try {
  const [quote] = await client.securityQuotes(["sh600519"]);
  console.log(quote.price, quote.bids[0]);
} finally {
  await client.close();
}
```

## 文档

完整文档在 [`docs/`](./docs/index.md)：

| 文档                                 | 内容                                             |
| ------------------------------------ | ------------------------------------------------ |
| [项目概述](./docs/index.md)          | 特点、运行环境、安装、文档导航                   |
| [快速上手](./docs/quick.md)          | 各类数据的最短可运行示例                         |
| [安装与开发](./docs/setup.md)        | 构建、测试、实网验收、包结构                     |
| [客户端与连接](./docs/api/client.md) | `createTdxClient` 选项、生命周期、节点测速与探测 |
| [标准行情接口](./docs/api/quotes.md) | 五档、K 线、分时、逐笔、除权除息、财务快照       |
| [扩展接口](./docs/api/extras.md)     | 证券列表、F10、板块、区间与复权、批量、资金流    |
| [本地财务包](./docs/api/affair.md)   | `gpcw*.dat` / `gpcw.txt` 解析与字段核验方法      |
| [字段与单位](./docs/api/fields.md)   | 每个字段的单位与**已核验程度**                   |
| [底层编解码](./docs/api/wire.md)     | `tstdx/wire` 的请求构造与响应解析                |
| [实网边界](./docs/limits.md)         | 哪些接口在公网节点上实测可用                     |
| [常见问题](./docs/faq.md)            | 连不上、返回空、单位对不上时怎么排查             |

## 设计原则

- **口径显式**：价格精度、金额单位、复权锚点、涨跌停规则都写明依据。没核验过的字段一律标注，不悄悄换算。
- **失败可见**：坏包、截断、分页重复、数量不符一律抛错，不返回空数组冒充"没有数据"。
- **边界清楚**："实现了接口"和"公网当前可用"分开记录，见[实网边界](./docs/limits.md)。

## 先读这两条

1. **财务金额单位是元**（协议原值为千元，包内已 ×1000）。早期版本按万元换算会**放大 10 倍**，升级后要重算缓存。
2. **`pingAll` 只能证明握手可用**，证明不了行情正文可用。需要数据时用 `probeHosts` 或 `fromBestHost({ requireMarketData: true })`。

## 开发

```powershell
pnpm install
pnpm build      # 产出 dist/*.js 与 dist/*.d.ts，不提交
pnpm test       # 离线测试，不访问公网
pnpm typecheck
```

本仓库通过 pnpm workspace 的 `tstdx: workspace:*` 引入；节点来源与环境变量优先级保留在宿主应用的 `src/server/data-sources/tdx/tdx-quotes.ts`，通过 `hosts` 函数传入。
