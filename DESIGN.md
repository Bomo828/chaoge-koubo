---
name: 爆点实验室创作工作台
description: 以电光打样台为隐喻的中文商家图片、短视频、市场监控与会员资产工作台
colors:
  midnight-bench: "#0c1334"
  deep-navy-rail: "#111943"
  electric-surface: "#151d49"
  raised-blue: "#1d285e"
  inset-navy: "#101738"
  proof-line: "#34468c"
  proof-line-strong: "#536bd0"
  proof-text: "#f6f3ef"
  proof-muted: "#b2bce8"
  proof-magenta: "#ff4d8d"
  proof-magenta-hover: "#ff659e"
  registration-cyan: "#59d9e8"
  signal-yellow: "#f4c95d"
  graphite-proof: "#17191e"
  graphite-field: "#121419"
  ink-on-accent: "#190b11"
typography:
  display:
    fontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "clamp(28px, 3vw, 42px)"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "-0.03em"
  headline:
    fontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "clamp(24px, 2.3vw, 38px)"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "-0.04em"
  title:
    fontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  body:
    fontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  label:
    fontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: "normal"
  data:
    fontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "13px"
    fontWeight: 800
    lineHeight: 1.35
    letterSpacing: "normal"
rounded:
  proof-sheet: "4px"
  compact: "7px"
  control-sm: "8px"
  control: "10px"
  action: "11px"
  container: "12px"
  card: "14px"
  panel: "16px"
  pill: "999px"
spacing:
  hairline: "3px"
  compact: "6px"
  small: "8px"
  control: "12px"
  section: "16px"
  panel: "18px"
  header: "24px"
  page: "32px"
components:
  button-primary:
    backgroundColor: "{colors.proof-magenta}"
    textColor: "{colors.ink-on-accent}"
    typography: "{typography.title}"
    rounded: "{rounded.action}"
    height: "48px"
    padding: "0 18px"
  button-primary-hover:
    backgroundColor: "{colors.proof-magenta-hover}"
    textColor: "{colors.ink-on-accent}"
    typography: "{typography.title}"
    rounded: "{rounded.action}"
    height: "48px"
    padding: "0 18px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.proof-text}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    height: "40px"
    padding: "0 14px"
  field:
    backgroundColor: "{colors.inset-navy}"
    textColor: "{colors.proof-text}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "11px 12px"
  panel:
    backgroundColor: "{colors.electric-surface}"
    textColor: "{colors.proof-text}"
    rounded: "{rounded.panel}"
    padding: "18px"
  tab-selected:
    backgroundColor: "{colors.raised-blue}"
    textColor: "{colors.proof-text}"
    typography: "{typography.label}"
    rounded: "{rounded.control-sm}"
    height: "38px"
    padding: "0 12px"
---

# Design System: 爆点实验室创作工作台

## Overview

**Creative North Star: "The Electric Proofing Table / 电光打样台"**

爆点实验室把商家的图片、短视频、市场动态和会员资产组织成一张持续工作的数字打样台。深靛蓝是工作间的环境光，石墨黑是创作与预览的校样区域；品红、电子青和信号黄像三种功能明确的套准墨，只在选择、焦点、生成、成本与状态处出现。

系统不是娱乐化控制台。它强调真实内容、清楚步骤、可恢复进度和可核对账目：复杂的 AI 流程被拆成稳定面板、步骤状态、素材轨道和结果区；市场动态使用账号栏、资料区与视频网格；会员中心使用余额、分区流水和资产入口。每个模块可以有自己的任务构图，但必须共享相同的色彩语义、控件密度和反馈语言。

公开首页与会员工作台是两个明确分离的体验层。首页只承担品牌展示、登录与进入工作台，不预取会员、模板、支付或市场数据；工作台先交付稳定外壳，再在用户打开对应功能后加载代码与数据。性能不是隐藏的工程细节，而是本设计系统对“即时响应”的组成部分。

**Key Characteristics:**

- 深靛蓝工作台外壳与石墨校样区域形成双层生产环境
- 品红表示主选择与生成，电子青表示焦点、校准与正向到账，信号黄表示成本、消费与提醒
- 面板、列表和步骤条优先承载任务状态，不用装饰性数据制造专业感
- 桌面端并排提高效率，移动端保持相同任务顺序并消除页面级横向溢出
- 图片、视频、账号、流水和生成结果都使用真实内容与明确空状态
- 首页轻量进入、工作台外壳先行、功能按需加载，避免在首屏初始化整套平台
- 视频先展示首帧封面，用户发起播放后再读取媒体数据

## Colors

色彩体系由电光深蓝工作台、石墨校样面和三种稀少的功能墨色组成。

### Primary

- **Proof Magenta:** 唯一高强调主操作、当前方案、活动步骤和选中底线。

### Secondary

- **Registration Cyan:** 键盘焦点、输入聚焦、上传悬停、完成状态与充值到账金额。

### Tertiary

- **Signal Yellow:** 积分成本、实际消费、生产提醒和少量关键状态，不作为普通装饰背景。

### Neutral

- **Midnight Bench / Deep Navy Rail:** 页面背景、侧栏和大范围工作环境。
- **Electric Surface / Raised Blue / Inset Navy:** 常驻面板、抬升菜单和内嵌字段的三级蓝色表面。
- **Graphite Proof / Graphite Field:** AI 导演、市场监控、媒体预览与校样画布等需要后退的生产区域。
- **Proof Line / Strong Line:** 结构分隔和交互边界；强线只在悬停、焦点或固定操作区使用。
- **Proof Text / Proof Muted:** 主信息和辅助元数据。辅助文字必须带蓝紫色相，不退回中性灰。

### Named Rules

**The Three-Ink Rule.** 品红只表示选择或生成，电子青只表示焦点、完成或正向到账，信号黄只表示成本、消费或提醒；不要互换语义。

**The Two-Table Rule.** 深蓝承担产品外壳，石墨承担需要视觉后退的创作和媒体区域；同一面板内不要无理由混用两套底色。

**The Ink Is Rare Rule.** 功能墨色不铺满大型面板，也不叠加霓虹发光；大面积始终由深蓝或石墨中性色承担。

## Typography

**Display Font:** PingFang SC（Microsoft YaHei、system-ui 回退）  
**Body Font:** PingFang SC（Microsoft YaHei、system-ui 回退）  
**Data Font:** 与正文同族，使用更高字重和等宽数字特性

**Character:** 单一中文无衬线家族让高密度工具保持直接。个性来自紧凑标题、清楚的数值层级和少量套准式偏移阴影，而不是巨型展示字、英文装饰标签或混搭字体。

### Hierarchy

- **Display:** 页面名称，使用紧凑粗体和克制字距；桌面不超过 42px。
- **Headline:** 方案名、视频主标题和校样画布中的内容标题，不压过真实媒体。
- **Title:** 面板、模块和步骤标题，通常为 15–19px。
- **Body:** 输入、说明和操作反馈；长文保持约 65–75ch 的阅读宽度。
- **Label:** 字段名、标签、时间和次级操作，最小可读文字不依赖大写字距制造层级。
- **Data:** 积分、消费额、播放量与时长，使用等宽数字以便纵向核对。

### Named Rules

**The Operational Type Rule.** 字号服务于扫描、比较和操作；标题必须让位于素材、结果、账号数据和唯一主操作。

## Layout

共享桌面外壳使用 188px 左侧导航、64px 粘性顶栏和最大 1700px 内容区；页面边距为 32px，主面板间距通常为 16–18px。当前模块独占内容主轴，避免同时出现两个同级主流程。

图片创作延续“工单 → 打样画布 → 联系表 → 生成”；短视频入口使用四张并列模式卡，进入工具后转换为步骤面板、素材区和预览/结果区；市场动态使用约 285px 账号栏与弹性账号主页，视频网格在桌面为四列；会员中心使用余额区、账户流水和资产入口三段结构，消费流水按日期分区。

1080px 以下侧栏收窄，760px 以下侧栏转换为顶部横向导航、内容边距收至 14px。任务页面从并排改为单列；市场账号栏移到账号主页之后；视频网格收为两列；账户流水在 680px 以下把金额和余额收进右侧双行，不能产生页面级横向滚动。

公开首页保持独立静态入口，只包含品牌主视觉、登录/注册弹窗和工作台入口。会员工作台首帧只渲染共享导航、当前模块框架与必要身份状态；图片创作、视频创作、市场动态、创作资产、账号中心和 AI 助手均在用户进入时动态加载。概览中的会员资产应在首屏绘制后再请求，不能阻塞外壳出现。

**The Workflow Order Rule.** 响应式可以改变列数、固定方式和轨道方向，但不能改变用户完成任务的顺序。

**The One Active Job Rule.** 一个页面只允许一个明确的当前步骤和一个高强调主操作；后台并行不转化为前台视觉噪音。

**The Instant Shell Rule.** 先显示可操作的页面骨架，再加载会员资产和功能模块；禁止为了“数据齐全”让用户面对空白首屏。

**The Media Before Bytes Rule.** 视频列表与结果区先使用首帧封面和固定画幅稳定布局，用户播放时才读取媒体；页面打开时不得批量读取完整视频。

## Elevation & Depth

系统以色调分层为主、结构阴影为辅。常驻蓝色面板使用低对比长阴影，石墨工作区通过完整边框与更深背景后退；媒体、菜单和固定移动操作栏可以获得更明显抬升。焦点深度来自电子青描边和低透明度外环。

### Shadow Vocabulary

- **Workbench Panel** (`0 18px 48px rgba(2, 5, 29, .22)`): 深蓝工作台面板的统一轻悬浮。
- **Graphite Panel** (`0 18px 50px rgba(0, 0, 0, .2)`): AI 导演、市场监控和媒体工具的石墨面板。
- **Menu Lift** (`0 18px 44px rgba(0, 0, 0, .5)`): 账户菜单与临时选择层。
- **Primary Action** (`0 10px 24px rgba(255, 77, 141, .18)`): 生成操作的低强度品红投影。

### Named Rules

**The Structural Shadow Rule.** 阴影只说明真实层级、悬停或固定状态；普通列表行和信息块保持平面。

## Shapes

形状以完整矩形与轻圆角为主：主面板使用 16px，普通卡片使用 12–14px，操作控件使用 8–11px，真正的媒体画幅和校样纸使用 4–7px。胶囊只用于短状态、标签和小型计数；长按钮、整行列表和大标题容器不做胶囊。

所有边框必须连续。不要使用异形缺角、厚重单侧彩边或 HUD 轮廓。账号头像、步骤编号和加载指示器可以使用圆形，其余内容保持稳定矩形。

**The Proof Sheet Rule.** 工具面板可以柔和，媒体与成品画幅必须更克制；用较小圆角区分“工具”与“内容”。

## Components

### Buttons

- **Shape:** 主操作通常为 48–54px 高、10–11px 圆角；紧凑操作为 36–40px 高、8–10px 圆角。
- **Primary:** 品红底配深色文字，只用于当前流程的唯一主要动作。
- **Hover / Focus:** 悬停提亮并最多上移 1px；所有键盘焦点使用 2px 电子青外框和 2px 间距。
- **Secondary:** 透明或内嵌深色底配完整边框；悬停只增强边界或文字。
- **Cost / Recharge:** 信号黄底配深色文字，仅用于积分充值、成本确认等财务动作。

### Chips

- **Style:** 选项位于内嵌深色轨道，使用紧凑矩形按钮。
- **State:** 激活项使用 Raised Blue、浅色文字和 2px 品红底线；计数使用更小但可读的等宽数字。

### Cards / Containers

- **Corner Style:** 主面板 16px；模式卡和资产卡 12–14px；媒体缩略图 7px。
- **Background:** 蓝色应用面板使用 Electric Surface，创作和媒体工作区可使用 Graphite Proof。
- **Shadow Strategy:** 仅面板、菜单、媒体画幅和固定操作栏使用结构阴影。
- **Border:** 1px 完整边框建立结构；选中状态可以使用品红底线或轻色调，不叠加外发光。
- **Internal Padding:** 主面板 18–24px，列表行 13–16px，字段 11–12px。

### Inputs / Fields

- **Style:** 内嵌深色底、1px 边框、10px 圆角，长内容区允许垂直缩放。
- **Focus:** 边框切换为电子青并出现 3px 低透明度外环。
- **Error / Disabled:** 错误必须说明问题和恢复动作；禁用状态降低对比并使用不可用光标，不能只靠颜色。

### Navigation

桌面导航使用深蓝侧栏和 45px 高项目。默认文字为蓝紫灰，悬停抬高表面，当前项使用品红到紫色的轻色调面、完整内描边和品红状态线。760px 以下转为顶部横向导航，并保留当前项、账户入口和主要页面可达性。

### Workflow Steps

AI 导演、对口型和其他多步流程使用连续步骤条与单一当前步骤。完成状态用电子青，当前状态用品红，等待状态保持低对比。详细分析默认在后台运行，前台优先显示材料、当前动作、进度、错误恢复和最终结果。

所有多步骤流程必须显示草稿或检查点状态。刷新恢复后直接定位到最近未完成步骤；已有后台任务号时显示“继续查询”，失败时显示“当前步骤失败，可直接重试”。不得把“全部重新开始”作为默认错误恢复方式，也不得因页面刷新重复扣积分。

### Market Account Monitor

市场动态由账号栏、账号资料、关键指标和公开视频网格组成。账号切换保持主页内容稳定；指标行允许窄屏横向滚动，但整个页面不能横向溢出。同步状态必须有完成、失败和重试，不允许永久停留在“同步中”。

### Account Records

账户记录使用消费/充值双标签。消费按上海时区日期分区，日期头展示当天笔数和总消耗；每行依次展示用途、时间与流水、积分变化和结余。消费金额使用信号黄，充值到账使用电子青。列表以分隔线建立节奏，不把每条流水包装成独立卡片。

### Proof & Media Canvas

图片校样、视频预览和最终成片共享深色媒体底、低圆角画幅和可见播放/下载控制。预览必须保留原始宽高关系；除非模板明确要求，不使用强制 cover 裁切造成主体放大。

视频默认使用 `preload="none"` 或 `preload="metadata"`，并提供真实首帧封面；媒体容器在资源到达前就锁定 9:16、3:4、1:1 或 16:9 比例，避免布局跳动。长视频与会员资产必须支持 Range 分段读取；下载与播放必须是两个明确动作，下载失败时给出可恢复提示。

### Loading & Deferred Modules

动态模块加载使用与目标面板同尺寸、同背景层级的简洁骨架，不使用全屏转圈遮挡已经可操作的导航。首页不显示工作台数据骨架；工作台的局部模块可以显示“正在打开图片创作”“正在读取市场动态”等直接状态。延迟加载失败必须允许重试，并保留用户当前导航位置。

## Do's and Don'ts

### Do:

- **Do** 保持每个模块的任务顺序、当前步骤、预计成本和结果状态一眼可见。
- **Do** 用深蓝外壳、石墨工作区、完整 1px 边框和少量结构阴影建立层级。
- **Do** 让品红、电子青和信号黄持续承担固定语义，并保留可见键盘焦点。
- **Do** 为加载、空数据、错误、重试、已完成和历史记录提供真实状态。
- **Do** 在移动端重排而非缩小桌面布局，保证素材、视频、账号与流水可以完整阅读。
- **Do** 使用真实商家素材、账号信息、任务流水和可核对的商业事实。
- **Do** 让公开首页独立于工作台数据，并在工作台先交付外壳、后加载当前功能。
- **Do** 为视频提供真实首帧封面、固定画幅、分段播放和独立下载动作。

### Don't:

- **Don't** 使用游戏控制台式 HUD、密集霓虹描边、装饰性遥测或无意义英文标签。
- **Don't** 给每一条记录、每一个指标或每一个说明都套独立圆角卡片。
- **Don't** 用厚重单侧彩边、异形缺角、渐变文字或硬偏移阴影制造“科技感”。
- **Don't** 把主色互换语义，或让多个高强调按钮在同一当前步骤中竞争。
- **Don't** 隐藏错误恢复、积分结算、生成状态或刷新后的草稿恢复状态。
- **Don't** 强制裁切媒体、虚构账号数据或把 AI 合成场景冒充真实事实。
- **Don't** 在工作台首屏同时初始化会员、模板、支付、市场动态和全部创作工具。
- **Don't** 在页面打开时预载完整视频，或用空黑视频框代替可识别的首帧封面。
