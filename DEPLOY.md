## 部署说明（前后端一体，真实 Slurm 数据）

后端 `server/index.js` 直接调用集群上的 `sinfo`、`squeue`，将结果以 JSON 提供给前端。前端通过 `/api/partitions`、`/api/jobs` 获取实时数据，每 5 分钟轮询；历史曲线按所选时间窗向 `/api/history/partitions` 请求服务端聚合后的数据。

### 依赖
- Node.js 18+（当前生产使用 `/usr/local/node/bin/node` v22）
- 运行账户可执行 `sinfo`、`squeue`、`sacct`、`scontrol`
- 可选：PostgreSQL（用于历史持久化，连接串在管理页配置）

### 构建
前端样式由 Tailwind 在构建期编译进 `dist/assets/*.css`，**不依赖任何公网 CDN**，可在完全离线的内网使用。

```bash
npm install
npm run build
```

### 生产托管（systemd）
服务已注册为 `slurmclusterinsight.service`：

```bash
systemctl status slurmclusterinsight
systemctl restart slurmclusterinsight
journalctl -u slurmclusterinsight -n 100     # 或 tail -f logs/app.log
```

日志写入 `logs/app.log`，由 `/etc/logrotate.d/slurmclusterinsight` 每周轮转、保留 4 份。

### 配置与环境变量
- `PORT`：监听端口，默认 4173。
- `HOST`：监听地址，默认 0.0.0.0。
- `VM_URL`：VictoriaMetrics 地址，默认 `http://172.22.2.150:8428`（10.128.202.102 的内网地址），用于读取作业真实资源使用。
- `ADMIN_PASSWORD`：仅在 `data/auth.json` 首次生成时作为 admin 初始口令；之后请在界面修改。
- `VITE_API_BASE` / `VITE_USE_MOCK`：前端构建期变量，默认 `/api` 与 `false`。`VITE_USE_MOCK=true` 仅用于离线演示，生产构建显示的是真实数据。

### 数据与安全
- `data/auth.json` 保存 admin 口令哈希与 LDAP 绑定口令，权限必须为 `600`，所在目录 `700`。
- LDAP 绑定口令与 PostgreSQL 连接串使用 AES-256-GCM 加密落盘（文件中以 `enc:v1:` 开头），内存中才解密使用。
- 加密密钥来源：环境变量 `AUTH_ENCRYPTION_KEY`（任意口令，内部 SHA-256 派生；或 64 位十六进制密钥）；未设置时自动生成 `data/.secret.key`（`600`，仅 root 可读）。**该文件丢失后需重新填写 LDAP 与数据库口令。**
- 管理页不会回显已保存的口令：口令框留空保存表示沿用原值；同时修改 URL 或 Bind DN 时留空会清空旧口令，需重新填写。
- 登录接口对同一 IP+用户名在 5 分钟内最多尝试 10 次，超出返回 429。
- 作业资源接口 `/api/jobs/:jobId/usage` 从 VictoriaMetrics 读取 cgroup/DCGM 指标，返回 CPU 实际核数、内存占用、GPU 利用率与时间序列；权限同日志接口。cgroup 指标仅在作业运行期间存在，作业结束后的历史数据仍可回查。
- 作业日志接口 `/api/jobs/:jobId/log` 从 `scontrol show job` 的 `StdOut`/`StdErr` 路径读取，只返回文件尾部 96 KB；普通用户只能读取自己作业的日志，且服务会校验文件属主与作业属主一致（服务以 root 运行，避免越权读取他人文件）。日志文件需位于登录节点可见的文件系统中。
- `data/db.json` 中的历史采集间隔默认 300 秒，保留期默认 365 天；服务每天执行一次过期数据清理。
- 历史表体积：`job_history` 每 5 分钟最多 500 行。保留期越长磁盘占用越大，调整前请先确认 `pg_total_relation_size`。

### 服务健康页（/api/services/*）
- `/api/services/status`：聚合 `scontrol ping`、`sdiag --json`、`sacctmgr show cluster/stats`、`scontrol show config`，并通过 SSH 读取 mgt03/mgt02 上的 `systemctl is-active` 与 slurmdbd 日志尾部。结果缓存 15 秒，仅 admin 可访问。
- `/api/services/logs?hours=1|6|24|72&source=ctld|dbd`：按时间窗读取控制器日志并做分级统计、错误归类、配置不一致节点统计。单次最多取 8 万行，结果缓存 20 秒。
- **前置条件**：服务以 root 运行，且 login02 到 mgt03/mgt02 已配置 root 免密 SSH（当前已验证）。主机名在代码 `SERVICE_HOSTS` 白名单中固定，不接受请求参数指定，避免命令注入。
- 若更换主控机名，需同步修改 `SERVICE_HOSTS`、`SERVICE_UNITS`。

### 节点详情与采集覆盖（/api/nodes/*）
- `/api/nodes/monitoring`：按节点返回采集器状态与实时利用率，用于热力图的红点标记和 CPU/内存热度视角。状态取值 `ok` / `down`（抓取目标存在但失败）/ `missing`（Prometheus 中没有该节点目标）/ `n/a`（非 GPU 节点不判 GPU 采集）；`cpuPct` / `memPct` 为该节点当前的 CPU、内存使用率（由 node_exporter 计算，节点无数据时为 `null`）。结果缓存 60 秒，`node_uname_info` 的 node→IP 映射缓存 5 分钟。
- `/api/nodes/:node/detail?range=300..604800`：单节点详情，包含
  - 时间序列：CPU 使用率、CPU 实际核数、内存使用率/使用量、Load1、网络收发（node_exporter，按 `instance` 选择，node 名→IP 由 `node_uname_info` 解析）；
  - GPU：每张卡的利用率、显存占用/总量、温度、功耗（`DCGM_FI_DEV_*{hostname=...}`），以及每卡历史曲线；
  - 运行中的作业：Slurm 作业列表 + 每作业实际 CPU 核数、内存（cgroup exporter）、占用卡号（以 Slurm 的 `gres_detail` 为准，exporter 的 `node_cr_gpu_jobinfo` 仅作补充）、单作业 GPU 利用率。
- **cgroup 指标差异**：部分节点只暴露 `cgroup_cpu_total_seconds`（单位秒，速率即核数），另一些节点是 `cgroup_cpu_usage_percpu`（纳秒，需除以 1e9）。服务端会先试后者，为空时回退前者。作业资源查询 `/api/jobs/:jobId/usage` 采用同样的回退逻辑。
- 采集覆盖是"按 Prometheus 有没有数据"判定的，因此既能发现采集器没装/没起，也能发现主机本身不可达（此时节点在 Slurm 里通常已是 `down`/`drain`）。
