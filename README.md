# SlurmClusterInsight

面向 Slurm 集群的前后端一体可视化与巡检面板。后端（Express）直接调用 `sinfo`、`squeue`、`scontrol`、`sacct`
读取集群真实状态，并从 Prometheus / VictoriaMetrics 读取节点与作业的**实际用量**，
前端用 React + Tailwind 渲染，历史数据可选落 PostgreSQL。

## 功能

| 页面 | 内容 |
| --- | --- |
| Dashboard | CPU/GPU 分区资源卡片、整体利用率、待排队作业数；点卡片右上角可查看该分区的节点与每张 GPU 卡的分配情况；等待作业弹窗含优先级列 |
| Node Heatmap | 全节点状态与资源热力图；另有 CPU 热度 / 内存热度 / 磁盘热度三个视角（可按节点名或用量排序），方块下方红点标记采集缺失，点击任意节点弹出详情 |
| 节点详情 | CPU / 内存 / 负载 / 根目录 / 网络的时间曲线，GPU 节点含逐卡利用率与显存，以及该节点上运行中作业的实际 CPU / 内存 / GPU 占用 |
| Job Queue | 作业列表、按状态/分区筛选、按优先级排序、作业详情与脚本、运行期资源使用；含「资源利用率」列（申请 vs 实际，可排序） |
| History Trends | 分区与作业历史趋势，按 1H/6H/24H/7D 时间窗由服务端聚合 |
| Service Health | 双控 HA 状态（slurmctld / slurmdbd / munge）、`sdiag` 调度指标、数据库汇总、控制器日志分级与错误归类 |
| Configuration | 管理员配置 LDAP、数据库、采集间隔与保留期、用户与分区权限 |

## 数据源：Prometheus / VictoriaMetrics

Slurm 命令只能回答「分配了多少」，要回答「实际用了多少」则需要指标系统。项目通过 `VM_URL` 对接
Prometheus 兼容端点（实测为 VictoriaMetrics），当前使用以下几类 exporter：

| exporter | Prometheus job | 端口 | 用途 |
| --- | --- | --- | --- |
| node_exporter | `node-export` | 9100 | 节点 CPU / 内存 / 负载 / 网络 / 根目录空间；`node_uname_info` 用于建立节点名与 IP 的映射 |
| cgroup_exporter | `cgroup_exporter` | 1999 | 按作业（`jobId`）的 CPU 与内存实际用量 |
| DCGM exporter | `gpu_exporter` | 9400 | 每张 GPU 卡的利用率、显存、温度、功耗 |
| 节点侧 GPU 作业映射 | `node-export` | 9100 | `node_cr_gpu_jobinfo` / `node_cr_job_gpu_memory`，作为 Slurm `gres_detail` 的补充 |

`up{job=...}` 用于判定采集覆盖（未采集 / 抓取失败），也就是热力图上红点与节点详情里采集异常提示的来源。
未部署 Prometheus 时面板仍可正常使用，只是用量相关字段为空。


## 快速开始

```bash
npm install
npm run build        # 构建前端到 dist/，Tailwind 在构建期编译进本地 CSS
npm start            # 启动 Express（静态资源 + API），默认 0.0.0.0:4173
```

生产环境建议用 systemd 托管，参见 [DEPLOY.md](DEPLOY.md)。

### 前提

- Node.js 18+（生产使用 Node 22）
- 运行账户可执行 `/usr/bin/sinfo`、`/usr/bin/squeue`、`/usr/bin/scontrol`、`/usr/bin/sacct`
- 可选：PostgreSQL（历史持久化）、Prometheus / VictoriaMetrics（节点与作业的实际用量，见上文"数据源"）
- Service Health 页需要服务以 root 运行，且本机到主控/备控节点已配置 root 免密 SSH

## 配置

通过环境变量设置：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` | 监听端口 | `4173` |
| `HOST` | 监听地址 | `0.0.0.0` |
| `ADMIN_PASSWORD` | 首次生成 `data/auth.json` 时的 admin 初始口令 | 随机生成并打印到日志 |
| `AUTH_ENCRYPTION_KEY` | 加密落盘密钥（口令或 64 位十六进制） | 自动生成 `data/.secret.key` |
| `VM_URL` | Prometheus / VictoriaMetrics 地址 | `http://172.22.2.150:8428` |
| `VITE_API_BASE` | 前端 API 前缀 | `/api` |

> `data/.secret.key` 丢失后，已加密的 LDAP 绑定口令与数据库连接串需要重新填写。

## 安全说明

- `data/auth.json` 与 `data/.secret.key` 必须保持 `600`，`data/` 为 `700`；这两个文件已在 `.gitignore` 中排除。
- LDAP 绑定口令与数据库连接串以 AES-256-GCM 加密落盘，不回显给管理界面。
- 登录接口按 IP+用户名限流；所有 Slurm 命令使用绝对路径并校验参数。

## 文档

- [DEPLOY.md](DEPLOY.md)：部署、systemd、logrotate、Service Health 前置条件
- [CHANGELOG.md](CHANGELOG.md)：版本变更记录（当前 v2.1.0）
