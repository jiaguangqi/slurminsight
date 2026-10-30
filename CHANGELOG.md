# Changelog

本项目的所有重要变更都记录在此文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

主题是**把 Prometheus 数据用起来**：节点级下钻、热度视角与作业资源利用率，都建立在已对接的
VictoriaMetrics/Prometheus 之上，并与 Slurm 自身的分配数据交叉印证。

### 新增

- **节点详情弹窗**（`/api/nodes/:node/detail`）：Heatmap 上任意节点方块点击即弹出，展示 CPU / 内存 / 负载 /
  根目录 / 网络（GPU 节点另有逐卡利用率与显存）的时间曲线、实时指标卡，以及该节点上运行中作业的实际
  CPU / 内存 / GPU 占用。
- **采集覆盖红点**（`/api/nodes/monitoring`）：节点方块下方的小圆点表示 node_exporter / cgroup_exporter /
  DCGM exporter 三路采集中有缺失，红色为未采集、橙色为抓取失败；弹窗内给出具体是哪一路、可能原因与 Slurm 侧状态。
- **Node Heatmap 热度视角**：新增「CPU 热度」「内存热度」「磁盘热度」三个视角，按使用率分档着色，卡片副标题
  显示分组平均值与有数据节点数，无采集数据的节点单独一档。
- **根目录空间使用与曲线**：「磁盘热度」展示各节点 `/` 的占用率（悬停可见剩余空间），节点详情新增
  `根目录空间使用率 (/)` 曲线（`node_filesystem_avail_bytes` / `node_filesystem_size_bytes`）。
- **作业队列「资源利用率」列**（`/api/jobs/usage-summary`）：一次查询返回全部运行作业的申请 vs 实际对比，
  列可按利用率排序（默认低效在前）。CPU 作业看核数利用率，GPU 作业看所占用卡的平均利用率；低于 20% 标红、
  低于 50% 标橙，用来一眼捞出占着资源不干活的作业。

### 说明

- 节点名↔抓取目标映射依赖 `node_uname_info`（缓存 5 分钟）；节点级采集数据缓存 60 秒，作业用量缓存 30 秒。

## [2.0.0] - 2026-10-21

这一版的核心是**数据准确性**与**运维可见性**：排队/占用数字与 Grafana 对齐，新增服务健康页与按 GPU 卡的分配视图，
同时补齐了鉴权、命令执行、历史留存方面的安全与稳定性缺口。

### 新增

- **Service Health 页面**（`/api/services/status`、`/api/services/logs`）：面向双控 HA 架构的巡检视图。
  - 主控/备控（slurmctld、slurmdbd、munge）的 systemd 状态、`scontrol ping` 结果、控制器日志大小与更新时间。
  - `sdiag --json` 调度器指标与 `sacctmgr show cluster/stats` 数据库汇总。
  - 控制器/slurmdbd 日志分析：按级别分级、错误归类、1H/6H/24H/72H 时间窗、统计区间起止时间。
  - slurmdbd 异常只在日志时间戳距今 10 分钟内才判定，避免历史报错造成误报。
  - 主机名走固定白名单（`SERVICE_HOSTS`），不接受请求参数，杜绝经由该接口的命令注入。
- **队列节点弹窗**：每个队列卡片右上角新增节点按钮，列出该分区全部节点及其状态、CPU/内存/GPU 分配。
- **GPU 卡粒度的分配视图**：GPU 分区下以一个小方块表示一张物理卡，标注卡号，区分空闲/已分配，
  鼠标悬停与点击可看到该卡上运行的作业（作业号、作业名、用户）。数据来自 `scontrol show node -o` 的
  `CfgTRES`/`AllocTRES` 与 `squeue --json` 的 `gres_detail` 索引区间。
- **等待队列优先级列**：分区等待作业列表新增 Priority 列，表头可点击在「队列顺序 → 高→低 → 低→高」之间切换。
- 作业详情中的资源使用面板（`/api/jobs/:jobId/usage`），从 VictoriaMetrics 读取 cgroup/DCGM 实际用量。

### 修复

- **GPU 数量统计为 0**：`squeue --json` 在近两千作业时约 18–20 MB，超过原先 10 MB 的 `maxBuffer`，
  导致回退到格式化输出，而回退路径只能从 `%b`（TRES_PER_NODE）推断 GPU 数，对 `--gpus-per-task` 提交的作业恒为 0。
  `maxBuffer` 提升到 64 MB，并补上 `tres_per_task × ntasks` 的换算。
- **`squeue --json` 字段解析**：按 Slurm 23.11 的 schema 读取 `{set,infinite,number}` 形式的数值与数组形式的状态字段，
  不再假设为纯整数。
- **历史查询时区/时间窗错位**：`/api/history/partitions` 改为按请求的时间窗在服务端聚合，前端切换 1H/6H/24H/7D 时
  才真正对应各自区间。
- **空列表写库报错**：采集到 0 条作业时跳过 `INSERT`，避免生成非法 SQL 刷日志。
- **日志刷屏**：`squeue --json` 失败回退只记录一次告警；作业历史写入失败不再每个采集周期打印堆栈。
- 作业详情弹窗：脚本框随弹窗高度自适应，去掉底部重复的关闭栏。

### 安全

- `data/auth.json` 落盘权限收紧为 `600`，目录 `700`。
- 管理员初始口令不再硬编码：取 `ADMIN_PASSWORD`，未设置时随机生成并在首次启动日志中提示。
- LDAP 绑定口令与 PostgreSQL 连接串使用 AES-256-GCM 加密落盘（`enc:v1:` 前缀），密钥来自
  `AUTH_ENCRYPTION_KEY` 或自动生成的 `data/.secret.key`。
- 登录接口按 IP+用户名限流，5 分钟内 10 次失败后返回 429。
- 所有 Slurm 命令改为绝对路径（`/usr/bin/squeue` 等），并对传入参数做白名单/转义校验。
- 前端不再在接口失败时回退到 mock 假数据，改为展示错误态；收到 401 自动登出，避免"看起来有数据"。

### 变更

- Tailwind 在构建期编译进 `dist/assets/*.css`，移除对公网 CDN 的依赖，可在完全离线的内网运行。
- `/api/partitions` 增加 5 秒作业缓存与并发去重，冷启动约 4 s 降至约 2 s，热请求 80–300 ms。
- 历史数据默认保留 365 天，每天执行一次过期清理；采集间隔与保留期可在配置页调整。
- 部署文档（`DEPLOY.md`）补充 systemd、logrotate、加密密钥与 Service Health 前置条件。

## [1.3.0] - 2026-03-06

### 新增

- 首个公开版本：Dashboard 分区资源卡片、节点热力图、作业队列、历史趋势、配置页。
- Express 后端直接调用 `sinfo`/`squeue`，提供 `/api/partitions`、`/api/jobs` 等接口。
- PostgreSQL 历史持久化，支持 LDAP 登录与按用户/分区的权限控制。

[2.0.0]: https://github.com/jiaguangqi/slurminsight/compare/v1.3.0...v2.0.0
[1.3.0]: https://github.com/jiaguangqi/slurminsight/releases/tag/v1.3.0
