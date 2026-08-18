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

type PublishedViralTemplate = {
  slug: `template-${9 | 10 | 11 | 12}`;
  name: string;
  version: number;
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
};

function publishedTemplate(template: PublishedViralTemplate): TemplateSeed {
  return {
    id: `tpl_viral_${template.slug.replace("-", "_")}`,
    slug: template.slug,
    category: "viral_video",
    name: template.name,
    version: template.version,
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
      sfxLabel: "模板独占语义音效池",
      rendererKey: template.rendererKey,
      packagePath: `templates-v2/${template.slug}/template.json`,
      coverMode: "actual-first-frame-and-standalone-cover",
      validationStatus: "published",
      validationMethod: "every-decoded-frame-two-material-tests",
    },
  };
}

export const templateSeeds: TemplateSeed[] = [
  publishedTemplate({
    slug: "template-9",
    name: "红白双语",
    version: 22,
    coverUrl: "/template-covers/template-9.jpg",
    description: "红白编辑式双语字幕、语义重点词和克制镜头变化，适合观点与知识口播。",
    accent: "#9f2538",
    titleColor: "#fffdf9",
    panel: "transparent",
    titleEffect: "红白双排常驻标题",
    subtitleEffect: "红白双语字幕 · 关键词语义强调",
    transitionKey: "fade",
    transitionLabel: "语义节点触发编辑式切换",
    sfxKey: "soft",
    rendererKey: "template-9-red-white-narrative-v1",
  }),
  publishedTemplate({
    slug: "template-10",
    name: "黄白大字双语",
    version: 11,
    coverUrl: "/template-covers/template-10.jpg",
    description: "大号黄白手书标题、双语字幕和语义大字，适合技能、步骤和效率口播。",
    accent: "#fff300",
    titleColor: "#fffdf8",
    panel: "transparent",
    titleEffect: "黄白大字双排手书标题",
    subtitleEffect: "黄白双语字幕 · 语义大字强调",
    transitionKey: "slide",
    transitionLabel: "语义停顿触发轻切与景别变化",
    sfxKey: "impact",
    rendererKey: "template-10-yellow-white-bilingual-v1",
  }),
  publishedTemplate({
    slug: "template-11",
    name: "青白高亮双语",
    version: 13,
    coverUrl: "/template-covers/template-11.jpg",
    description: "青白粗体标题、逐字双语字幕和放大关键词，适合清晰直接的知识口播。",
    accent: "#79f4e4",
    titleColor: "#ffffff",
    panel: "transparent",
    titleEffect: "青白高亮常驻标题",
    subtitleEffect: "逐字双语字幕 · 青色关键词放大",
    transitionKey: "zoom",
    transitionLabel: "语义节点触发克制景别切换",
    sfxKey: "click",
    rendererKey: "template-11-cyan-white-bilingual-v1",
  }),
  publishedTemplate({
    slug: "template-12",
    name: "黑黄聚焦双语",
    version: 12,
    coverUrl: "/template-covers/template-12.jpg",
    description: "黑黄粗体双语字幕、语义景别和单次柔边聚焦，适合培训与场景讲解。",
    accent: "#fff000",
    titleColor: "#ffffff",
    panel: "rgba(5,5,5,.82)",
    titleEffect: "黑底黄白双排常驻标题",
    subtitleEffect: "黑黄双语字幕 · 单次语义聚焦",
    transitionKey: "zoom",
    transitionLabel: "语义节点景别切换与柔边聚焦",
    sfxKey: "bright",
    rendererKey: "template-12-black-yellow-focus-v1",
  }),
];
