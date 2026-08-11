# 自动同步与腾讯云部署

## 发布流程

本地项目使用下面的命令发布：

```bash
pnpm run publish:production -- "本次更新说明"
```

该命令会暂存并提交当前项目目录中的全部改动，然后推送到 GitHub 的 `main` 分支。运行前应先确认项目中没有不需要发布的文件。GitHub Actions 随后自动完成：

1. 类型检查与代码检查。
2. 构建 Next.js 生产版本。
3. 将构建产物安全上传到腾讯云。
4. 保留服务器上的 `.data` 和 `.env.local`。
5. 重启服务并检查 `/api/health`。
6. 新版本启动失败时恢复上一个版本。

不要把 `.env.local`、数据库或正式密钥提交到 GitHub。

## GitHub 生产环境密钥

仓库的 `production` Environment 需要以下 Secrets：

- `TENCENT_SSH_HOST`：腾讯云服务器公网地址。
- `TENCENT_SSH_PORT`：SSH 端口，通常为 `22`。
- `TENCENT_SSH_USER`：固定为 `merchantdeploy`。
- `TENCENT_SSH_PRIVATE_KEY`：仅供 GitHub Actions 使用的独立私钥。
- `TENCENT_SSH_KNOWN_HOSTS`：已核验的腾讯云 SSH 主机公钥记录。

部署密钥应独立于个人 GitHub 密钥。服务器只允许该用户调用受限的部署命令，不能把 root 密码放入 GitHub。

## 服务器初始化

首次接入时，以 root 身份在腾讯云服务器运行：

```bash
bash deploy/bootstrap-github-deploy.sh /root/github-actions-deploy.pub /path/to/project
```

初始化完成后，服务器通过 `/usr/local/sbin/deploy-merchant-studio` 接收 GitHub Actions 的发布包。
