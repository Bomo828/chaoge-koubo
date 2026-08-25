# 爆点实验室

面向商家的 AI 内容创作平台。当前代码库同时包含用户工作台、管理后台、会员与支付、市场动态、AI 内容能力，以及独立的视频渲染服务。

## 当前功能

- 图片设计：营销海报、朋友圈海报、门店物料和行业图片
- 短视频：素材智能成片、AI 超级剪辑、对口型视频和一键网感
- 网感模板：保留正式模板 9–12，由独立 Remotion/FFmpeg 渲染节点处理
- 市场动态：对标账号监控、公开作品列表和数据跟踪
- 会员资产：统一管理图片、视频、成片、封面和克隆声音
- 会员与支付：邀请码注册、积分账户、充值记录和微信支付
- 管理后台：模板、积分、会员、AI 服务和支付配置

## 项目结构

- `app/`：用户工作台、管理后台和服务端 API
- `lib/`：数据库、会员、积分、支付、市场动态和第三方服务逻辑
- `public/ai-explainer/`：AI 超级剪辑前端
- `services/video-worker/`：视频任务、语音识别、模板编排和渲染调度
- `services/remotion-worker/`：模板 9–12 的 Remotion/FFmpeg 渲染器
- `deploy/`：腾讯云主站与独立渲染节点部署配置
- `docs/`：当前架构、自动部署和模板规则文档

## 生产架构

用户访问 Next.js 主站；会员、积分、支付和业务数据由主站服务处理。视频任务经主站转发至独立渲染节点，由视频服务调用 Remotion、FFmpeg、腾讯云和第三方能力，产物保存到 COS 与会员资产。详细说明见 `docs/PROJECT_ARCHITECTURE.md`。

## 本地运行

需要 Node.js 22.13 或更高版本。

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run dev
```

浏览器打开终端显示的本地地址即可。正式版本通过 `main` 分支的 GitHub Actions 自动部署；部署说明见 `docs/AUTOMATIC_DEPLOYMENT.md`。

环境变量、证书、支付私钥、`.data/` 数据库与运行产物不提交 GitHub。
