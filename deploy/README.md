# 服务器自动部署

适用于本项目已经完成迁移的 Linux 服务器。三个仓库分别发布镜像，共用这一个部署脚本；不需要把三个应用合成一个仓库。

## 现有服务器布局

- `/opt/fund/compose.frontend.yml`，项目 `fund-frontend`，服务 `frontend`，本机端口 18080。
- `/opt/fund/compose.backend.yml`，项目 `fund-backend`，服务 `backend`，端口 9000。
- `/opt/fund/compose.rag.yml`，项目 `fund-rag`，服务 `rag`，端口 9001。
- 环境文件：`/opt/fund/env/backend.env`、`/opt/fund/env/rag.env`。
- 上传挂载：`/opt/fund/data/backend/public-uploads`、`/opt/fund/data/backend/uploads`。
- 前端 Nginx 挂载：`/opt/fund/nginx/frontend.conf`。
- 公网入口仍由宿主机 Nginx 负责，不由部署脚本修改。

三个服务保持现有 `network_mode: host`，MySQL、Redis、Qdrant 和业务数据目录不搬迁。不要再把容器里的 localhost 替换成 Docker 服务名。
Compose 文件中的环境文件和挂载路径应使用绝对路径，每份文件只有一个对应服务，image 使用完整 digest。

## 1. 安装部署脚本（先不开自动部署）

脚本只依赖服务器 Python 3 标准库、Docker 和 Compose，需使用能运行 Docker、读取生产配置的同一用户。当前部署使用 root，GHCR 拉取凭证也在 root 下。

在 Mac 项目总目录执行（需本机已有可用的服务器 SSH 登录方式）：

```bash
ssh root@112.126.27.148 'mkdir -p /opt/fund/scripts'
scp fund-backend/deploy/deploy.py root@112.126.27.148:/opt/fund/scripts/deploy.py.new
```

在服务器执行：

```bash
python3 -m py_compile /opt/fund/scripts/deploy.py.new
install -m 700 /opt/fund/scripts/deploy.py.new /opt/fund/scripts/deploy.py
python3 /opt/fund/scripts/deploy.py --help
```

如果只通过网页终端登录，可用 SFTP 上传同一个文件到上述位置，再执行服务器命令。不要把环境文件或 SSH 私钥上传到代码仓库。

## 1b. 配置自动部署专用 SSH 密钥

Mac 使用 `ssh-keygen -t ed25519 -f ~/.ssh/fund_deploy -C fund-github-actions` 生成新密钥，建议设置口令，不覆盖已有密钥。
保持原来的管理员登录窗口和授权不变；以下上传使用原管理员登录方式，不是尚未授权的新密钥。

Mac 项目总目录：

```bash
scp fund-backend/deploy/deploy-ssh.py root@112.126.27.148:/opt/fund/scripts/deploy-ssh.py.new
```

服务器：

```bash
python3 -m py_compile /opt/fund/scripts/deploy-ssh.py.new
install -m 700 /opt/fund/scripts/deploy-ssh.py.new /opt/fund/scripts/deploy-ssh.py
```

Mac 执行一次以下命令，备份 authorized_keys 后追加**带限制**的新公钥；不覆盖或删除原授权：

```bash
{
  printf '\n%s ' 'restrict,command="/usr/bin/python3 -I /opt/fund/scripts/deploy-ssh.py"'
  cat ~/.ssh/fund_deploy.pub
} | ssh root@112.126.27.148 'set -eu
mkdir -p /root/.ssh
if [ -f /root/.ssh/authorized_keys ]; then
  cp -p /root/.ssh/authorized_keys "/root/.ssh/authorized_keys.before-fund-deploy-$(date +%Y%m%d-%H%M%S)"
fi
cat >> /root/.ssh/authorized_keys
chmod 700 /root/.ssh
chmod 600 /root/.ssh/authorized_keys'
```

`restrict` 禁止 PTY、端口转发、代理转发等；强制入口仅接受 `fund-deploy <service> <固定仓库完整digest>`，不用 eval 或 shell 执行客户端命令。
不要通过 ssh-copy-id 或裸公钥追加方式另行授权同一把新密钥，否则可能产生不受限制的第二条授权。

先验证禁止任意命令（Mac）：

```bash
ssh -F /dev/null -i ~/.ssh/fund_deploy -o IdentitiesOnly=yes -o PreferredAuthentications=publickey root@112.126.27.148 whoami
```

预期显示 `Deployment key: Only fund-deploy ... is allowed` 并返回非零状态，这是验证成功；不是 root 用户名，也不应该出现交互 shell。
然后用同样的 SSH 选项执行 `fund-deploy rag <当前完整镜像>`，预期检查通过、不重启容器。
`-F /dev/null` 避免测试时误用 SSH config 中配置的其他私钥；非默认 SSH 端口需显式增加 `-p`。

通过后，在 Mac 执行 `pbcopy < ~/.ssh/fund_deploy`，把剪贴板内容粘贴到 GitHub 的 SERVER_SSH_KEY；不是 .pub，也不是文件名。
把密钥口令存入 SERVER_SSH_PASSPHRASE，工作流通过 passphrase 参数解锁。
这个入口不允许 SCP/SFTP；以后上传维护脚本仍使用原管理员密钥。只有新部署公钥被限制，日常登录不受影响。

限制命令能缩小 SSH 入口，但批准发布的应用镜像仍能访问生产依赖；需要信任发布代码及仓库写入者，不等同于对不可信应用的完全隔离。

## 2. 用当前镜像验证脚本

以下是迁移验收时的版本。执行前核对当前 Compose 中的 image；如果已更新，使用实际当前版本，不能盲目用旧 digest。

```bash
python3 /opt/fund/scripts/deploy.py rag ghcr.io/bobozh/fund-rag@sha256:7cbdc2c5a3bf368082139bafa40b92657cafee60a62f8f6b63f0abf528181d47
python3 /opt/fund/scripts/deploy.py backend ghcr.io/bobozh/fund-backend@sha256:da2920eb4ec2c948642c21d74f88ad13030107c80ce1e15bb1a5319d55c92b77
python3 /opt/fund/scripts/deploy.py frontend ghcr.io/bobozh/fund-frontend@sha256:5656423e6752e11d0a18b41ac679e1e20f4fbd95bfd2f5a38bbd97c4c0d6c52b
```

镜像与当前版本相同时，脚本验证依赖并输出 `same digest, no restart`，不重新下载或重建容器。
如果容器实际使用的镜像与 Compose 不一致，脚本会拒绝更新，应先确认实际运行版本。

## 3. 三个 GitHub 仓库分别配置

进入仓库 Settings → Secrets and variables → Actions。

Repository secrets：

- `SERVER_IP`：服务器地址。
- `SERVER_USER`：当前部署用户 root。
- `SERVER_SSH_KEY`：自动部署专用私钥 `fund_deploy` 的完整内容，不复用个人日常 root 登录私钥。
- `SERVER_SSH_PASSPHRASE`：生成该专用密钥时设置的口令；若未设口令则不填。
- `SERVER_SSH_FINGERPRINT`：服务器 SSH 主机公钥的 SHA256 指纹。
- `SERVER_PORT`：可选，默认 22。

在服务器查看主机指纹：

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

复制输出中的 `SHA256:...` 字段到指纹 Secret，不是复制整个公钥，也不是登录私钥。若服务器没有 Ed25519 主机密钥，检查实际使用的 SSH 主机公钥并取对应指纹。

完成脚本验证后，再添加 Repository variable：

```text
DEPLOY_ENABLED=true
```

没有设置、或不等于小写 true 时，工作流仍只发布镜像。此开关不会改变当前服务器服务。
服务端需继续保留已验证的 GHCR 登录凭证，用于读取私有镜像；Actions 的 GITHUB_TOKEN 只负责推送，不会自动登录服务器上的 Docker。

## 4. 提交工作流后发布

三个仓库分别提交各自 cd.yml 和容器说明。后端额外提交 deploy/，该目录保存共享脚本、测试和本说明。

- 手动 Run workflow：默认只发布镜像；勾选 deploy 才部署到服务器。
- 推送新 `v*.*.*` tag：启用 DEPLOY_ENABLED 后，测试、发布成功就自动部署。
- 只更新当前仓库对应的服务，另外两个应用、数据库及公网 Nginx 不重建。
- 首次建议先用 RAG 手动勾选 deploy 验证完整 Actions → SSH → 服务器链路，再逐个启用其他仓库。

后端发布任务还会运行部署脚本的模拟测试；测试失败不会发布后端镜像。

## 部署和回滚行为

1. 检查服务名、指定仓库和完整镜像 digest。
2. 获得 `/opt/fund/.deploy.lock`，三个仓库共用这把锁，最多等待 5 分钟。
3. 检查当前 Compose 及实际运行镜像，保存旧配置和候选配置。
4. 拉取新镜像（最多 20 分钟），此时旧容器继续服务。下载失败不会停止旧容器。
5. 只重建对应应用，等待 Docker 健康检查（最多 120 秒）。
6. 验证依赖：后端检查 MySQL SELECT 1、Redis PING、Qdrant 集合、RAG 健康接口和上传目录权限；RAG 检查 MySQL SELECT 1、Qdrant 集合；前端检查健康、SPA 和 API JSON 404。
7. 成功后原子更新 `/opt/fund/compose.<service>.yml` 中的 image。平时直接使用该 Compose 文件不会退回旧版本。
8. 更新或验证失败时，使用旧配置恢复上一版镜像并再次验证，Actions 返回失败。回滚失败会明确报告恢复配置路径。

这些检查不调用收费模型、不修改 SQL 或向量数据，也不代替真实登录、Embedding、重排、流式对话、WebSocket、文件入库的上线业务验收。
这是单实例更新，切换时会短暂中断；发布前等上传、入库和长对话等在途任务结束。SIGKILL、宿主机断电等不能保证脚本完成回滚，需要按记录恢复。

每次记录保存在 `/opt/fund/releases/<UTC时间>-<service>/`：

- `previous.compose.yml`：上一版配置。
- `next.compose.yml`：候选配置。
- `result.json`：前后镜像、UTC 时间及结果。

手动回退时，查看对应记录的 previousImage，并使用同一脚本重新部署该 digest：

```bash
python3 /opt/fund/scripts/deploy.py backend ghcr.io/bobozh/fund-backend@sha256:<上一版完整摘要>
```

镜像回退不会恢复数据库、环境文件和上传文件。涉及不兼容数据库结构或生产配置变更时，需单独制定迁移和恢复步骤。
脚本不会执行数据卷删除、镜像清理或清理旧代码目录；确认自动发布和回退链路后，再单独清理旧部署。
前端 nginx/default.conf 更新不会覆盖服务器上挂载的 frontend.conf，涉及代理规则变化时需要同步审核部署配置。

## 本地测试

在 fund-backend 目录执行：

```bash
python3 -m unittest discover -s deploy/tests -v
```

测试使用临时目录和模拟 Docker 状态，不连接服务器、不调用模型、不修改真实容器。
