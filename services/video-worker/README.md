# 一键网感视频处理服务

该服务独立于网站运行，负责：

1. 接收原片并保存到本地磁盘。
2. 使用 FFmpeg 提取音频和首帧封面。
3. 只使用腾讯云极速语音识别生成逐字时间轴，再根据标点、停顿、字数和持续时间重组字幕；识别失败时明确报错，不切换其他语音识别服务。
4. 把真实口播文案交给 GPT-5.5，总结 8–18 字的内容标题；AI 不可用时只从口播本身提炼，不用画面虚构标题。
5. 使用云端模板包把模板拆成开场、可重复正文和结尾规则；转场由真实镜头变化或长停顿触发，不再按照固定秒数硬套。
6. 保留原片声音，并按模板音乐池低音量叠加背景音乐与语义节点提示音。
7. 依据原片清晰度限制放大倍率，再导出 H.264 MP4、独立封面与处理分析结果。

## 模板蒸馏

项目内置 `skills/distill-viral-video-template`。它会逐帧解码示例视频，提取标题、字幕、镜头、音效与逐字口播，产出可继续校准的 Template V10 草稿。模板不是复制示例视频的固定时间线，而是一组可以适应不同原片时长的规则。

新模板不能只上传名称和预览视频就直接发布。必须依次完成逐帧学习、人工校准、短原片回归、长原片回归和发布门禁；字幕文本覆盖率至少 90%、有效口播时间覆盖率至少 92%、坏帧为 0，才能标记为正式发布。

### 管理后台一键学习

管理员后台的“网感模板”页面支持直接上传参考原视频并点击“一键学习并生成模板”。网页会创建异步学习任务，视频处理服务随后：

1. 解码参考视频的每一个画面帧，并按时间顺序生成连续帧联络表；
2. 提取口播转写、镜头变化和原片基础信息；
3. 由视觉模型结合整段画面，自动匹配标题、字幕、主辅色、字体方向、转场节奏和音效规则；
4. 生成 Template V10 草稿和逐帧分析摘要，并回写管理员模板库；
5. 草稿完成两条不同时长原片的回归验证后，才允许正式上架。

网页服务与视频处理服务必须配置相同的 `VIDEO_WORKER_ADMIN_TOKEN`。浏览器不会接触这个密钥，所有模板学习请求都由管理员接口在服务端转发。

模板学习接口：

- `POST /v1/template-learning/jobs`：上传参考视频并创建异步学习任务；
- `GET /v1/template-learning/jobs/{job_id}`：读取学习进度及最终生成的模板规则。

运行时模板位于：

```text
templates-v2/<template-id>/template.json
```

当前 `clean-green` 已在本地升级为 Template V19 独立模板；云端仍保持原版本，待明确确认部署后再同步。其余旧模板仍兼容运行，可逐个通过蒸馏工具升级。

模板注册表位于 `template-registry.json`。部署后网页通过 `/v1/templates` 自动读取模板，
不再依赖前端硬编码。若把注册表上传到腾讯云 COS，可配置：

```text
VIDEO_TEMPLATE_REGISTRY_URL=https://你的COS地址/template-registry.json
VIDEO_TEMPLATE_REGISTRY_CACHE_SECONDS=300
```

服务每 5 分钟刷新一次；远端不可用时自动保留最近一次成功结果，并回退到部署包内的
`clean-green`。该模板从 5 首 CC0 完整背景音乐中按标题和口播内容匹配，并携带模板专属
标题、字幕、转场、音效和导出质量规则；禁止跨模板素材兜底。

## 本地启动

macOS 首次安装 FFmpeg：

```bash
brew install ffmpeg
```

随后双击 `start.command`，或执行：

```bash
./start.command
```

服务默认地址：

```text
http://127.0.0.1:8790
```

健康检查：

```text
http://127.0.0.1:8790/health
```

## 腾讯云部署

当前正式目录包含原有 4 套网感模板与新增 8 套模板，共 12 套。生产发布由
`.github/workflows/deploy-production.yml` 将 Python 服务、模板配置、Remotion 渲染器、
字体、背景音乐和音效合并为一个原子运行包，避免网页目录与实际成片服务版本不一致。

推荐 Ubuntu 22.04/24.04，安装 `ffmpeg`、`python3-venv` 和字体后创建虚拟环境。
生产环境把服务绑定在 `127.0.0.1:8790`，通过 Nginx 的 `/video-worker/` 路径转发，不直接暴露端口。

在服务目录执行：

```bash
chmod +x install-ubuntu.sh
./install-ubuntu.sh
```

Nginx 配置参考 `nginx-video-worker.conf.example`，常驻服务参考
`video-worker.service.example`。

环境变量参考 `.env.example`。普通 4 核 8GB CPU 服务器先使用：

```text
VIDEO_WORKER_CONCURRENCY=1
LK888_API_BASE_URL=https://api.lk888.ai
LK888_API_KEY=你的开放平台密钥
VIDEO_WORKER_TITLE_MODEL=gpt-5.5
TENCENT_CLOUD_APP_ID=你的腾讯云账号 AppID
TENCENT_CLOUD_SECRET_ID=你的腾讯云 SecretId
TENCENT_CLOUD_SECRET_KEY=你的腾讯云 SecretKey
TENCENT_ASR_ENGINE_TYPE=16k_zh_en
```

上线前应为媒体访问增加会员鉴权或短时签名；当前本地版本只用于开发测试。

部署后可用下面两个地址确认模板运行状态：

```text
GET /video-worker/health
GET /video-worker/v1/templates
GET /video-worker/v1/templates/clean-green
GET /video-worker/v1/template-registry
```

健康检查中的 `template_v2_count` 必须大于 0；本地模板列表中的 `clean-green.version` 应为 `19`。
