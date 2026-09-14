# 显式实网对比

这些工具不属于默认离线测试，不安装库、不改系统设置、不请求付费数据，也不操作数据库。Python 调度器每次最多 3 个子进程，每个子进程 45 秒预算；超时、异常、空数据均保留，退出成功不代表数据可用。

版本：xmtdx 0.2.1 / rustdx-complete 1.11.0。源码请从对应发布包获取，参数传绝对路径。样本日期固定为 2026-09-14；未来历史保留范围改变时需要显式更新样本日期。

```powershell
$env:PYTHONUTF8 = '1'
python xmtdx-all.py --source <xmtdx的src目录> --report <临时目录/xmtdx.jsonl>
python xmtdx-helpers.py <xmtdx的src目录>
```

`xmtdx-all.py` 按 `TdxClient` 的公开 `get_*` 方法建立清单，分别执行同步和异步版本；基准为 3 节点 × 22 方法 × 2 模式，再补市场、文件和周期样本。公司内容参数来自实际栏目目录；不伪造文件名。`xmtdx-helpers.py` 单独覆盖测速、工厂、连接生命周期与异步心跳。

Rust 在临时 Cargo 项目内构建：将 `rustdx-all.rs` 作为 `src/main.rs`，依赖以下两项。serde_json 仅用于探针输出，不是 tstdx 包依赖。

```toml
[dependencies]
rustdx-complete = "=1.11.0"
serde_json = "1"
```

```powershell
cargo build --manifest-path <临时Cargo.toml>
python rustdx-all.py --exe <编译出的exe绝对路径> --report <临时目录/rustdx.jsonl>
```

Rust 批量方法内部使用库默认连接池，不能沿用指定 host 的配置，因此记录 `host_scope=library-default-pool`；批量返回的每一项单独判定。`minute_raw` 直接调用底层协议，与高层方法的回退区别开。

默认只测试行情 TCP 数据 API 及其封装，不把指标计算、日历、缓存、CLI 东财下载或 vipdoc 本地文件解析混入 TCP 可用性统计。行情内容有数据仍须另验新鲜度、复权、量额单位与业务语义。
