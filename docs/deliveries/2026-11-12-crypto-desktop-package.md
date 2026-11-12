# 数字货币交易模块提交与桌面打包

用户授权“提交并打包”，本次完成本地提交和 Windows x64 目录包交付，没有推送。数字货币功能见[账户成交交付](2026-11-12-crypto-account-history.md)与[自动交易交付](2026-11-11-crypto-auto-trading.md)。

## 提交与构建范围

- `fd5903e`：三平台模拟自动交易、BTCUSDT/ETHUSDT、当前账户持仓和历史成交同步，共39个文件。共享文档仅暂存本任务段落；RPS、回测及其他未提交修改未纳入。
- `2ea7f73`、`00bcdfe`、`c7cfafd`、`e423258`、`2de2142`：修复独立桌面包的模块链接、服务依赖复制、pnpm实体依赖布局、前置校验和Koffi动态二进制。
- `c2efc64`：更新安装及独立验收操作说明。

应用构建来自干净的 detached worktree，锁文件冻结、离线安装，没有加载主工作区 `.env`。`c7cfafd` 完成 build/runtime、Next类型检查和 desktop:pack；后续仅修改准备/打包脚本、测试及文档。工作树快进至 `2de2142` 后，复用未改变的应用构建，重新执行 desktop:prepare 和 electron-builder x64 dir，形成最终包。

## 打包缺陷与修复

原有源码树内启动会从父目录依赖回退，掩盖包缺陷。将整个包移出仓库并令原构建路径不可用后，依次发现绝对原生模块链接、服务根依赖未携带、pnpm隔离依赖关系丢失、Koffi原生动态加载只追踪到包清单等问题。失败包均未交付。

采用 [Electron官方建议](https://www.electronjs.org/docs/latest/tutorial/tutorial-first-app) 的 hoisted 布局；依赖版本及锁文件不变。prepare实体化链接并把现有runtime的完整Windows Koffi原生包复制至服务与Turbopack别名的依赖目录。electron-builder显式携带服务根node_modules；打包前检查安装布局，打包后检查入口依赖及残留链接。旧布局前置拦截检查通过，旧EXE哈希未变。

## 验收结果

- 原功能验收基线为主工程12138项、包级194项；本轮干净提交的类型检查和71项相关用例通过。最终准备脚本修改后18项桌面守卫回归通过，不重复全仓测试。
- 独立包验收目录为 `D:/github/qcrypto-final-check/release/win-unpacked`，原构建路径 `D:/github/qcrypto-pack` 已不存在；父目录无node_modules，NODE_PATH清空。最终包2438文件、562709023字节，残留链接0。
- 实际打包EXE启动通过：页面所需标签齐全，无启动超时、服务退出、Forbidden或Cannot find module。通达信茅台日线6040条、末日2026-11-11，读取前后源文件字节一致。
- bundled Node/server使用全新临时数据库、工作目录、worker路径和临时会话认证验证：空账户持仓/成交查询、保存SMA模拟策略、无交易所凭证同步拦截、停止状态、订单数0，全部通过。初次RPC探针漏带客户端标记被403拒绝，补齐现有认证契约后通过，未修改权限边界。
- 验收进程及临时用户目录正常清理；未打开默认生产库、未读取交易所凭证、未发送交易所委托，真实模拟账户联调仍未执行。

日志位于主工作区 `.test-data/crypto-package-*.log`、`.test-data/crypto-pack-native-final.log`；最终元数据为 `.test-data/crypto-package-final-metadata.json`，RPC探针为 `.test-data/crypto-package-rpc-smoke.mjs`。

## 交付

最终唯一发布目录 `release/win-unpacked` 已替换，替换前再次确认该目录没有运行中的GuanlanQuant。运行 `release/win-unpacked/GuanlanQuant.exe`，移动或分发时保留整个目录。

| 校验项 | 值 |
| --- | --- |
| Next Build ID | `IQwayE6XsrPv9aFO-2pV0` |
| EXE SHA256 | `6C406895715792FD5DE12CD34BDB6BA739E9D81DCD299103760656CE4D76A2FD` |
| app.asar SHA256 | `5CF04F515145AD20EB8CDEAFC1500E5EB71545477ADD38998B36366EC4B49D04` |

旧包作为任务备份保存在 `.test-data/crypto-previous-release`，不在release内。首次构建目录删除遇到长路径失败，进一步删除被自动策略拒绝（仅返回blocked by policy）；保留改名后的 `D:/github/nextjs-quant-crypto-package-residual`，没有绕过删除限制。其余诊断目录为同级 `nextjs-quant-crypto-portable-check`、`qcrypto-portable-check`、`qcrypto-delivery-check`，最终源码工作树为 `qcrypto-final-source`；这些是隔离构建/失败证据，均不作为交付入口。

主工作区原有node_modules仍为isolated布局；今后再次本地打包前执行 `pnpm install --frozen-lockfile`，按[操作说明](../operations.md)使用hoisted布局。此次交付不需要在用户机器安装Node或项目依赖。
