export type TemplateSeed = {
  id: string;
  slug: string;
  category: "viral_video" | "image" | "video";
  name: string;
  version: number;
  previewUrl: string;
  coverUrl: string;
  description: string;
  config: Record<string, unknown>;
};

type FinalViralTemplate = {
  id: string;
  slug: string;
  name: string;
  coverUrl: string;
  description: string;
  accent: string;
  titleColor: string;
  panel: string;
  titleEffect: string;
  subtitleEffect: string;
  transitionKey: "fade" | "flash" | "zoom" | "slide" | "hard-cut-punch";
  transitionLabel: string;
  sfxKey: "soft" | "click" | "bright" | "impact" | "wood";
  rendererKey: string;
  packagePath: string;
};

const FINAL_VERSION = 23;

function finalizedTemplate(template: FinalViralTemplate): TemplateSeed {
  return {
    id: template.id,
    slug: template.slug,
    category: "viral_video",
    name: template.name,
    version: FINAL_VERSION,
    previewUrl: "",
    coverUrl: template.coverUrl,
    description: template.description,
    config: {
      accent: template.accent,
      titleColor: template.titleColor,
      panel: template.panel,
      titleEffect: template.titleEffect,
      subtitleEffect: template.subtitleEffect,
      transitionKey: template.transitionKey,
      transitionLabel: template.transitionLabel,
      sfxKey: template.sfxKey,
      sfxLabel: "独立开场、强调、转场和收尾音效池",
      musicPool: `${template.slug}-speech-safe-v2`,
      musicCount: 6,
      rendererKey: template.rendererKey,
      packagePath: template.packagePath,
      coverMode: "actual-first-frame-and-standalone-cover",
      validationStatus: "published-ready",
      validationMethod: "every-decoded-frame-two-material-tests",
    },
  };
}

const finalizedTemplateSeeds: TemplateSeed[] = [
  finalizedTemplate({
    id: "tpl_viral_pulse_final",
    slug: "viral-pulse",
    name: "爆点笔记",
    coverUrl: "/template-covers/viral-pulse-cover-v23.jpg",
    description: "玫红手写错位与重点词强调，适合钩子、反差、方法和行动号召。",
    accent: "#ff287f",
    titleColor: "#fffdf8",
    panel: "rgba(24,20,22,.88)",
    titleEffect: "玫红手写错位标题 · 真实口播标题",
    subtitleEffect: "双排粗宋字幕 · 关键词玫红强调",
    transitionKey: "hard-cut-punch",
    transitionLabel: "语义节点轻推近、漂移与柔光闪切",
    sfxKey: "impact",
    rendererKey: "template-1-a080-brush-v2",
    packagePath: "templates-v2/viral-pulse/template.json",
  }),
  finalizedTemplate({
    id: "tpl_viral_template_2_final",
    slug: "template-2",
    name: "柔光叙说",
    coverUrl: "/template-covers/template-2-cover-v23.jpg",
    description: "柔粉双排与人物叙述质感，适合生活分享、服务体验和情绪口播。",
    accent: "#904565",
    titleColor: "#fffdfb",
    panel: "rgba(62,32,47,.88)",
    titleEffect: "柔粉右侧双排标题 · 内容标题优先",
    subtitleEffect: "柔粉错位字幕 · 关键词轻强调",
    transitionKey: "fade",
    transitionLabel: "语义停顿触发柔和漂移与淡出",
    sfxKey: "soft",
    rendererKey: "template-2-a080-right-v2",
    packagePath: "templates-v2/template-2/template.json",
  }),
  finalizedTemplate({
    id: "tpl_viral_template_3_final",
    slug: "template-3",
    name: "智识卡片",
    coverUrl: "/template-covers/template-3-cover-v23.jpg",
    description: "黄蓝知识卡与清晰信息层级，适合AI、课程、工具和专业分析。",
    accent: "#ffd64f",
    titleColor: "#102d3d",
    panel: "rgba(248,251,255,.94)",
    titleEffect: "黄蓝知识卡标题 · 信息层级展开",
    subtitleEffect: "卡片式粗体字幕 · 黄蓝重点词",
    transitionKey: "slide",
    transitionLabel: "章节节点触发卡片滑入与轻推近",
    sfxKey: "click",
    rendererKey: "template-3-note-card-v2",
    packagePath: "templates-v2/template-3/template.json",
  }),
  finalizedTemplate({
    id: "tpl_viral_template_4_final",
    slug: "template-4",
    name: "步骤主场",
    coverUrl: "/template-covers/template-4-cover-v23.jpg",
    description: "橙色章节与数字拆解，适合步骤、流程、实操和数字利益点。",
    accent: "#ff7849",
    titleColor: "#fffdf7",
    panel: "rgba(36,27,21,.9)",
    titleEffect: "橙色章节标题 · 自动步骤结构",
    subtitleEffect: "粗体步骤字幕 · 橙色关键词",
    transitionKey: "slide",
    transitionLabel: "步骤节点触发章节切换与轻推近",
    sfxKey: "wood",
    rendererKey: "template-4-number-chapter-v2",
    packagePath: "templates-v2/template-4/template.json",
  }),
  finalizedTemplate({
    id: "tpl_viral_template_5_final",
    slug: "template-5",
    name: "薄荷清言",
    coverUrl: "/template-covers/template-5-cover-v23.jpg",
    description: "薄荷留白与下划线逐字字幕，适合心得、健康、日常和温和知识口播。",
    accent: "#77e6bd",
    titleColor: "#ffffff",
    panel: "transparent",
    titleEffect: "薄荷留白标题 · 轻线条进入",
    subtitleEffect: "白字薄荷重点词 · 下划线逐字呈现",
    transitionKey: "fade",
    transitionLabel: "语义停顿触发柔和呼吸与淡入淡出",
    sfxKey: "soft",
    rendererKey: "template-5-mint-underline-v1",
    packagePath: "templates-v2/template-5/template.json",
  }),
  finalizedTemplate({
    id: "tpl_viral_template_6_final",
    slug: "template-6",
    name: "深度引言",
    coverUrl: "/template-covers/template-6-cover-v23.jpg",
    description: "酒红引言与编辑式观点字幕，适合行业洞察、人物故事和品牌表达。",
    accent: "#d8b36a",
    titleColor: "#fffaf0",
    panel: "rgba(82,30,48,.9)",
    titleEffect: "酒红引言标题 · 编辑式排版",
    subtitleEffect: "引言卡字幕 · 金色重点词",
    transitionKey: "fade",
    transitionLabel: "观点停顿触发克制淡出与轻漂移",
    sfxKey: "wood",
    rendererKey: "template-6-quote-editorial-v2",
    packagePath: "templates-v2/template-6/template.json",
  }),
  finalizedTemplate({
    id: "tpl_viral_template_7_final",
    slug: "template-7",
    name: "橙意画报",
    coverUrl: "/template-covers/template-7-cover-v23.jpg",
    description: "橙色分栏与杂志海报结构，适合行业趋势、品牌、设计和观点评论。",
    accent: "#ff5a36",
    titleColor: "#251b16",
    panel: "rgba(255,250,239,.94)",
    titleEffect: "橙色分栏标题 · 杂志海报结构",
    subtitleEffect: "画报式字幕 · 橙色关键词",
    transitionKey: "slide",
    transitionLabel: "内容节点触发分栏切换与海报式闪切",
    sfxKey: "bright",
    rendererKey: "template-7-split-poster-v2",
    packagePath: "templates-v2/template-7/template.json",
  }),
  finalizedTemplate({
    id: "tpl_viral_template_8_final",
    slug: "template-8",
    name: "黑白观点",
    coverUrl: "/template-covers/template-8-cover-v23.jpg",
    description: "黑白打字机与克制重点词，适合职场、复盘、认知和逻辑型口播。",
    accent: "#d8dadd",
    titleColor: "#ffffff",
    panel: "rgba(7,7,8,.72)",
    titleEffect: "黑白极简标题 · 打字机进入",
    subtitleEffect: "白色描边字幕 · 克制关键词强调",
    transitionKey: "fade",
    transitionLabel: "逻辑停顿触发极简淡切与轻推近",
    sfxKey: "click",
    rendererKey: "template-8-typewriter-minimal-v2",
    packagePath: "templates-v2/template-8/template.json",
  }),
];

const previousTemplateSeeds: TemplateSeed[] = [
  {
    id: "tpl_viral_luxury_white_bilingual",
    slug: "clean-green",
    category: "viral_video",
    name: "轻奢白·双语",
    version: 19,
    previewUrl: "https://action-public.meitudata.com/video/689d49fa781365084pBCVGVw3u9974.mp4",
    coverUrl: "",
    description: "开场上白下黄双行毛笔标题、短句双语字幕、语义关键词标黄与自适应转场，适合真人口播。",
    config: {
      accent: "#f5cd3b",
      titleColor: "#ffffff",
      panel: "transparent",
      titleEffect: "开场上白下黄双行毛笔标题，约 2.6 秒后退出",
      subtitleEffect: "短句大字幕 · 中英双语",
      transitionKey: "light-luxury-white-bilingual-v1",
      transitionLabel: "语义节点轻推近、左右漂移与柔光闪切",
      sfxKey: "clean-green-owned-pool",
      sfxLabel: "独立开场、关键词、转场与收尾音效池",
      musicPool: "clean-green-light-luxury-v1",
      learningMethod: "every-decoded-frame-v19",
      validationStatus: "published-ready",
      packagePath: "templates-v2/clean-green/template.json",
    },
  },
  {
    id: "tpl_viral_warm_gold",
    slug: "warm-gold",
    category: "viral_video",
    name: "青绿知识·双语",
    version: 2,
    previewUrl: "https://action-public.meitudata.com/video/689d4b87827624340I8IjRwLiG5755.mp4",
    coverUrl: "",
    description: "青绿与白色双行知识标题、打字机式双语字幕、语义关键词青绿强调，适合知识型真人口播。",
    config: {
      accent: "#71efd0",
      titleColor: "#fffefa",
      panel: "transparent",
      titleEffect: "左上固定双行知识标题 · 青绿与白色组合 · 淡入缩放",
      subtitleEffect: "打字机逐字出现 · 青绿关键词 · 英文副行",
      transitionKey: "warm-gold-mint-knowledge-v1",
      transitionLabel: "语义节点触发 · 轻推近 · 左右漂移 · 柔和闪切",
      sfxKey: "warm-gold-owned-pool",
      sfxLabel: "青绿知识独立开场、强调、转场和收尾音效池",
      validationStatus: "published-ready",
      packagePath: "templates-v2/warm-gold/template.json",
    },
  },
  {
    id: "tpl_viral_bold_yellow_white",
    slug: "bold-yellow-white",
    category: "viral_video",
    name: "醒目黄白",
    version: 2,
    previewUrl: "https://action-public.meitudata.com/video/693bcecd2740535809WJejI0Dz8630.mp4",
    coverUrl: "",
    description: "顶部双行白色冲击标题、中下部黄白短句、语义关键词标黄和节奏转场，适合强节奏真人口播。",
    config: {
      accent: "#fff300",
      titleColor: "#fffdf7",
      panel: "transparent",
      titleEffect: "顶部双行白色斜体标题 · 重黑描边 · 分行冲入",
      subtitleEffect: "中下部黄白短句 · 重点词语义标黄 · 逐字冲入",
      transitionKey: "bold-yellow-white-impact-v1",
      transitionLabel: "场景变化、长停顿或节奏点触发 · 轻推近 · 左右漂移 · 柔光闪切",
      sfxKey: "bold-yellow-white-owned-pool",
      sfxLabel: "醒目黄白独立开场、强调、转场和收尾音效池",
      validationStatus: "published-ready",
      packagePath: "templates-v2/bold-yellow-white/template.json",
    },
  },
  {
    id: "tpl_viral_high_red",
    slug: "high-red",
    category: "viral_video",
    name: "高级红",
    version: 1,
    previewUrl: "https://action-public.meitudata.com/video/6881a63f229982215NNFeOVoJ96101.mp4",
    coverUrl: "",
    description: "红色重点字幕与高能闪切，适合促销和强钩子内容。",
    config: { transitionKey: "flash", sfxKey: "impact", accent: "#ffe8d9" },
  },
];

// The finalized eight templates are additions. Keep the four existing viral
// templates first so existing users retain their familiar choices.
export const templateSeeds: TemplateSeed[] = [
  ...previousTemplateSeeds,
  ...finalizedTemplateSeeds,
];
