# 来源正文只读快照

文档目录按原技能相对路径保存原始字节，便于审阅与 git diff；不导入、不执行、不格式化。manifest 记录正文 hash、字节数及原锁定 hash。锁定基线仍是 ../trading-skills-source-lock.json，快照不能替代来源 hash 校验。

locked/ 是非 planned 方法引用且逐字节匹配锁定 hash 的正文。unaligned-current/ 是 D0 六份当前漂移正文：**未经语义对齐、不得作为已实现规则依据**，不伪称旧锁定正文，不表示漂移已解决。后续可用 `git diff --no-index <快照路径> <当前来源路径>` 审阅；漂移快照只能与本次观测版本比较，不能冒充旧锁定版本。

覆盖：{"locked": {"files": 21, "bytes": 149320}, "unaligned-current": {"files": 6, "bytes": 188860}}。仅 B6 语义对齐获准后更新锁定与登记；不可自动刷新本目录。
