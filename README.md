# SlurmClusterInsight

面向 Slurm 集群的前后端一体可视化与巡检面板。后端（Express）直接调用 `sinfo`、`squeue`、`scontrol`、`sacct`
读取集群真实状态，前端用 React + Tailwind 渲染，历史数据可选落 PostgreSQL。

## 功能

| 页面 | 内容 |
| --- | --- |
| Dashboard | CPU/GPU 分区资源卡片、整体利用率、待排队作业数；点卡片右上角可查看该分区的节点与每张 GPU 卡的分配情况 |
| Node Heatmap | 全节点状态与资源热力图 |
| Job Queue | 作业列表、按状态/分区筛选、按优先级排序、作业详情与脚本、运行期资源使用（可从 VictoriaMetrics 读取） |
| History Trends | 分区与作业历史趋势，按 1H/6H/24H/7D 时间窗由服务端聚合 |
| Service Health | 双控 HA 状态（slurmctld / slurmdbd / munge）、`sdiag` 调度指标、数据库汇总、控制器日志分级与错误归类 |
| Configuration | 管理员配置 LDAP、数据库、采集间隔与保留期、用户与分区权限 |

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
- 可选：PostgreSQL（历史持久化）、VictoriaMetrics（作业实际资源用量）
- Service Health 页需要服务以 root 运行，且本机到主控/备控节点已配置 root 免密 SSH

## 配置

通过环境变量设置：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` | 监听端口 | `4173` |
| `HOST` | 监听地址 | `0.0.0.0` |
| `ADMIN_PASSWORD` | 首次生成 `data/auth.json` 时的 admin 初始口令 | 随机生成并打印到日志 |
| `AUTH_ENCRYPTION_KEY` | 加密落盘密钥（口令或 64 位十六进制） | 自动生成 `data/.secret.key` |
| `VM_URL` | VictoriaMetrics 地址 | 代码内默认值，按环境覆盖 |
| `VITE_API_BASE` | 前端 API 前缀 | `/api` |

> `data/.secret.key` 丢失后，已加密的 LDAP 绑定口令与数据库连接串需要重新填写。

## 安全说明

- `data/auth.json` 与 `data/.secret.key` 必须保持 `600`，`data/` 为 `700`；这两个文件已在 `.gitignore` 中排除。
- LDAP 绑定口令与数据库连接串以 AES-256-GCM 加密落盘，不回显给管理界面。
- 登录接口按 IP+用户名限流；所有 Slurm 命令使用绝对路径并校验参数。

## 文档

- [DEPLOY.md](DEPLOY.md)：部署、systemd、logrotate、Service Health 前置条件
- [CHANGELOG.md](CHANGELOG.md)：版本变更记录（当前 v2.0.0）
