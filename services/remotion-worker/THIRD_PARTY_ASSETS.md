# 第三方开源素材

## 字体

- Ma Shan Zheng（马善政毛笔楷书）
  - 来源：https://github.com/googlefonts/mashanzheng
  - 文件：`public/fonts/MaShanZheng-Regular.ttf`
  - 许可：SIL Open Font License 1.1
- Noto Sans SC
  - 来源：https://github.com/google/fonts/tree/main/ofl/notosanssc
  - 文件：`public/fonts/NotoSansSC-Variable.ttf`
  - 许可：SIL Open Font License 1.1

## 音效

- Kenney Interface Sounds
  - 来源：https://kenney.nl/assets/interface-sounds
  - 使用文件：`open_002.ogg`、`maximize_003.ogg`、`select_001.ogg`、`confirmation_001.ogg`、`tick_001.ogg`
  - 许可：Creative Commons Zero 1.0（CC0），可用于商业项目且无需署名

## 背景音乐

- Simple menu/background music loop
  - 作者：polosik
  - 来源：https://opengameart.org/content/simple-menubackground-music-loop
  - 文件：`public/music/simple_loop.ogg`
  - 许可：Creative Commons Zero 1.0（CC0），可用于商业项目且无需署名
- Overworld (BGM)
  - 来源：https://opengameart.org/content/overworld-bgm
  - 文件：`public/music/high-red/cc0-overworld.mp3`
  - 许可：Creative Commons Zero 1.0（CC0），可用于商业项目且无需署名
- Heavenly Loop
  - 来源：https://opengameart.org/content/heavenly-loop
  - 文件：`public/music/high-red/cc0-heavenly-loop.ogg`
  - 许可：Creative Commons Zero 1.0（CC0），可用于商业项目且无需署名
- relax_background1
  - 来源：https://opengameart.org/content/relaxbackground1
  - 文件：`public/music/high-red/cc0-relax-background.ogg`
  - 许可：Creative Commons Zero 1.0（CC0），可用于商业项目且无需署名
- Other Center
  - 来源：https://opengameart.org/content/other-center
  - 文件：`public/music/high-red/cc0-other-center.ogg`
  - 许可：Creative Commons Zero 1.0（CC0），可用于商业项目且无需署名

### 爆点节奏独立副本

- `public/music/viral-pulse/airy-knowledge.ogg`：Heavenly Loop，CC0 1.0
- `public/music/viral-pulse/soft-lifestyle.ogg`：relax_background1，CC0 1.0
- `public/music/viral-pulse/editorial-calm.ogg`：Other Center，CC0 1.0
- `public/sfx/viral-pulse/a080-ip-pack/*.wav`：来自用户提供的 A080“自用IP剪辑高级感常用音效”三条合集；用户于 2026-08-12 明确确认为可直接商用。合集已拆分、响度校准为 71 个模板专用短音效，授权记录见 `public/licenses/viral-pulse-a080-commercial.txt`。
- `template-2` 字幕素材 `a080-two-row-04`、`a080-two-row-05`：依据用户提供并确认可商用的 A080“10个高级感字幕预设/两排字幕4、5”做响应式代码重建；仅供“模板2｜柔粉双行”使用，不打包剪映缓存字体和原配游戏/庆祝音效。模板1保持黄白字幕体系，不引用这两项素材。
- 许可证记录：`public/licenses/OpenGameArt-Viral-Pulse-Music-CC0.txt`

### 模板3–8 独立副本

- `public/music/template-3/` 至 `public/music/template-8/`：分别从上方已登记的 Heavenly Loop、relax_background1、Other Center、Simple menu/background music loop，以及本地已登记的 JRPG Piano CC0 音乐复制为模板专属文件，避免模板间串用。
- `public/sfx/template-3/` 至 `public/sfx/template-8/`：来自 Kenney Interface Sounds 的 `maximize_003.ogg`、`tick_001.ogg`、`open_002.ogg`、`confirmation_001.ogg`，按开场、强调、转场、收尾四类复制为模板专属文件，许可均为 CC0 1.0。
- 每个模板的具体文件、来源和许可同时记录在对应 `templates-v2/template-N/materials.json`；模板间禁止交叉选取素材。

### 2026-08-13 模板1、2、3、4、6、7、8重构音乐池

- 来源目录：用户提供的 `BGM背景纯音乐素材配音包/4.无分类纯音乐商用100/`。
- 授权依据：该目录 `使用说明.txt` 明确声明100首音乐支持个人或公司商用、没有使用限制；原文复制保存为 `public/licenses/bgm-commercial-pack-user-statement.txt`。
- 使用范围：从中筛选21个完整、低存在的背景音乐文件，分别复制到七个模板的独立音乐目录；每个模板3首，禁止跨模板回退。
- 具体原文件名、SHA-256、内容用途和口播安全音量记录在各模板 `materials.json`。
- 未采用素材包中的热门歌曲、影视歌曲及授权来源不明确目录。

## 本地“轻奢白·双语”候选素材（仅测试）

- 字幕动作参考：`83个基础文字动画音效搭配预设.zip`
  - SHA-256：`20792dfa80d7cd08f7317d234a506a3a6f1c654bb993fb0d5994258f5d4b5fd1`
  - 使用方式：只把“逐字显影、向上露出、轻微放大”等动作语义重写为 Remotion 动画，不直接加载剪映草稿。
- 音效候选：`自用IP剪辑高级感常用音效.zip`
  - SHA-256：`c67030f04a083e0746e0eed224594b45004a726e8690d0630005720a47893b98`
  - 转码文件：`public/sfx/light-luxury-local/`
  - 当前许可状态：素材包内未发现可核验的授权说明，仅允许本地效果测试。
  - 正式部署前要求：补充购买记录或明确的商用授权；无法核验时，替换成 CC0 / 自制音效。

许可证原文保存在 `public/licenses/`。不得以原作者为项目背书，也不要单独出售字体文件。
