# 容器构建与镜像发布

## 当前范围

本次只补齐镜像构建、健康检查和 GHCR 发布。`cd.yml` 已替换旧部署逻辑：发布镜像后不会 SSH、SCP、重载 PM2 或切换线上入口。现有服务器服务继续运行。
尚未包含生产 Compose、服务器部署脚本、自动回滚或数据搬迁，先不要删除旧服务和目录。

## 本地构建

在当前仓库根目录执行：

```bash
docker build -t fund-backend:local .
```

构建上下文排除了环境文件、密钥、本地依赖和运行数据。健康检查使用镜像内置工具，不依赖额外 curl。

## 发布到 GHCR

1. 先提交并推送本仓库改动。工作流需要存在于远程仓库中；手动入口通常需先合入默认分支。
2. 在 Actions 手动运行 Publish container image，或推送尚未使用的 `v*.*.*` tag。
3. 工作流测试通过后，使用自动提供的 GITHUB_TOKEN 推送 `ghcr.io/<小写owner>/<小写repo>`。
4. tag 发布生成对应版本标签，所有发布生成 `sha-<完整commit>` 标签；不生成 latest。
5. Actions 摘要记录镜像 digest，后续 Compose 使用完整 `image@sha256:...` 固定版本。
6. 私有镜像在服务器使用具有 read:packages 权限的 classic Token 登录 GHCR，然后拉取摘要中的镜像。

默认发布 `linux/amd64`，上线前用 `uname -m` 核对服务器架构；ARM 服务器必须先调整工作流平台设置。
首次推送默认私有；仓库/组织策略须允许工作流写入 Packages。未提交、未推送前不会产生镜像。

## 服务注意事项

- Node 22 直接运行 `node app.js`；镜像不运行 PM2。
- 生产运行所需依赖已移到 dependencies，镜像执行 `npm ci --omit=dev`。
- 支持通过 `--env-file`/Compose `env_file` 注入配置，不要求磁盘存在 `.env.production`；原本地 `.env.dev` 加载方式保留。
- 必需变量：`DB_HOST`、`DB_USER`、`DB_PASS`、`DB_PORT`、`DB_Name`。其他 AI、Redis、Qdrant 配置继续沿用现有代码中的名称。数据库名大小写必须保持 `DB_Name`。
- 同一 Compose 网络中配置 `RAG_INGEST_URL=http://rag:9001/ingest`、`RAG_RETRIEVE_URL=http://rag:9001/retrieve`。
- MySQL、Redis、Qdrant 地址必须从容器可达，不能直接沿用宿主机的 `127.0.0.1`。
- 挂载业务数据到 `/app/public/uploads` 和 `/app/uploads`。删除旧部署前，先把数据迁到独立宿主机目录；挂载目录须允许镜像内 node 用户（UID 1000）写入。只调整选定数据目录的权限，不修改数据库目录权限。
- `/healthz` 仅表示 HTTP 进程存活，不检查数据库、基金目录加载状态或 RAG。正式部署要另做依赖和业务验证。
- 后端启动会恢复中断的入库任务、检查和初始化 Qdrant 集合，隔离测试不要直接连生产库。
- 镜像不包含上传数据、环境文件；原 PM2 的 `prod` 脚本暂时保留用于迁移期回退。

## 上线验收

先备份并验证业务数据和配置，再准备 Compose 网络、环境变量及持久化挂载。
镜像的 HEALTHCHECK 只是存活检查；依赖连接和完整业务流程通过后才能切换入口。
应用更新期间保留 MySQL、Redis、Qdrant 原部署及数据卷。
生产环境的普通 Compose 重建不是零停机发布；保留旧镜像、配置和可恢复的数据备份。
