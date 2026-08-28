# 自动同步与腾讯云部署

本文件说明当前项目的发布机制。第三方从零部署时，应先按 [云服务器架构实施计划](CLOUD_DEPLOYMENT_PLAN.md) 完成资源、安全组、域名、数据库、对象存储和密钥配置。

## 发布流程

本地项目使用下面的命令发布：

```bash
pnpm run publish:production -- "本次更新说明"
```

该命令会暂存并提交当前项目目录中的全部改动，然后推送到 GitHub 的 `main` 分支。运行前应先确认项目中没有不需要发布的文件。GitHub Actions 随后自动完成：

1. 类型检查与代码检查。
2. 构建 Next.js 生产版本。
3. 只把发生变化的构建文件增量同步到腾讯云。
4. 保留服务器上的 `.data` 和 `.env.local`。
5. 重启服务并检查 `/api/health`。
6. 新版本启动失败时恢复上一个版本。

不要把 `.env.local`、数据库或正式密钥提交到 GitHub。

公开仓库不应在工作流中写死真实域名、IP、SSH 指纹或存储桶。建议把主站和渲染节点的地址配置为 GitHub Environment Variables，把 SSH 私钥和主机公钥记录配置为 Secrets。

## GitHub 生产环境密钥

仓库的 `production` Environment 需要以下 Secrets：

- `TENCENT_SSH_HOST`：腾讯云服务器公网地址。
- `TENCENT_SSH_PORT`：SSH 端口，通常为 `22`。
- `TENCENT_SSH_USER`：固定为 `merchantdeploy`。
- `TENCENT_SSH_PRIVATE_KEY`：仅供 GitHub Actions 使用的独立私钥。
- `TENCENT_SSH_KNOWN_HOSTS`：已核验的腾讯云 SSH 主机公钥记录。

独立渲染节点使用另一组同类 Secrets/Variables，并使用不同部署账号和私钥。业务 API Key、支付私钥和云平台 SecretKey 不进入 GitHub Actions 构建环境，应直接保存在目标服务器的受限配置中。

当前工作流还需要：

### GitHub Secrets

- `VIDEO_WORKER_SSH_KNOWN_HOSTS`：已核验的渲染节点 SSH 主机公钥记录。

### GitHub Variables

- `VIDEO_WORKER_SSH_HOST`：渲染节点地址。
- `VIDEO_WORKER_SSH_PORT`：渲染节点 SSH 端口，通常为 `22`。
- `VIDEO_WORKER_SSH_USER`：渲染节点受限部署账号。
- `PUBLIC_HEALTHCHECK_URL`：发布后检查地址，例如 `https://studio.example.com/api/health`。

这些值未配置时工作流会主动失败，避免误发到未知服务器。

部署密钥应独立于个人 GitHub 密钥。服务器只允许该用户调用受限的部署命令，不能把 root 密码放入 GitHub。

## 服务器初始化

首次接入时，以 root 身份在腾讯云服务器运行：

```bash
bash deploy/bootstrap-github-deploy.sh /root/github-actions-deploy.pub /path/to/project
```

初始化完成后，服务器通过 `/usr/local/sbin/deploy-merchant-studio` 接收 GitHub Actions 的发布包。
