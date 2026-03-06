## 一键部署说明（前后端一体，真实 Slurm 数据）

后端 `server/index.js` 会直接调用集群上的 `sinfo`、`squeue`，并将结果以 JSON 提供给前端。前端通过 `/api/partitions`、`/api/jobs` 获取实时数据，默认每 5 分钟轮询。

### 快速部署（登录节点/内网）
1. 确认 Node.js 18+，并在运行账户下可执行 `sinfo`、`squeue`。
2. 在项目根目录执行：
   ```bash
   bash deploy.sh
   ```
   - 自动安装依赖、构建前端并启动 Express 服务器（静态资源 + API）。
   - 默认监听 `0.0.0.0:4173`，可通过环境变量 `PORT` 覆盖。

### 生产托管建议
- 构建产物位于 `dist/`，Express 已内置静态资源服务，也可将 `server/index.js` 以 systemd/pm2 方式常驻：
  ```bash
  PORT=8080 node server/index.js
  ```
- 若需前置 Nginx，可反代到后端的 `/api` 与静态资源；如需鉴权，可在 Nginx 层做基于源 IP/Basic Auth 的限制。

### 配置与环境变量
- `PORT`：后端监听端口，默认 4173。
- `HOST`：监听地址，默认 `0.0.0.0`。
- `VITE_API_BASE`：前端 API 前缀，默认 `/api`；如有反代路径可覆盖。
- `VITE_USE_MOCK`：设为 `true` 时前端使用内置 mock，不请求后端（默认 `false`）。

### 其他注意事项
- 依赖未锁定（无 package-lock/pnpm-lock/yarn.lock），建议在生产环境生成锁文件以固定版本。
- 默认 Tailwind 从公网 CDN 注入；若环境无法访问公网，请改为本地构建或内部 CDN。
