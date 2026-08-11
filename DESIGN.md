---
name: 爆点实验室图片创作
description: 以印刷打样台为隐喻的冷静、专业、可操作营销图片工作台
colors:
  graphite-stock: "#101114"
  proof-surface: "#17191e"
  raised-stock: "#20232a"
  field-stock: "#121419"
  proof-border: "#30343d"
  proof-border-strong: "#434752"
  proof-text: "#f6f3ef"
  proof-muted: "#9a9eaa"
  proof-dim: "#90959f"
  proof-magenta: "#ff4d8d"
  proof-magenta-hover: "#ff659e"
  registration-cyan: "#59d9e8"
  signal-yellow: "#f4c95d"
  ink-on-accent: "#190b11"
typography:
  display:
    fontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "clamp(30px, 3vw, 46px)"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.05em"
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
    lineHeight: 1.2
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
    lineHeight: 1.35
    letterSpacing: "normal"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "9px"
    fontWeight: 400
    lineHeight: 1.65
    letterSpacing: "normal"
rounded:
  proof-sheet: "4px"
  compact: "7px"
  control: "10px"
  action: "11px"
  panel: "16px"
  pill: "999px"
spacing:
  hairline: "3px"
  compact: "6px"
  small: "8px"
  control: "12px"
  section: "16px"
  panel: "18px"
  header: "22px"
  page: "32px"
components:
  button-primary:
    backgroundColor: "{colors.proof-magenta}"
    textColor: "{colors.ink-on-accent}"
    typography: "{typography.title}"
    rounded: "{rounded.action}"
    height: "54px"
    padding: "0 18px"
  button-primary-hover:
    backgroundColor: "{colors.proof-magenta-hover}"
    textColor: "{colors.ink-on-accent}"
    typography: "{typography.title}"
    rounded: "{rounded.action}"
    height: "54px"
    padding: "0 18px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.proof-text}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    height: "40px"
    padding: "0 14px"
  field:
    backgroundColor: "{colors.field-stock}"
    textColor: "{colors.proof-text}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "11px 12px"
  panel:
    backgroundColor: "{colors.proof-surface}"
    textColor: "{colors.proof-text}"
    rounded: "{rounded.panel}"
    padding: "18px"
---

# Design System: 爆点实验室图片创作

## Overview

**Creative North Star: "The Print Proofing Table / 印刷打样台"**

图片创作世界把营销任务呈现成一张摆在石墨工作台上的印刷工单：信息具体、层级安静、每一步都可以立即操作。柔和的深色表面承担长时间工作，套准标记与克制的品红、电子青、信号黄只用来说明选择、焦点、成本和生产状态。

体验遵循“工单 → 打样画布 → 联系表 → 生成”的阅读顺序。品牌可以有冲击力，但操作密度、可见状态和真实投放约束始终优先；共享工作台外壳也延续同一石墨材质与克制状态语言，不把旧页面的视觉习惯当作这一新世界的规则。

**Key Characteristics:**

- 石墨纸张般的深色底与柔和分层表面
- 先任务、后画布、再成品联系表的清晰操作层级
- 品红表示主选择与生成，电子青表示焦点与校准，信号黄表示成本或提醒
- 标准矩形控件、轻圆角和印刷套准标记形成可识别的工作台世界
- 桌面端高密度并排工作，窄屏按任务顺序纵向展开

## Colors

主色盘以石墨黑灰为纸张和器材，三种打样墨色只承担稀少、明确的操作语义。

### Primary

- **Proof Magenta:** 唯一主操作、当前方案和选中下划线；它的稀缺让“生成”保持明显。

### Secondary

- **Registration Cyan:** 键盘焦点、输入聚焦、上传悬停与套准标记，表达精确和可操作性。

### Tertiary

- **Signal Yellow:** 积分成本、行业图标和主操作中的生产提示，不作为大面积背景。

### Neutral

- **Graphite Stock:** 页面底和主画布之外的工作台基底。
- **Proof Surface:** 工单、画布面板、结果面板与上下文胶囊的主表面。
- **Raised Stock:** 菜单和临时抬升层。
- **Field Stock:** 输入、选择卡、上传区和结果条目的内嵌底色。
- **Proof Border / Strong Border:** 分隔结构与可交互边界；强边界只用于悬停、浮层或固定操作栏。
- **Proof Text / Muted / Dim:** 依次用于主信息、说明标签和低优先级元数据。

### Named Rules

**The Three-Ink Rule.** 品红只表示主选择或生成，电子青只表示焦点与校准，信号黄只表示成本或生产提示；不要互换语义。

**The Ink Is Rare Rule.** 任一打样墨色都不铺满面板，也不叠加发光；大面积始终由石墨中性色承担。

## Typography

**Display Font:** PingFang SC（Microsoft YaHei、system-ui 回退）  
**Body Font:** PingFang SC（Microsoft YaHei、system-ui 回退）  
**Label/Mono Font:** ui-monospace（SFMono-Regular、Menlo 回退）仅用于生成细节

**Character:** 单一中文无衬线家族让高密度工单保持冷静直接。个性来自紧凑标题、数字编号和角色明确的小标签，而不是巨型展示字或混搭字体。

### Hierarchy

- **Display:** 紧凑粗体标题，用于页面名称；移动端收敛为 28px。
- **Headline:** 只用于打样画布内的方案名称，随画布缩放但不压过图片。
- **Title:** 面板标题和关键模块标题，保持短而有力。
- **Body:** 输入内容与主要说明，文本区使用宽松行高保证中文可读性。
- **Label:** 字段名、状态、比例和次级操作；必要的工位式标签可使用轻微字距。
- **Mono:** 仅显示可展开的生成提示细节，不用于导航或正文。

### Named Rules

**The Job-Ticket Type Rule.** 字号服务于扫描和操作层级；页面标题保持克制，禁止用巨型展示字制造戏剧性。

## Layout

桌面画布上限为 1700px，页面边距为 32px。核心工作区采用三列工位：324px 创作工单、至少 430px 的弹性打样画布、348px 结果联系表，列间距 16px。面板内部以 18px 为基础内边距，字段通常使用 14–16px 的纵向节奏。

在 1380px 以下三列缩为 298px / 弹性列 / 318px；在 1120px 以下结果面板移到第二行，三张结果横向并列。820px 以下共享侧栏转为顶部横向导航，工作区按工单、画布、结果顺序单列排列，方向和结果使用可横向滑动的卡片轨道，生成操作固定在视口底部。520px 以下工单字段回到单列，避免页面级横向溢出。

共享工作台外壳在桌面使用 188px 石墨侧栏，1120px 以下收至 164px；820px 以下只保留可横向滚动的顶部导航。品牌标记、会员卡和导航使用同一中性层级，只有当前导航项显示轻微品红状态。

**The Workflow Order Rule.** 响应式重排可以改变列数，但不能改变“工单 → 打样画布 → 联系表 → 生成”的任务顺序。

## Elevation & Depth

系统以色调分层为主、结构阴影为辅。常驻面板只有一层低对比长阴影，打样成品从画布上获得更深的纸张阴影；菜单与移动固定操作栏可以明显抬升。焦点深度由电子青描边和半透明外环表达，不使用霓虹光晕。

### Shadow Vocabulary

- **Panel Float** (`0 18px 50px rgba(0, 0, 0, .2)`): 工单、画布和结果面板的统一轻悬浮。
- **Proof Sheet** (`0 24px 70px rgba(0, 0, 0, .46), 0 0 0 1px rgba(255, 255, 255, .08)`): 成品画幅在暗色校样台上的纸张深度。
- **Menu Lift** (`0 18px 44px rgba(0, 0, 0, .5)`): 行业选择浮层。
- **Primary Action** (`0 10px 24px rgba(255, 77, 141, .18)`): 生成按钮的低强度墨色投影。

### Named Rules

**The Structural Shadow Rule.** 阴影只说明真实层级或操作状态；静态装饰和信息卡不凭空漂浮。

## Shapes

形状以标准矩形和轻圆角为主：面板使用 16px，主要操作与选择卡约 10–11px，小缩略图约 7px，真正的打样纸张只有 4px。圆形仅保留给步骤编号、套准标记和胶囊式上下文。边框始终完整、连续，不裁切面板，不使用异形缺角或 HUD 轮廓。

套准十字只出现在真正的打样画布边缘，用于建立印刷世界，不扩散到普通卡片、导航或表单。

**The Proof Sheet Rule.** 大容器可以柔和，成品画幅必须更像纸张；用较小圆角区分“工具”与“作品”。

## Components

### Buttons

- **Shape:** 生成操作使用稳定的 11px 圆角和 54px 高度；次级操作使用 10px 圆角和 40px 高度。
- **Primary:** 品红底配深色文字，粗体居中，并用黄色图标提示生产动作。
- **Hover / Focus:** 悬停仅提亮品红并上移 1px，按下归位；所有键盘焦点使用 2px 电子青外框和 2px 间距。
- **Secondary:** 透明底、强石墨边框和浅色文字；悬停只把边框切换为电子青。

### Chips

- **Style:** 比例选择器位于内嵌石墨轨道，单项为无边框的 31px 高紧凑按钮。
- **State:** 激活项用略亮石墨底和 2px 品红底线；覆盖区域选项用轻品红色调面和完整边框表达语义化选择。

### Cards / Containers

- **Corner Style:** 主面板使用 16px；方向卡、结果条目和上传区使用 10–11px。
- **Background:** 外层为 Graphite Stock，主面板为 Proof Surface，内嵌控件为 Field Stock。
- **Shadow Strategy:** 只有主面板、菜单、打样纸张与移动固定栏使用已定义的结构阴影。
- **Border:** 1px 石墨边框建立边界，选中卡片改为克制品红色调而不发光。
- **Internal Padding:** 主面板 18px；紧凑卡片 6–7px；字段 11–12px。

### Inputs / Fields

- **Style:** 深色内嵌底、1px 边框、10px 圆角；文本区允许垂直缩放。
- **Focus:** 边框变为电子青，并出现 3px、低透明度的青色外环；全局键盘焦点仍保留 2px 可见轮廓。
- **Error / Disabled:** 已实现的禁用控件使用 55% 不透明度和不可用光标；错误信息保持文本化，不制造新的装饰色系统。

### Navigation

桌面导航位于 188px 石墨侧栏，45px 高、10px 圆角，默认使用低对比灰色。悬停只抬高表面亮度；当前项使用暗品红石墨底、细内描边和品红图标。窄屏导航转为顶部 40px 高的横向可滚动条，不改动项目主路径。

### Proof Canvas

打样画布是系统的签名组件：深黑校样台内有细中心轴线、两枚克制套准十字和一张低圆角成品纸。预览文案作为半透明石墨标签贴在成品底部，方向切换只触发 340ms 的轻微淡入与比例回正；减少动态偏好下取消动画。

### Contact Sheet

结果以三条编号缩略图组成联系表。未生成时它们承担方向预览，生成后承担成品选择；激活状态使用品红色调边框与选中图标，交互语义通过 `aria-pressed` 保持可读。

## Do's and Don'ts

### Do:

- **Do** 保持工单、打样画布、联系表和生成操作的阅读顺序，即使布局在窄屏重排。
- **Do** 用石墨色调、完整 1px 边框和轻阴影建立层级，让打样墨色只承担明确状态。
- **Do** 保留可见的电子青键盘焦点、语义化选择状态和生成状态播报。
- **Do** 让共享侧栏和内容表面使用同一石墨材质，并在 820px 以下转换为紧凑顶部导航。
- **Do** 把套准标记限制在打样画布，把小圆角的成品纸与较柔和的工具面板区分开。

### Don't:

- **Don't** 使用游戏控制台式 HUD、霓虹描边或发光堆叠。
- **Don't** 裁切面板边缘、制造异形缺角，或把套准装饰复制到普通控件。
- **Don't** 用巨型展示字压过任务信息、主画布或唯一主操作。
- **Don't** 添加与任务无关的遥测数字、状态灯或装饰性技术读数。
- **Don't** 把项目中无关的旧页面 CSS、绿色纸张世界或高饱和旧 Image Lab 规则视为本系统规范。
