# 运行与维护手册

先读 [AGENTS.md](../AGENTS.md) 与 [约束](invariants.md)。以下命令在仓库根 PowerShell 执行，适用于已由管理者预置依赖的 Windows x64 / Node 22 / pnpm 9 环境。执行者不得 pnpm add/install；缺依赖报告管理者，不换库或手写替代。

## 数据隔离先于启动

任何会打开数据库的开发、生产模式验证、浏览器核对、集成脚本均先设独立目录，不把默认生产目录用于验证：

```powershell
$env:QUANT_DATA_DIR = Join-Path $PWD '.test-data\manual-dev'
pnpm dev
```

打开 `http://127.0.0.1:3000`，在“数据与连接”配置通达信根目录并扫描。本机默认配置为 `E:\new_tdx64`，新机器应填自己的路径。不要让程序修改行情源文件；源行情由通达信更新。退出开发用 Ctrl+C，桌面 × 或托盘退出会停止服务和监控。隔离目录可能已有上次验证数据，需全新状态时换一个明确的新名字。

## 验证分层

| 层级 | 执行者 | 管理者/用户 |
|---|---|---|
| 改动级 | `pnpm exec vitest run --changed` + `pnpm typecheck` | 不跑桌面或 Playwright |
| 子任务级 | `pnpm test` | 仅针对新增失败补查，不循环全套 |
| 里程碑级 | `pnpm typecheck` → `pnpm test` → `pnpm build` → `pnpm desktop:prepare` | 管理者跑桌面冒烟、隔离 Playwright、打包；用户做 B 层人工核对 |

本次纯文档任务只需 typecheck/test；不能因手册列了命令就额外运行桌面层。`pnpm test` 是 vitest run，默认 166 文件/1046 测试为当前交接基线；不通过时记录实际结果，不靠删测试对齐数字。

[vitest.config.ts](../vitest.config.ts) 已挂 [tests/setup-data-dir.ts](../tests/setup-data-dir.ts)，未设变量时每测试文件创建 `quant-test-*` 临时目录；它使用 `??=`，**不会覆盖已有 QUANT_DATA_DIR**。全量测试前查看并清除当前 shell 的继承值，让默认隔离生效：

```powershell
Get-Item Env:QUANT_DATA_DIR -ErrorAction SilentlyContinue
Remove-Item Env:QUANT_DATA_DIR -ErrorAction SilentlyContinue
pnpm typecheck
pnpm test
```

清除变量不会删除磁盘数据；之后若启动应用，必须重新设置隔离目录。非 Vitest 脚本不受 setupFiles 保护。不要并行运行 DLL 验证与覆盖 runtime 的构建，也不要为了单函数改动跑桌面/浏览器。

## 构建、准备、冒烟与打包顺序

```powershell
$env:QUANT_DATA_DIR = Join-Path $PWD '.test-data\milestone'
pnpm typecheck
pnpm test
pnpm build
pnpm desktop:prepare
# 以下由管理者在有显示/GPU权限的环境执行，执行者止步于上面
pnpm desktop:smoke
# 按当前里程碑的持久 Playwright 用例核对隔离服务
# 退出 GuanlanQuant.exe 后：
pnpm desktop:pack
node scripts/desktop-smoke.mjs --packaged
```

**desktop:smoke 前必须先 desktop:prepare。** prepare 向构建好的 standalone 复制 static/public/runtime、Node 与许可文件；桌面入口由 runtime:build 编译，prepare 不能替代 build。`pnpm build` 已先调用 runtime:build，单独修改 worker 后也需重建 runtime。`pnpm start` 启动已准备的服务；不拿旧 runtime 验证新源码。

`desktop:pack` 的 [pack-desktop.ps1](../scripts/pack-desktop.ps1) 自身再次 build → prepare → electron-builder，暂存于 `release/_next`，成功后替换为唯一 `release/win-unpacked`。这是脚本内部暂存，不是允许保留多版本输出。应用占用时停止打包、保留现有 release；运行检查失败也不能绕过。对外分发前先处理 [第三方许可](../THIRD_PARTY_NOTICES.md)。

新增 migrations.ts 条目就意味着旧打包版落后；管理者负责重打包并验收。禁止修改 user_version 或删库让旧 exe 强行启动。本次文档任务无迁移、无打包。

## 数据、凭证、日志的位置

| 内容 | 位置与依据 | 维护边界 |
|---|---|---|
| 用户数据根 | 默认 `%LOCALAPPDATA%\QuantWorkbench`；QUANT_DATA_DIR 可覆盖，见 [db/index.ts](../src/server/db/index.ts) | 浏览器/桌面默认共享，不是临时缓存 |
| SQLite | 数据根下 `quant.sqlite`，运行时有 `-wal`/`-shm` | 设置、快照、任务、报告、台账等在库内；不要只拷主文件遗漏 WAL |
| 凭证 | 数据根下 `credentials/*.bin`，见 [vault.ts](../src/server/vault.ts) | Windows DPAPI；包含渠道密钥及模拟身份，不能当普通缓存删；不写日志或提交 |
| 桌面服务日志 | 数据根下 `server.log`，见 [electron/main.ts](../electron/main.ts) | 默认即 `%LOCALAPPDATA%\QuantWorkbench\server.log`；开发前台看终端输出 |
| 通达信源 | 配置根下 vipdoc、T0002/hq_cache | 只读，重扫不会下载或修复源行情 |
| 构建输出 | `.next/`、`runtime/`、`desktop/` | 可重建，但先停引用它们的应用/worker |
| 桌面交付 | `release/win-unpacked/` | 管理者整体替换，保留整套依赖 |
| 核对证据 | [review/](review/README.md) | 历史数据，不是缓存；不能冒充当前行情 |

应用不复制 Codex/Claude CLI 登录令牌，CLI 在本机自行认证；DeepSeek 从环境变量读取密钥，配置说明见根 README。不要输出 `.env`、业务凭证或未脱敏远程响应。

## 常见故障

### “服务启动超时”

先查看 `%LOCALAPPDATA%\QuantWorkbench\server.log`（若设隔离变量则看对应目录）。已知常见根因是 `数据库版本高于此应用版本，请使用较新的应用`：开发/测试曾推进共享数据库，而 exe 未重打包。由管理者使用当前代码重打包；不要重置数据库版本或删除账本。若日志不是此错误，按实际堆栈继续定位，不能把所有超时都归因数据库。

### 缠论 golden 失败

先核对 [vendor 清单](../vendor/czsc/README.md)、vendor DLL 与 runtime 副本 hash，再确认 DLL 和权威 C++ 断言/fixture 是同一来源版本。历史故障是外部 build 目录残留旧 DLL，不是配置码不对。配置 0/1100 分别对应笔/特征线段，两族不能混用；注册入口是 RegisterTdxFunc，并非直接导出 Func30。

```powershell
Get-FileHash vendor/czsc/CZSC64.dll -Algorithm SHA256
Get-FileHash runtime/czsc/CZSC64.dll -Algorithm SHA256
```

若副本不一致，先退出持有 DLL 的应用/worker，再 `pnpm runtime:build`。vendor 本身与 golden 不符应交管理者核对/重建，不调整测试期望或偷偷换 FFI。数据不足明确“无结构”不是 golden 通过。

### 测试偶发文件级失败 / DLL EBUSY

已稳定复现的缺陷是 beforeAll 无条件覆盖被占用的 `runtime/czsc/CZSC64.dll`，不是已证实的 20 秒超时。[tests/helpers/czsc-runtime.ts](../tests/helpers/czsc-runtime.ts) 已改为 COPYFILE_EXCL 首次复制，存在则逐字节核对，不覆盖已加载文件；[czsc.test.ts](../tests/czsc.test.ts) 有占用回归用例。

若仍报 EBUSY，保留完整报错路径/阶段，找出是否另一个 build、旧测试或应用正在覆盖 DLL，停止已确认的占用者后重建再验证。内容不一致应明确失败，不吞错误、不放宽 timeout、不把“重跑好了”当修复。旧轮次未保留原始栈，因此不能声称历史每次偶发都由这一原因造成。

### 公式拒绝、收益/成本空白、模拟盘不可卖

- 不支持函数/未来函数是明确门禁，读函数名和行号；原文含 FINANCE/DYNAINFO 就不能当完整可运行公式。
- 信号台账先看 GBBQ 最大事件日期、含除权/未知、停牌、到期日及缺行情原因；不要填零。成本空白还要核对个人送转到账/认购证据及报价日期。
- Q0 当日可卖 0 是 T+1 门禁，不能同日往返或重复买入来“补验收”；最新记录见 [Q0](review/q0-mock-trading-log.md)。普通日线日历盘中不含今日的问题仍待产品裁定，不能沿用历史脚本临时上下文当正式修复。

## 可清理缓存与恢复

| 缓存/产物 | 安全处理条件 | 恢复方式 |
|---|---|---|
| tdx 尾窗/TNF、screen-cache、metrics-cache、breakout 单结果等内存缓存 | 退出对应服务；无需删文件 | 重启后重新读取/计算，源数据不变 |
| `.next/` | 停止 dev/start/桌面，不在构建途中删 | `pnpm build` → `pnpm desktop:prepare` |
| `runtime/`、`desktop/` 生成产物 | 退出持有 DLL/服务，保留 vendor 与源码 | runtime:build（或 build）→ desktop:prepare |
| 已确认废弃的 `.test-data/<独立实验>`、临时 `quant-test-*` | 核对绝对路径、确认进程已退出且不含需保留证据/模拟身份；Q0 目录尤其不可一概删除 | 新空目录可重建测试状态，原凭证/成交不会自动恢复 |

删除前解析完整目标并确认位于预期目录；只用 PowerShell LiteralPath，勿跨 shell 拼接删除。这里不给批量删数据脚本。SQLite 内的“缓存”可能与不可变证据、报告、台账共库，没有经核实的通用安全清库流程；**不要手工删表、quant.sqlite、WAL 或 credentials**。需要备份时停止全部读写进程后完整保留数据目录，恢复须匹配应用版本及 DPAPI 身份，跨 Windows 身份可恢复性未核实。

## 文档与复现脚本的旧路径

核对材料现归 [review/](review/README.md)。旧持久浏览器/实操脚本仍硬编码原输出路径，属于 tests/，本次不修改也不运行。再次生成证据前需在独立获授权任务中迁移这些路径，不能让脚本重建已删除的 m2-review/n3-review 或 output。两份消息样本的旧路径兼容情况见 review 入口。
