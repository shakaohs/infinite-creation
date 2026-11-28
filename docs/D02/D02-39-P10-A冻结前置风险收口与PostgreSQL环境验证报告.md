# D02-39 · P10-A 冻结前置风险收口与 PostgreSQL 环境验证报告

> **性质**：执行准备报告。两件事：① 登记用户对 P5-1~P5-5 的正式确认；② 在本机准备可用的 PostgreSQL 16 测试环境并**实跑**锁能力与双连接并发验证。
> **基线**：`1c7148b`（D02-38）。**零业务代码、零 DDL、零 `schema-manifest.json`、零正式规范修订、零真实库写入。**
> **一句话结论**：**P5 通过、P7 通过**，五项冻结前置**首次全部满足**；D02-36 具备冻结条件，但**本报告不冻结、不启动阶段 A**。
> **禁止误读**：22 项通过是「PG 环境与锁原语可用」的证明，**不是** `txProject`/`txProjects` 已实现，也**不是** TST-LOCK-01~13 已通过（那是 P2 的事，要等 A-05 落地）。

---

## 一、用户授权依据

用户于 2026-11-28 作出两项明确授权，本报告的全部动作以此为唯一依据：

| # | 授权内容 | 原文要点 | 生效范围 |
|---:|---|---|---|
| 1 | P5-1~P5-5 五项风险处理方案 | 「将以下方案登记为用户已确认的实施要求」（逐条给出 P5-1 断言、P5-2 锁对象语义、P5-3 递归同事务、P5-4 读写同事务、P5-5 分批迁移纪律） | 自登记起即为**实施约束**，不是建议 |
| 2 | PostgreSQL 16 独立测试环境准备 | 「优先在当前 Workbuddy 可访问的开发环境准备 PostgreSQL 16」；允许「安装或启动 PostgreSQL 16、创建独立测试数据库、编写临时环境验证脚本、执行环境与锁能力验证」 | 仅环境与验证；**不含**任何业务代码改动 |

**未授权的事（本轮一次也没做）**：实现 `txProject`/`txProjects`、迁移 25 处调用点、启动 IMP-01~04、启动阶段 A、执行 55 项正式验收测试。

---

## 二、P5 五项风险逐项确认

### 2.1 确认表

| 编号 | 风险原文 | 用户确认的方案 | 落地约束（实施时不得偏离） | 本轮验证 |
|---|---|---|---|---|
| **P5-1** | `renumberTwoPhase` 签名无 `projectId` | **不加参数**，改用锁集合断言 | ① 必须断言 `lockedProjects` 含当前行 `project_id`；② 未持锁抛明确错误码（`TX_PROJECT_NOT_LOCKED`）；③ 断言必须是**统一的一处**实现 `assertProjectLocked()`，不许各调用点自己写 | 方案确认；断言未实现（阶段 A） |
| **P5-2** | `Projects.remove` 删的就是被锁项目本身 | **不加**针对删除行的特殊锁机制 | ① 明确 PG advisory lock 的锁对象是**整数键**，不是数据行；② 删行不影响本事务已持有的锁；③ 实施报告须记录该语义与验证方式 | **已实测**：LOCK-12 —— 删掉被锁项目的数据行后，`pg_locks` 里该 advisory lock 仍在（before=1 / after=1 / 行已删=1） |
| **P5-3** | `Assets.remove` 递归取不到项目 | 入口解析一次 `projectId`，递归沿用同一 `txProject` | ① 递归层**不得**重新推断项目 ID；② 递归层**不得**开无项目锁的事务；③ 增父/子递归删除的事务测试 | 方案确认；递归改造待 A-05 |
| **P5-4** | `loadSceneInput` 在写事务之外 | 读与写放**同一项目事务边界**内 | ① 不允许「只给外层写入加锁、读取发生在锁外」；② 无项目事务保护时调用必须被断言/明确错误拦下；③ 增锁外调用负向用例 + 并发改输入用例 | 方案确认；顺序问题已在 D02-38 §5.4 定位（`run-scene.js:137` 早于 `:161`） |
| **P5-5** | 20 处 M 分批改造的回归成本 | 按 §5.5 分组顺序分批 | ① 每批跑全量；② 17 条历史失败**逐条**比对，不比数量；③ 新增失败必须定位原因，**不得改基线掩盖**；④ 出现无法解释的回归即**停止后续迁移** | 纪律确认；尚未开始迁移 |

### 2.2 由此新增的两条实施约束（写死）

| # | 约束 | 理由 |
|---:|---|---|
| 1 | `assertProjectLocked(projectId)` 必须是**唯一一处**实现，供所有写入入口复用 | 五个风险里三个（P5-1、P5-3、P5-4）都靠它兜底；分散实现必然漏一处，而漏一处就等于没有 |
| 2 | `txProject` 的返回值须带**冻结**的 `lockedProjects`（只读数组）供断言读取；**禁止**提供任何 `addProject()`/`lockMore()` 之类的追加接口 | 有追加接口就等于允许动态扩展，D02-34 §2 已否决；LOCK-07 的实测也说明 SQL 层不会替你拦 |

### 2.3 P5-2 为什么必须单独说明（不是废话）

「锁对象是整数键」这条如果没写清，实施时很容易写出两种错：

- **错法一**：以为「删了项目行，锁就没了」→ 删除流程里提前 `COMMIT` 再删，结果锁提前释放、别的写者挤进来。
- **错法二**：以为「锁跟着行走」→ 给删除加一套额外的锁表/锁行，造出第二套并发机制（正是 D02-34 禁止的「另造事务管理器」）。

LOCK-12 的实测把这条钉死：**行删了，锁还在，直到事务结束**。

---

## 三、PostgreSQL 安装方式与版本

### 3.1 选定路径：便携二进制包（非安装程序、非容器）

| 候选 | 是否可用 | 判定 |
|---|---|---|
| 已有 PostgreSQL 服务端 | **无**（`/c/Program Files/PostgreSQL` 不存在） | 排除 |
| `winget install PostgreSQL.PostgreSQL.16` | 命令存在，但走 EDB MSI：需管理员提权 + 注册 Windows 服务 | **未采用**：非交互环境无法确认 UAC，且装出来的服务默认以 `LocalSystem` 运行，会被 `postgres.exe` 的管理员令牌检查直接拒绝（见 3.3） |
| Docker / Podman | **均未安装**（`command -v` 全部为空） | 排除（用户明确「不得假定容器运行时已安装」） |
| WSL | `wsl.exe` 存在但被**安全策略黑名单**拦截（`PROGRAM BLOCKED BY SECURITY POLICY`） | 排除，且不尝试绕过 |
| **EDB 便携二进制包** | **可用** | **采用** |

### 3.2 安装事实

| 项 | 值 |
|---|---|
| 包 | `postgresql-16.9-1-windows-x64-binaries.zip`（来源 `get.enterprisedb.com`） |
| 大小 | 314,500,604 字节 |
| 解压后 | `D:\pg16\pgsql\`（`postgres.exe` 报 `PostgreSQL 16.9`） |
| 数据目录 | `D:\pg16\data`（`initdb` 新建，与项目仓库**完全分离**） |
| 日志 | `D:\pg16\data\log\pg.log`（`logging_collector = on`） |
| 端口 | **55432**（非默认 5432，避免与将来可能的其他实例冲突） |
| 监听 | `listen_addresses = '127.0.0.1'`（仅回环） |
| `max_connections` | 40（够 TST-LOCK 的双连接 + 少量后台） |
| 版本实测 | `server_version = 16.9`，`server_version_num = 160009`，`PostgreSQL 16.9, compiled by Visual C++ build 1943, 64-bit` |
| 解压工具 | 系统 `bsdtar`（`C:\Windows\System32\tar.exe`）——Git Bash 自带的 GNU tar 读不了该 zip（`Archive base-256 value is out of off_t range`） |

### 3.3 一个必须记录的坑：`postgres.exe` 拒绝以管理员运行

```
Execution of PostgreSQL by a user with administrative permissions is not permitted.
The server must be started under an unprivileged user ID ...
```

本机身份是 `pc-20260818doxa\administrator`，直接启动被拒。三个尝试路径与结果：

| 尝试 | 结果 |
|---|---|
| `pg_ctl start` / `postgres.exe` 直接跑 | **被拒**（管理员令牌检查） |
| 前台进程跑（会被会话结束杀掉） | 也会被拒，且即使起来了也不持久 |
| **`runas /trustlevel:0x20000`（受限令牌）** | **成功**：`postgres.exe` 以去管理员 SID 的令牌运行，正常启动并监听 |

**当前启动方式（供复现）**

```
# 在项目仓库之外执行；输出重定向到日志由 logging_collector 负责
runas /trustlevel:0x20000 "D:\pg16\pgsql\bin\postgres.exe -D D:\pg16\data"
```

**生命周期（重要，别当它是常驻服务）**：这个实例是**当前会话托管的进程**，不是 Windows 服务。会话结束后进程停止。因此：

| 影响 | 说明 |
|---|---|
| 不影响 P7 判定 | P7 要求「能真实连接并验证锁能力」，本轮已实测通过 |
| 影响 P2 的可重复性 | TST-LOCK-01~13 正式执行前，必须在同一会话内重新拉起，或改注册为服务（需另建标准账号，属环境决策，不在本轮范围） |
| 数据可复用 | `D:\pg16\data` 持久化在磁盘，重启后库与数据仍在（已实测自动恢复：`database system was not properly shut down; automatic recovery in progress` → `ready to accept connections`） |

---

## 四、独立测试数据库配置验证

### 4.1 认证配置（`pg_hba.conf` 生效行）

```
local   all   all                       trust        →  已注释（Windows 无 unix socket，显式关掉避免误解）
host    all   all   127.0.0.1/32        scram-sha-256
host    all   all   ::1/128             scram-sha-256
```

### 4.2 三项实测

| 检查 | 命令 | 结果 |
|---|---|---|
| 建独立库 | `createdb -h 127.0.0.1 -p 55432 -U postgres infinite_creation_test` | 成功 |
| 库清单 | `SELECT datname, pg_size_pretty(pg_database_size(datname)) FROM pg_database` | `infinite_creation_test` / `postgres` / `template0` / `template1` —— **只有这四个，没有任何生产库** |
| 无密码被拒 | `psql -w ...`（`-w` = 不提示） | `fe_sendauth: no password supplied` —— **认证真的生效**，不是 trust 放行 |
| 带密码可连 | `psql -w ...` + env 传密码 | 返回 `ok` 与 backend pid（实测 1392） |

### 4.3 凭据处理

| 项 | 做法 |
|---|---|
| 密码生成 | `crypto.randomBytes(18).toString('base64url')`，只写入 `D:\pg16\pw.txt` |
| 传递方式 | 运行时 `PGPASSWORD="$(cat /d/pg16/pw.txt)"`，**不出现在任何命令行文本、报告或日志中** |
| 报告披露 | 本报告**不含**密码、连接串或任何凭据；只记录「有这么一个文件，勿提交」 |

---

## 五、advisory lock 真实验证（12 项）

### 5.1 机制说明（先说清再给结果）

| 项 | 事实 |
|---|---|
| 函数 | `pg_advisory_xact_lock(bigint)` —— **事务级**，`COMMIT`/`ROLLBACK`/连接断开**自动释放**，无需显式 unlock |
| 键来源 | 把 `project:` 前缀拼上项目 id，再经 `hashtextextended(..., 0)` 得到 64 位有符号整数（SQL 里是双竖线拼接；此处改用文字描述，避免与表格分隔符混淆） |
| 锁粒度 | 项目级（一个项目一把键），**不是库级**，也不是行级 |
| 在 `pg_locks` 里的长相 | `locktype='advisory'`，64 位键被拆成 `classid`（高 32 位）+ `objid`（低 32 位）。**注意：`objid` 是 oid，直接用 bigint 键去比会 `22003 OID out of range`** —— 本轮踩过，改为按 `pid` 统计 |
| 等待语义 | 拿不到就**阻塞**；`lock_timeout` 到了抛 `55P03 (lock_not_available)` |

### 5.2 十二项结果

| # | 验证项 | 结果 | 关键观测 |
|---|---|---|---|
| LOCK-01 | A 事务内取到项目 P 的锁 | **通过** | `key=-8485539091305779290`，`pidA=3408` |
| LOCK-02 | A 持锁时 B 取同一把锁 → 阻塞后超时 | **通过** | `lock_timeout=2000ms` → `code=55P03`；**不静默通过** |
| LOCK-03 | 提交前 `pg_locks` 能看到该锁 | **通过** | `n=1`（按 `pid` 计） |
| LOCK-04 | A **提交**后 B 立即取得同一把锁 | **通过** | `pidB=29220` |
| LOCK-05 | A **回滚**后 B 取得同一把锁 | **通过** | 异常路径同样释放 |
| LOCK-06 | A 锁 P、B 锁 Q 可同时持有 | **通过** | 证明是**项目级**粒度，不是库级；两库语义在此分叉 |
| LOCK-07 | 同一事务内「持 P 后再追加 Q」在 SQL 层**被允许** | **通过（作为一个负面事实被确认）** | 说明顺序冻结**只能由应用层强制**，PG 不会替你拦 —— 这正是 D-30-13 要求 `lockedProjects` 取锁后冻结的实证 |
| LOCK-08 | 反序取锁（A: P→Q，B: Q→P）触发真实死锁检测 | **通过** | `result=40P01` —— **死锁不是理论，是实测** |
| LOCK-09 | 死锁回滚后两条连接可用且无锁残留 | **通过** | `a=true b=true residual=0` |
| LOCK-10 | 按排序一次声明完整集合取 4 把锁，重复 20 轮 | **通过** | 无死锁；`keys=…704306,771976,174625,220330`（字典序） |
| LOCK-11 | 会话被 `pg_terminate_backend` 终止（模拟进程崩溃） | **通过** | `killed_pid=35668`，锁自动释放，B 随后取得 |
| **LOCK-12** | 删掉「被锁项目」的数据行 | **通过** | `locks before=1 after=1 rowDeleted=1` —— **锁对象是整数键，不是行**（P5-2 的实证） |

---

## 六、`hashtextextended` 可用性验证

| 检查 | 结果 |
|---|---|
| 函数存在且可执行 | **通过**：`hashtextextended('project:p1', 0) = 5448799916254079705` |
| 同输入同输出（确定性） | **通过**：连查两次结果相同 |
| 不同输入不碰撞（样本） | **通过**：`project:p2 → -8446123607194569092`（与 p1 不同） |
| 返回类型 | `bigint`（64 位有符号），可直接喂给 `pg_advisory_xact_lock(bigint)` |
| U-32-2 结论 | **可用**，不必退到 `hashtext`（32 位） |

**一条必须同时说清的边界**：64 位哈希仍有碰撞可能（生日界约 55 亿次量级），但对「项目数量」这个量级（数十到数千）实际碰撞概率可忽略。**真正的防护不是哈希不碰撞，而是锁 + 唯一索引 + `assertProjectLocked` 三层叠加**。不要把它写成「64 位就等于不碰撞」。

---

## 七、双连接并发验证证据

### 7.1 连接身份（本轮实测 PID）

| 连接 | backend_pid | 库 | 用途 |
|---|---|---|---|
| V | 32360 | `infinite_creation_test` | 版本/权限/能力检查 |
| A | 3408 | 同上 | 持锁方、写入方 |
| B | 29220 | 同上 | 争锁方、读取方 |
| C | 35668 | 同上 | 被 `pg_terminate_backend` 终止（模拟崩溃） |

四个 PID 互不相同，且全部是**独立 TCP 连接**——不是同一连接上的两个事务，也不是 `Atomics.wait` 单连接模拟。`pg-worker.mjs`（单连接 + 同步等待）本次**完全未使用**。

### 7.2 六项要求逐条对应

| 用户要求 | 对应用例 | 结果 |
|---|---|---|
| ① A 持 P 时 B 不能同时获得 P | LOCK-02 | 通过（`55P03`，阻塞后超时而非静默） |
| ② A 提交或回滚后 B 能继续获得 | LOCK-04（提交）、LOCK-05（回滚） | 通过 |
| ③ 不同项目锁按设计粒度并发 | LOCK-06 | 通过（P 与 Q 同时持有） |
| ④ 多项目锁遵守排序与完整集合预声明 | LOCK-10（正序 20 轮）＋ LOCK-08（反序必死锁） | 通过 |
| ⑤ 持锁后追加项目锁必须拒绝 | LOCK-07 | **SQL 层不拒**（实测允许）⇒ **必须由应用层 `TX_NESTED_MULTI_PROJECT` 强制**；这是本轮唯一一条「不能靠数据库兜底」的要求 |
| ⑥ 事务异常后锁正确释放 | LOCK-09（死锁）、LOCK-11（进程被杀）、LOCK-05（回滚） | 通过 |

### 7.3 时序（以 LOCK-02/04 为例，可复核）

```
t0  A: BEGIN; SELECT pg_advisory_xact_lock(kP)        → 取得（pid 3408）
t1  A: SELECT count(*) FROM pg_locks ...              → 1
t2  B: BEGIN; SET LOCAL lock_timeout='2000ms'
t3  B: SELECT pg_advisory_xact_lock(kP)               → 阻塞
t4  B: ... 2000ms 后                                 → ERROR 55P03
t5  B: ROLLBACK
t6  A: COMMIT                                         → 锁随事务释放
t7  B: BEGIN; SET LOCAL lock_timeout='2000ms'
t8  B: SELECT pg_advisory_xact_lock(kP)               → 立即取得（pid 29220）
t9  B: ROLLBACK
```

### 7.4 三组写事务交错

| # | 场景 | 结果 |
|---|---|---|
| INTERLEAVE-01 | A 未提交时 B 读不到，A 提交后 B 读到 | **通过** `before=0 after=1` —— 证明两条连接的事务**真的交错**，不是串行假象 |
| INTERLEAVE-02 | B 的并发 `MAX+1` 撞上 A 未提交的唯一值 | **通过** `code=55P03` —— **PG 会阻塞等待**，不是立即失败 |
| INTERLEAVE-03 | 读写分离：两连接各自先读 `MAX+1`，各自写入 | **通过** `sameNo=true`（都是 1）、后写者 `23505` |

### 7.5 INTERLEAVE-02/03 推翻了一句旧表述（必须改口径）

旧记忆里写的是「唯一索引只是让它**失败**而不是**等待**」。这只对 SQLite 成立。**PG 上实测是：**

- 写的是 `INSERT ... SELECT MAX+1`（同语句内重算）→ 第二个写者**阻塞**，等第一个结束；若第一个提交，它会算出新号而**成功**（不撞）。
- 写的是「先读出号、再写入」（`nextAppendGlobalNo` + `insertStoryShot` 的真实路径，`render/global-no.js:78` / `:198`）→ 两个写者**算出同一个号**，后写者报 `23505`。

**所以正确表述是**：唯一索引既不能防止「算出同一个号」，也不能保证「失败得干脆」——它在 PG 上会把冲突变成一段阻塞。**项目级锁是唯一能同时消除「重复计算」与「无谓阻塞」的手段**，这与 A5 的结论一致，但理由要按 PG 的真实行为重写。

---

## 八、环境安全边界

| 边界 | 措施 | 验证方式 |
|---|---|---|
| 网络暴露面 | 只监听 `127.0.0.1:55432`；`listen_addresses` 单值；无 `0.0.0.0` | `netstat -ano` 只出现 `127.0.0.1:55432 LISTENING` |
| 认证 | `host` 行全为 `scram-sha-256`；`local ... trust` 已注释 | 无密码连接 → `fe_sendauth: no password supplied` |
| 库隔离 | 新集群 `initdb` 全新数据目录，库清单只有 4 个默认库 + 1 个测试库 | `SELECT datname FROM pg_database` |
| 生产数据 | **不接触**：项目真库是 `data/ic.db`（SQLite），与本实例无任何连接配置关联；`config.json` 的 `db.provider` 仍为 `sqlite`、`postgres.url` 仍为 `""` | 真库三 SHA 未变（`b2ebdb54…` / `2711665d…` / `22d61103…`）；`git status` 无 `config.json` 改动 |
| 凭据 | 只存 `D:\pg16\pw.txt`（仓库外）；命令中经 `$(cat …)` 注入；报告与日志零披露 | 全文检索报告与日志，无密码字面值 |
| 破坏性操作 | 只在 `infinite_creation_test` 内建/删 `p10a_probe` 临时表；结束时 `DROP TABLE` | 脚本末尾 `DROP TABLE IF EXISTS p10a_probe` |
| 可重复清理 | `initdb` 一次即可重建；`pg_ctl stop` + 删 `D:\pg16\data` 即彻底清空 | 见 §3.3 生命周期 |
| 未做的事 | 未注册 Windows 服务、未改系统 PATH、未改本机任何全局 PostgreSQL 配置、未开放防火墙端口 | — |

---

## 九、本轮修改 / 未修改文件清单

### 9.1 修改（仓库内）

| 文件 | 处数 | 内容 |
|---|---:|---|
| `docs/D02/D02-38-…开工前置准备报告.md` | **20 处** | ① 抬头加后续状态（指向本报告）；② §八 P5 行改「通过」；③ §八 P7 行改「通过」+ 22 项证据；④ §八 统计 3→5；⑤ §八 加「勘误留痕」说明旧判定为何保留；⑥ §九 第 1 项（P7）关闭；⑦~⑨ §九 第 2/3/4 项补「方案已确认」；⑩ §十 判定改「具备」；⑪ §十 判据表 P7 行；⑫~⑭ §十三 三问与一句话状态；⑮ §11.1 变更清单加本报告；⑯~⑲ §13.2 下一步四行标记完成；⑳ §10.2 整节重写（①~⑤ 完成、只差 ⑥） |
| `docs/D02/D02-36-…任务书-Draft.md` | **6 处** | ① 抬头「审批与前置进度」改为五项 5/5 通过、技术条件已具备冻结；② §12.2 三问分答的「是否可冻结」行改「可以，等用户签署」；③ §12.3 第 2 步（P5）标已完成；④ §12.3 第 4 步（P7）标已完成 + 22 项证据；⑤ §12.3 第 5 步标为**唯一剩余动作**；⑥ 附录 D 的 Gate 行 |
| `docs/D02/D02-39-…PostgreSQL环境验证报告.md` | 新增 | 本报告 |

### 9.2 未修改

| 对象 | 状态 |
|---|---|
| 业务代码（`lib/**`、`app/**`、`studio/**`） | **零改动**（`git status` 只有两个 md） |
| DDL（`lib/core/schema/tables.js`） | **零改动** |
| `lib/core/schema-manifest.json` | **零改动** |
| D01 / D02 正式规范（含 D02-06 §8.2.4） | **零改动** |
| `config.json`（`db.provider` / `db.postgres.url`） | **零改动** —— 测试连接靠环境变量注入，不写进项目配置 |
| 真实库 `data/ic.db`（及 `-wal`/`-shm`） | **零写入**，三 SHA 未变 |
| 25 处 `tx()` 调用点 | **零改动**（只出清单，未迁移） |
| 55 项正式测试 | **零执行** |
| 仓库外新增（不进 git） | `D:\pg16\`（二进制 + 数据目录 + `pw.txt` + 日志）、`.tmp-pg39/`（验证脚本，提交前删除） |

---

## 十、实际执行命令与结果

### 10.1 安装与启动

| # | 命令（摘要） | 结果 |
|---:|---|---|
| 1 | `curl -L -o pg16.zip https://get.enterprisedb.com/postgresql/postgresql-16.9-1-windows-x64-binaries.zip` | 314,500,604 字节，55 s |
| 2 | `C:\Windows\System32\tar.exe -xf pg16.zip` | 生成 `pgsql\`；Git Bash 的 GNU tar 失败（`base-256 out of off_t range`） |
| 3 | `initdb -D D:\pg16\data -U postgres -E UTF8 --locale=C --auth-local=trust --auth-host=scram-sha-256 --pwfile=D:\pg16\pw.txt` | `Success` |
| 4 | 追加 `port=55432` / `listen_addresses='127.0.0.1'` / `logging_collector=on` 等 | — |
| 5 | `runas /trustlevel:0x20000 "…postgres.exe -D D:\pg16\data"` | `database system is ready to accept connections` |
| 6 | `createdb … infinite_creation_test` | 成功 |

### 10.2 验证（22 项）

| 组 | 用例 | 条数 | 结果 |
|---|---|---:|---|
| 环境 | ENV-01~07 | 7 | **7/7 通过** |
| 锁 | LOCK-01~12 | 12 | **12/12 通过** |
| 交错 | INTERLEAVE-01~03 | 3 | **3/3 通过** |
| **合计** | | **22** | **22/22 通过** |

**证据形式**：完整运行日志（`D:\pg16\verify-final.log`，含每条用例的 backend_pid、键值、错误码与时序），关键行已摘入 §5.2 / §7。日志中不含凭据。

### 10.3 未执行 / 未验证

| 项 | 原因 |
|---|---|
| TST-LOCK-01~13 正式用例 | 依赖 A-05 的 `txProject`/`txProjects`，尚未实现（本轮禁止） |
| 项目内 25 处调用点迁移 | 禁止 |
| 55 项正式验收测试 | 禁止（0 条执行，状态不变） |
| 全量测试复跑 | 零代码变更，沿用 `950 / 922 / 17 / 11`，**未复跑** |
| PG 持久化为 Windows 服务 | 未做（需另建标准账号 + 服务注册，属环境决策，见 §3.3 风险） |
| `txProject` 在 PG 上的**连接池/多进程**表现 | 未验证：本轮是 4 条短连接，真实后端是**单连接 worker**；`pg-worker` 的单连接语义未纳入本轮（P2 前需单独确认） |

---

## 十一、P5、P7 最终状态

| 前置 | 状态 | 证据 | 备注 |
|---|---|---|---|
| **P5** | **通过** | ① 25 处清单（D02-38 §5.2，20 M / 1 R / 4 D）；② 五项风险**全部确认**（本报告 §二）；③ 新增两条实施约束；④ P5-2 已实测（LOCK-12） | 清单与方案均已定；迁移本身属阶段 A |
| **P7** | **通过** | ① 服务端 16.9 可用；② 独立测试库 `infinite_creation_test` 可连；③ `SELECT version()` 成功；④ `pg_advisory_xact_lock` 真实执行（12 项）；⑤ `hashtextextended` 可用；⑥ CONNECT/CREATE/TEMPORARY 权限齐；⑦ 两个独立连接同时建立；⑧ 真实事务交错（INTERLEAVE-01~03） | 唯一保留项：实例为会话托管进程，非 Windows 服务（§3.3），不影响 P7 判定，但影响 P2 的可重复执行 |

### 11.1 反例：什么情况下 P7 会重新变成未通过

| 情形 | 判定 |
|---|---|
| 会话结束、实例停止，且 B 阶段前未重新拉起 | P7 重新变为「未通过」——P2 无法执行 |
| 换成 `db.provider=postgres` 连生产库跑测试 | **违规**，不是 P7 未通过，是安全事件 |
| 只用 SQLite 跑 TST-LOCK 并声称「等价」 | **不接受**，P2 记为未满足 |

---

## 十二、是否满足冻结 D02-36 的条件

### 12.1 七项逐条

| 判据 | 状态 | 证据 |
|---|---|---|
| **P1** 19 项批准记录 | **通过** | D02-35 §7.3（19 行）× D02-38 §二 互校 |
| **P3** 14 项 Gate 决策 | **通过** | D02-38 §4.1（批准/未实现双列） |
| **P5** 清单 + 五项风险方案 | **通过** | 本报告 §二；D02-38 §5.2 / §5.7 |
| **P6** IMP 顺序 + 测试排期 | **通过** | D02-38 §六（`IMP-04→01→02→03`、26 条、R1~R5） |
| **P7** 真实 PG 环境验证 | **通过** | 本报告 §五/§六/§七（22 项实测） |
| **P2 / P4** | **尚未开始** | 属阶段 A 退出 Gate（D02-37 勘误），**不是冻结前置** |
| 19 项决策批准 | **已完成**（2026-11-28） | D02-35 §七 |

### 12.2 结论

**具备冻结 D02-36 的条件。**

五项冻结前置（P1/P3/P5/P6/P7）**首次全部通过**，且每项都有可核查证据：

- P1/P3 → 表格（19 行 / 14 行）
- P5 → 清单 25 行 + 五条方案 + 一条实测（LOCK-12）
- P6 → 顺序 + 26 条测试 + 五轮排期
- P7 → **22 项实跑日志**（不是静态检查，不是 SQLite 替代）

### 12.3 但冻结前还有三件事要你确认（都不阻断技术条件）

| # | 事项 | 为什么必须先定 |
|---:|---|---|
| 1 | **PG 实例的生命周期**：接受「会话内进程 + 用时拉起」，还是要求注册为 Windows 服务？ | 决定 P2 能不能在任意时刻重跑；注册服务需另建标准账号（`LocalSystem` 会被拒） |
| 2 | **`assertProjectLocked` 与 `lockedProjects` 的落地形态**（§2.2 两条约束） | 五个风险里三个靠它；冻结后改这个等于改 A-05 的接口 |
| 3 | **D02-36 的状态行改写**（`Draft` → `已冻结`）与签署 | 冻结是**用户动作**，本轮不代做 |

### 12.4 冻结之后的第一件事（提醒，不做）

阶段 A 的第一批是 A-01~A-03 的 DDL，**不是** `txProject`。`txProject` 在 A-05，P2 又在 A-05 之后。也就是说：**PG 已经就绪，但 TST-LOCK 要等到 A-05 才跑得起来**。这一点别在排期上搞错顺序。

---

## 附录 A · 验证脚本要点（可复现）

完整脚本是一次性的（`.tmp-pg39/verify-lock.mjs`，提交前已删除）。核心模式如下，实施 TST-LOCK 时直接复用：

```js
// 两个独立连接 = 两个 pg.Client（不是同一连接上的两个事务，也不是 pg-worker）
const A = new pg.Client({ host:'127.0.0.1', port:55432, user:'postgres', database:'infinite_creation_test' });
const B = new pg.Client({ ...same });
await A.connect(); await B.connect();
await A.query("SET statement_timeout = '30s'");   // 安全网，防挂死

// 项目键
const kP = (await A.query("SELECT hashtextextended('project:P',0)::text AS k")).rows[0].k;

// 争锁方必须自己设 lock_timeout，否则「阻塞」会变成「测试挂住」
await B.query('BEGIN'); await B.query("SET LOCAL lock_timeout='2000ms'");
try { await B.query('SELECT pg_advisory_xact_lock($1::bigint)', [kP]); }
catch (e) { /* e.code === '55P03' */ }

// 统计本连接持有的 advisory 锁：按 pid，不要按 objid（objid 是 oid，bigint 键会 22003）
await A.query("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND pid = pg_backend_pid()");
```

**两个必踩的坑（本轮都踩过，写下来省下一次）**：

1. `pg_locks.objid` 是 **oid**，用 64 位键直接比会 `22003 OID out of range`；要按 `pid` 统计，或自己拼 `classid/objid`（注意 `classid << 32` 会溢出 int8）。
2. 被 `pg_terminate_backend` 的连接会向客户端发 `error 57P01`；`pg.Client` 是 EventEmitter，**必须先 `client.on('error', () => {})`**，否则整个测试进程崩掉。

---

## 附录 B · 本轮明确没做的事（防止被读成「已完成」）

| 没做 | 状态 |
|---|---|
| `txProject` / `txProjects` 实现 | **零行代码** |
| `assertProjectLocked` 实现 | **零行代码** |
| 25 处调用点迁移 | **零处迁移** |
| 五个 Stage 3 审计实体登记 | **未登记** |
| `segmentInputHash` / `shot_videos.input_hash` | **未实现** |
| IMP-01~04 四项签名改动 | **未改动** |
| 阶段 A 任何工作项 | **未启动** |
| 55 项正式验收测试 | **0 条执行** |
| D02-36 冻结 | **未冻结** |
| D02-06 §8.2.4 规范修订 | **未改一字** |
