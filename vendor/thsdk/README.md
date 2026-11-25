# thsdk 同花顺行情 DLL

| 项 | 值 |
|---|---|
| 来源包 | PyPI `thsdk==2.0.2`（`thsdk-2.0.2.tar.gz`，22,590,742 字节） |
| 源包 SHA-256 | `12b950a81df0ddc80f577dca3aed11660e8f0c5ef59b5ef4a21846ae3915f40a` |
| 包内路径 | `thsdk/libs/windows/amd64/hq.dll` |
| 文件 | `hq.dll`（Windows x64，`Go 1.27.0` + MinGW GCC `c-shared`，ABI `2.0.0`） |
| 大小 | `11536896` 字节 |
| SHA-256 | `d396628429f0c08809b069a20a8dd38bd4718d0361f48f41a061f688aa8323f0` |
| 许可 | MIT（见同目录 `LICENSE`；上游未提供 Go 源码） |

## 为什么放这里

`runtime/` 在 `.gitignore` 中且由 `pnpm runtime:build` 生成，不适合存放版本化资产。
本目录是 git 跟踪的固定版本事实来源；`scripts/build-runtime.mjs` 复制到
`runtime/thsdk/hq.dll`，`scripts/prepare-desktop.mjs` 已递归拷贝整个 `runtime/`，
开发、构建与桌面分发均直接使用固定版本并强制校验上述 SHA-256，无需用户在设置页配置 DLL 路径。

## 升级说明

升级上游 `thsdk` 版本时必须同步完成：

1. 替换 `vendor/thsdk/hq.dll` 并更新本文件的包版本、字节数与 SHA-256；
2. 重新运行 Windows x64 ABI 与全能力样本核验（`tests/manual/thsdk-abi-probe.mjs`）；
3. 更新 `src/server/data-sources/thsdk/thsdk-known-hashes.ts` 中的 `BUNDLED_THSDK_DLL`；
4. 执行 `pnpm runtime:build` 与 THSDK 打包及契约测试。
