# tstdx

## 项目概述

tstdx 是一个纯 TypeScript / Node.js 实现的通达信 7709 行情协议客户端。它把通达信客户端使用的 TCP 二进制协议翻译成 Promise 风格的接口，可以在任何 Node 服务、脚本或 Electron 主进程里直接调用。

本包与任何量化终端解耦：不依赖 Next.js、SQLite、数据库或某个具体应用的配置。节点列表、持久化与调度全部由调用方提供。

- 仓库位置：`packages/tstdx`
- 文档目录：[docs/](./index.md)
- 参考实现：[pytdx](https://github.com/rainx/pytdx)、[mootdx](https://github.com/mootdx/mootdx)、[xmtdx](https://pypi.org/project/xmtdx/)、[rustdx-complete](https://crates.io/crates/rustdx-complete)

## 项目特点

- **协议原生**：直接实现 7709 二进制帧的编解码，不包装第三方 Python/Rust 实现，不启动子进程。
- **口径显式**：价格精度、金额单位、股本单位、复权锚点、涨跌停规则都在文档里写明依据；没有核验过的字段一律标注，不悄悄换算。
- **失败可见**：坏包、截断、分页重复、数量不符一律抛错，不返回空数组冒充"没有数据"。
- **连接自治**：每个客户端自带连接池，按节点顺序建连，坏连接自动废弃并切换下一节点。
- **纯函数可分离**：复权、涨跌停、资金流分类、市场统计以及本地财务包解析都是纯函数，不需要 TCP 即可单独使用与测试。
- **类型完整**：所有结果类型从包入口导出，`dist/*.d.ts` 随包发布。

## 运行环境

| 项目     | 要求                                                       |
| -------- | ---------------------------------------------------------- |
| Node.js  | >= 22（`package.json` 的 `engines` 已锁定）                |
| 模块格式 | ESM（`"type": "module"`），不提供 CommonJS 产物            |
| 操作系统 | Windows / macOS / Linux，只要能建立到 7709 端口的 TCP 连接 |
| 运行依赖 | `iconv-lite`，仅用于 F10 中文文件名与正文的 GBK 编解码     |

## 快速安装

当前包标记为 `private: true`，尚未发布到 npm。可用的安装方式：

```powershell
# 1) 同一个 pnpm workspace 内
#    package.json 里写 "tstdx": "workspace:*"
pnpm install

# 2) 打成 tarball 给外部项目安装
pnpm --dir packages/tstdx pack --pack-destination <临时目录>
pnpm add file:<临时目录>/tstdx-0.1.0.tgz
```

发布到注册表需要另行授权，届时去掉 `private` 并确认 `files` 字段。

## 文档导航

| 文档                            | 内容                                                  |
| ------------------------------- | ----------------------------------------------------- |
| [快速上手](./quick.md)          | 五分钟跑通行情、K 线、财务包读取                      |
| [安装与开发](./setup.md)        | 独立开发、构建、测试、实网验收                        |
| [客户端与连接](./api/client.md) | `createTdxClient` 选项、连接生命周期、节点测速与探测  |
| [标准行情接口](./api/quotes.md) | 五档、K 线、分时、逐笔、除权除息、财务快照            |
| [扩展接口](./api/extras.md)     | 证券列表、F10、板块、区间与复权、批量、资金流、涨跌停 |
| [本地财务包](./api/affair.md)   | `gpcw*.dat` / `gpcw.txt` 的纯 Buffer 解析             |
| [字段与单位](./api/fields.md)   | 各结果类型的字段含义、单位与已核验程度                |
| [底层编解码](./api/wire.md)     | `tstdx/wire` 的请求构造与响应解析函数                 |
| [实网边界](./limits.md)         | 哪些接口在公网节点上实测可用、哪些不可用              |
| [常见问题](./faq.md)            | 连不上、返回空、单位对不上时怎么排查                  |

## 一句话上手

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
