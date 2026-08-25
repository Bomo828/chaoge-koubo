# 独立视频服务

`services/video-worker/` 负责视频任务、语音识别、模板编排、市场动态适配和渲染调度；`services/remotion-worker/` 负责模板 9–12 的 Remotion/FFmpeg 渲染。

主站仍从仓库根目录构建。用户端通过 `https://studio.chaogeai.top/video-worker/` 访问独立渲染节点，节点只对主站提供受控服务。相关目录发生变化后，GitHub Actions 会随主站版本一起发布对应的视频服务版本。
