# 全站浅色改造分批提交与桌面包

用户在前端实施后追加授权“分批提交，最后打包”。本次完成本地主题提交、构建修复及Windows x64目录包；未推送。初始开发阶段仅语法检查，打包阶段按新增授权执行生产构建自带的类型检查，不将其称为业务或深度测试。

## 本地提交

| 提交    | 内容                                                   |
| ------- | ------------------------------------------------------ |
| f60be8c | 24页产品流程、受限Stitch设计、冻结问题及开发落点       |
| 82e304f | 浅色主题、图表、共享控件、导航和设置分区               |
| f7d5d87 | 行情、选股、任务、预选及跨市场工作区                   |
| e05fc8e | 研究、档案、新闻、台账与账户复盘工作区                 |
| b416909 | 修复两处研究组件的客户端声明顺序                       |
| 25fadcc | 三处既有复盘测试调用补充分区参数，断言不变且未运行测试 |

产品设计与应用实现分批提交，共享文档只暂存本任务追加段；盘中预选只提交本轮UI片段。原RPS、回测、AGENTS、其他模块和缓存修改保留，未纳入上述提交；MCP文件及用户维护文案未改。

## 构建范围与失败处理

从`25fadcc`建立干净detached工作树`D:/github/qlight-pack-20261113`，按现有锁文件执行`pnpm install --frozen-lockfile --offline`与hoisted安装。安装的原生生命周期下载了所需Node头文件；未修改依赖版本或锁文件，未复制主工作区.env。

设置独立`QUANT_DATA_DIR`、关闭Next遥测、清空NODE_PATH后执行项目原有`pnpm desktop:pack`。它执行工作区包构建、runtime重建、Next生产编译与类型检查、desktop:prepare及electron-builder目录打包。

第一次构建被两个组件中置于import之后的客户端声明阻断；第二次构建被三个旧测试调用缺少新section参数阻断。分别作最小修复并独立提交，没有跳过声明检查、类型检查或删除断言。第三次完整打包退出0，25个静态页面生成项完成，桌面准备和Windows x64包生成通过；未执行Vitest、浏览器、深度测试或应用启动。

## 静态包核对与交付

逐层核对包内Next/React、SQLite、worker Koffi入口、Turbopack实体别名及Windows x64原生文件。Koffi按实际worker和Next别名解析，SQLite13按实际prebuilds/win32-x64.node检查，不把旧版根CJS入口或原生文件名假设当成包缺陷。包内残留链接0，浅色编译CSS存在，BUILD_ID与prepare标识一致，bundled Node为22.22.2，server.js语法检查通过。

先后两次运行现有应用占用守卫，并在正式目录内暂存复制、核对后替换`release/win-unpacked`。旧包移到`.test-data/light-package-20261113/previous-win-unpacked`，未删除。复制前后服务器树的全部文件按相对路径及SHA256聚合，结果一致。

| 校验项          | 结果                                                               |
| --------------- | ------------------------------------------------------------------ |
| 应用入口        | `release/win-unpacked/GuanlanQuant.exe`                            |
| 源码提交        | `25fadcc`                                                          |
| Next Build ID   | `_AP59GzkorMTcFEGN3q8_`                                            |
| 文件数 / 总字节 | 2432 / 558166068                                                   |
| EXE SHA256      | `6C406895715792FD5DE12CD34BDB6BA739E9D81DCD299103760656CE4D76A2FD` |
| app.asar SHA256 | `5CF04F515145AD20EB8CDEAFC1500E5EB71545477ADD38998B36366EC4B49D04` |
| server树SHA256  | `F4E42B882A6BB79F7954FD9FA708982C5D0E191102F95EC0039A3C03E8AAD8B7` |

Electron宿主代码未变，EXE与app.asar沿用相同内容；本次界面更新在resources/server，以新Build ID和server树摘要核对。移动或分发时保留整个win-unpacked目录，不能只复制EXE。

构建、失败、复制及核对日志位于`.test-data/light-package-20261113/`，最终元数据为`delivered-package.json`。工作树保留用于复核，主工作区其他修改保留。本文件及后续进度说明仅属文档收尾，不重新构建未改变的应用。

## 未验证范围

未启动打包EXE、bundled server或浏览器；未进行真实账户、数据库迁移、行情查询、通知或交易操作。静态包核对不代表实际交互、独立启动或真实平台联调已通过；本轮继续遵守不做深度测试的要求。
