# SlurmClusterInsight

前后端一体的 Slurm 集群可视化与监控面板。后端（Express）直接调用 `sinfo`、`squeue` 获取实时数据并提供 `/api/partitions`、`/api/jobs`，前端每 5 分钟轮询更新。

## 快速部署
```bash
bash deploy.sh
```
- 需要 Node.js 18+，并保证运行账户可执行 `sinfo`、`squeue`。
- 默认监听 `0.0.0.0:4173`，可用 `PORT` 环境变量覆盖。
- 构建产物在 `dist/`，Express 同时托管静态文件和 API。

## 开发模式
```bash
npm install
npm run dev   # Vite 前端开发模式，需自行启动后端或设置 VITE_USE_MOCK=true
```

## 配置
- `PORT`：后端监听端口（默认 4173）。
- `HOST`：监听地址（默认 0.0.0.0）。
- `VITE_API_BASE`：前端请求 API 前缀（默认 `/api`）。
- `VITE_USE_MOCK`：设为 `true` 时前端使用内置 mock 数据，不调用后端（默认 `false`）。

更多部署细节见 `DEPLOY.md`。
