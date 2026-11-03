# Changelog

本项目的所有重要变更都记录在此文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [2.2.0] - 2026-11-03

这一版集中在**作业详情页**：把右栏「作业监控」从终端风格改成与弹窗统一的浅色，
大幅加宽弹窗，把性能面板补齐到 CPU / 内存 / 以太网 / IB / GPU / 显存六个维度，
让「作业实际用了多少」在一屏内看全。

### 新增

- **作业详情的性能面板扩展**：弹窗宽度从 `max-w-6xl`（1152px）扩到 96rem，右侧「作业监控」栏 520px → 720/820px，
  指标区改为 6 个卡片，覆盖
  - CPU 利用率（实际 ÷ 申请核数）与内存利用率（实际 ÷ 申请内存），曲线纵轴直接读成百分比，虚线为 100% 申请基准；
  - 以太网网络 IO、IB 网络 IO（下行 / 上行双线）；
  - GPU 利用率、GPU 显存利用率（仅申请了 GPU 的作业显示）。
- **网络与显存利用率数据**（`/api/jobs/:jobId/usage` 扩展）：
  - 新增 `series.ethRx/ethTx/ibRx/ibTx` 与 `network` 元信息。cgroup exporter **不提供**作业级网络计数，
    因此取作业所在节点的 `node_network_*_bytes_total`：以太网按 `device=~"en.*|eth.*"`、
    IB 按 `device=~"ib.*"`（集群里 IB 口既有 `ib0` 也有 `ibp25s0`/`ibs5` 这类 RDMA 命名），多节点作业求和。
    面板上明确标注为「节点级」。
  - 新增 `gpuMemoryPctSeries`：显存利用率 = `FB_USED / (FB_USED + FB_FREE)`（DCGM 没有 FB_TOTAL 指标，
    用两者相加还原单卡总量），并在 GPU 卡片里给出已用 / 总共。

### 变更

- **作业详情弹窗的「作业监控」改为浅色**：右栏（标题栏、资源使用图表、`.out` / `.err` 日志）此前是终端风格的深色，
  与左侧详情形成割裂，现全部改为与弹窗一致的浅色底（白卡片 + `slate-50` 底 + 深色文字）。
  曲线与面积图配色相应各暗一档（如 CPU `#38bdf8` → `#0ea5e9`、显存 `#a78bfa` → `#8b5cf6`），
  保证白底上的对比度；坐标轴刻度、网格线、tooltip 一并换成浅色主题。

### 修复

- **浅色主题下文字与线条过淡**：`slate-400` 在白底上的对比度只有约 2.5:1（低于 WCAG AA 的 4.5:1），
  9–11px 的小字尤其看不清。统一按层级加深：次要文字 `slate-400` → `slate-500`（约 4.8:1），
  9–10px 的 uppercase 小标题 → `slate-600`，图表坐标轴刻度由 `#94a3b8` → `#475569`，
  网格线由 `slate-100` → `slate-200`。
  涉及作业详情、节点详情、节点热力图、历史趋势、服务健康、Dashboard 等浅色页面；
  深色区域（侧边栏、登录页、热力图悬停卡片）保持原样。

## [2.1.0] - 2026-10-30

这一版的核心是**对接 Prometheus 作为第二数据源**。在此之前，面板只能看到 Slurm 自己知道的"分配了多少"；
接入 Prometheus 之后，才能看到节点上"实际用了多少"，于是有了节点级下钻、CPU/内存/磁盘热度视角，
以及用「申请 vs 实际」直接暴露低效作业的利用率列。

### 一、数据源：对接 VictoriaMetrics / Prometheus

地址由环境变量 `VM_URL` 指定（默认 `http://172.22.2.150:8428`），直接调用其 Prometheus 兼容 HTTP API
（`/api/v1/query`、`/api/v1/query_range`），8 秒超时；任何一个 exporter 不可用时只让对应字段为空，
不影响 Slurm 侧数据展示。

#### 对接的 exporter

| exporter | Prometheus job | 端口 | 抓取目标 | 用到的指标 |
| --- | --- | --- | --- | --- |
| node_exporter | `node-export` | 9100 | 303（含登录/管理节点） | `node_cpu_seconds_total`、`node_memory_MemAvailable_bytes` / `node_memory_MemTotal_bytes`、`node_load1`、`node_network_receive_bytes_total` / `node_network_transmit_bytes_total`、`node_filesystem_avail_bytes` / `node_filesystem_size_bytes`、`node_uname_info` |
| cgroup_exporter | `cgroup_exporter` | 1999 | 299 | `cgroup_cpu_usage_percpu`、`cgroup_cpu_total_seconds`、`cgroup_memory_used_bytes`（带 `jobId` 标签，可落到单个作业） |
| DCGM exporter | `gpu_exporter` | 9400 | 30 节点 / 209 张卡 | `DCGM_FI_DEV_GPU_UTIL`、`FB_USED`、`FB_FREE`、`GPU_TEMP`、`POWER_USAGE` |
| 节点侧 GPU 作业映射 | `node-export` | 9100 | 同上 | `node_cr_gpu_jobinfo`、`node_cr_job_gpu_memory`（节点上自建导出器，用于把作业号对到卡号） |

集群实测分布：H100 80GB HBM3 × 96、H200 × 16、Tesla V100-SXM2-32GB × 88、Tesla V100-PCIE-32GB × 9。

#### 对接中处理的几个实际问题

- **节点名 ↔ 抓取目标的映射**：Prometheus 上只有 `node_uname_info` 同时带 `nodename` 和 `instance`，
  其余节点指标只有 IP（`instance`）。因此用 `node_uname_info` 建立 node → IP 映射并缓存 5 分钟，
  再用 IP 去匹配其他指标；这样既支持多 IP 节点，也不依赖抓取配置里的标签约定。
- **采集覆盖判定**：用 `up{job="node-export"}`、`up{job="cgroup_exporter"}`、`up{job="gpu_exporter"}`
  判断三路采集，取值为 `ok` / `down`（目标存在但抓取失败）/ `missing`（Prometheus 里没有该节点目标）/ `n/a`。
  这就是热力图上红点（未采集）与橙点（抓取失败）的来源。
- **cgroup 指标口径不统一**：部分节点只暴露 `cgroup_cpu_total_seconds`（单位秒，速率即核数），
  另一些是 `cgroup_cpu_usage_percpu`（纳秒，需除以 1e9）。服务端先试后者，为空时自动回退前者，
  避免这些节点上作业 CPU 显示为空。
- **核数聚合方式**：`avg(rate(node_cpu_seconds_total{mode!="idle"}))` 得到的是单核比例（如 0.14）而不是
  核数，必须用 `sum(...)` 才是"实际使用了多少核"。
- **GPU 作业与卡号的对应**：以 Slurm 的 `gres_detail` 索引区间为准，exporter 的 `node_cr_gpu_jobinfo`
  仅作补充——部分节点上该指标没有 `job_id`，单靠它会把作业和卡对错。
- **统计窗口**：队列利用率列用 CPU 10 分钟、GPU 15 分钟的平均值（避免瞬时抖动把正常作业误判为低效），
  节点详情曲线支持 1H/6H/24H，步长 `max(60, range/120)`。

### 二、新增功能

- **节点详情弹窗**（`/api/nodes/:node/detail`）：Heatmap 上任意节点方块点击即弹出，展示 CPU 使用率 /
  CPU 实际核数 / 内存使用率与使用量 / Load1 / 根目录占用 / 网络收发的时间曲线，GPU 节点另有逐卡利用率与
  显存曲线，以及该节点上运行中作业的实际 CPU / 内存 / GPU 占用。
- **采集覆盖红点**（`/api/nodes/monitoring`）：节点方块下方的小圆点表示三路采集中有缺失，红色为未采集、
  橙色为抓取失败；点开弹窗会说明具体是哪一路、可能原因（未部署 / 未启动 / 主机不可达）与 Slurm 侧状态。
- **Node Heatmap 热度视角**：新增「CPU 热度」「内存热度」「磁盘热度」三个视角，按使用率分档着色，
  卡片副标题显示分组平均值与有数据节点数，无采集数据的节点单独一档。热度视角下可按
  「节点名 / 多 → 少 / 少 → 多」排序，无采集数据的节点在两个方向上都排在末尾，异常节点分组固定置顶。
- **根目录空间使用与曲线**：「磁盘热度」展示各节点 `/` 的占用率（悬停可见剩余空间与总量），
  节点详情新增 `根目录空间使用率 (/)` 曲线。
- **作业队列「资源利用率」列**（`/api/jobs/usage-summary`）：一次查询返回全部运行作业的「申请 vs 实际」
  对比，列可按利用率排序（默认低效在前）。CPU 作业看核数利用率，GPU 作业看所占用卡的平均利用率；
  低于 20% 标红、低于 50% 标橙，用来一眼捞出占着资源不干活的作业。

### 说明

- 节点级采集数据缓存 60 秒，作业用量汇总缓存 30 秒，`node_uname_info` 的 node→IP 映射缓存 5 分钟。
- 采集覆盖是"按 Prometheus 有没有数据"判定的，因此既能发现采集器没装 / 没起，也能发现主机本身不可达。

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
