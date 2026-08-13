# Merchant Studio 9:16 包装引擎

这是项目自有的竖版口播包装渲染器。输入 `timeline.json`，输出带开场标题、关键词字幕、章节提示、信息卡片和提示音的 MP4。

渲染命令：

```bash
pnpm install
pnpm typecheck
pnpm render /absolute/job/timeline.json /absolute/job/output.mp4
```

视频原片和任务自带提示音文件放在 `timeline.json` 同级目录，清单中填写文件名。渲染器还内置了可商用的开源中文字体与 CC0 提示音；每次渲染会自动复制到任务目录，不依赖服务器系统字体。服务端没有安装本渲染器时，现有 FFmpeg 渲染会自动接管。

时间轴可以通过 `sfxCues` 使用内置提示音：

```json
{
  "sfxCues": [
    {"start": 0.1, "file": "sfx/maximize_003.ogg", "volume": 0.28},
    {"start": 2.0, "file": "sfx/select_001.ogg", "volume": 0.18}
  ]
}
```

需要连续背景音乐时，可在时间轴中使用 `bgmFile` 和 `bgmVolume`。播放器会自动循环，并在开头、结尾淡入淡出：

```json
{
  "bgmFile": "music/simple_loop.ogg",
  "bgmVolume": 0.055
}
```

素材来源与许可见 `THIRD_PARTY_ASSETS.md` 和 `public/licenses/`。
