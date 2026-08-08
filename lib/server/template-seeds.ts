export type TemplateSeed = {
  id: string;
  slug: string;
  category: "viral_video" | "image" | "video";
  name: string;
  version: number;
  previewUrl: string;
  description: string;
  config: Record<string, unknown>;
};

export const templateSeeds: TemplateSeed[] = [
  {
    id: "tpl_viral_luxury_white_bilingual",
    slug: "clean-green",
    category: "viral_video",
    name: "轻奢白·双语",
    version: 19,
    previewUrl: "https://action-public.meitudata.com/video/689d49fa781365084pBCVGVw3u9974.mp4",
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
      validationStatus: "local-approved-cloud-sync-pending",
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
    description: "红色重点字幕与高能闪切，适合促销和强钩子内容。",
    config: { transitionKey: "flash", sfxKey: "impact", accent: "#ffe8d9" },
  },
];
