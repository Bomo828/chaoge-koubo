import {copyFile, mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const [jobArg, sourceArg, outputDirArg] = process.argv.slice(2);
if (!jobArg || !sourceArg || !outputDirArg) {
  throw new Error("用法：node scripts/timeline-from-job.mjs <job.json> <source.mp4> <output-dir>");
}

const jobPath = path.resolve(jobArg);
const sourcePath = path.resolve(sourceArg);
const outputDir = path.resolve(outputDirArg);
await mkdir(outputDir, {recursive: true});
await copyFile(sourcePath, path.join(outputDir, "source.mp4"));

const job = JSON.parse(await readFile(jobPath, "utf8"));
const captions = Array.isArray(job.captions) ? job.captions : [];
if (!captions.length) {
  throw new Error("任务结果没有可用字幕。");
}

const preferredKeywords = [
  "免费", "优惠", "技能", "培训", "岗位", "基础", "实用", "咨询", "开始",
  "老师", "钟智联", "会计", "电商", "外贸", "课程", "练熟", "职场",
];
const keywordFor = (value) => {
  const compact = String(value ?? "").replace(/[\s，。！？；：、]/g, "");
  const preferred = preferredKeywords.find((item) => compact.includes(item));
  if (preferred) return preferred;
  if (compact.length <= 4) return compact;
  const length = compact.length >= 10 ? 4 : 3;
  const start = Math.max(0, Math.floor((compact.length - length) / 2));
  return compact.slice(start, start + length);
};

const styledCaptions = captions.map((caption, index) => {
  const isAnchor = index % 2 === 0;
  const next = captions[index + 1];
  const compactLength = String(caption.text ?? "").replace(/[^\p{L}\p{N}]/gu, "").length;
  const nextLength = String(next?.text ?? "").replace(/[^\p{L}\p{N}]/gu, "").length;
  const canPair = isAnchor && next && compactLength <= 8 && nextLength <= 8;
  return {
    ...caption,
    keyword: keywordFor(caption.text),
    role: isAnchor ? "anchor" : "focus",
    layout: "center",
    animation: isAnchor ? "fade-rise" : "word-reveal",
    sectionEmphasis: index > 0 && index % 6 === 5,
    displayEnd: canPair
      ? Math.max(Number(caption.end) || 0, Number(next.end) || 0)
      : Number(caption.end) || 0,
  };
});
const duration = Number(job.metadata?.duration) || Math.max(...styledCaptions.map((item) => Number(item.end) || 0));
const origins = ["50% 44%", "46% 42%", "54% 43%"];
const scales = [1, 1.055, 1.025, 1.07];
const cameraCues = styledCaptions.filter((_, index) => index % 2 === 0).map((caption, pairIndex) => {
  const endCaption = styledCaptions[Math.min(pairIndex * 2 + 1, styledCaptions.length - 1)];
  return {
    start: Number(caption.start),
    end: Math.min(duration, Number(endCaption.end)),
    scale: scales[pairIndex % scales.length],
    origin: origins[pairIndex % origins.length],
  };
});
const transitionStyles = ["soft-punch", "drift-left", "drift-right", "soft-flash"];
const transitionCues = styledCaptions
  .filter((caption, index) => index > 0 && index % 2 === 0 && Number(caption.start) < duration - .8)
  .map((caption, index) => ({
    start: Number(caption.start),
    duration: [0.34, 0.28, 0.28, 0.24][index % 4],
    style: transitionStyles[index % transitionStyles.length],
    intensity: [0.72, 0.58, 0.58, 0.52][index % 4],
  }));

const timeline = {
  version: 2,
  sourceFile: "source.mp4",
  bgmFile: "music/simple_loop.ogg",
  bgmVolume: 0.035,
  sfxCues: [
    {start: 0.08, file: "sfx/light-luxury-local/swish01.ogg", volume: 0.2, playbackRate: 0.96},
    ...styledCaptions.filter((_, index) => index > 0 && index % 4 === 0).slice(0, 4).map((caption, index) => ({
      start: Number(caption.start),
      file: `sfx/light-luxury-local/${index % 2 ? "taphigh01" : "click-up01"}.ogg`,
      volume: 0.11,
    })),
    {start: Math.max(0, duration - .72), file: "sfx/light-luxury-local/bell02.ogg", volume: 0.17},
  ],
  duration,
  fps: 30,
  title: String(job.title || "真实内容，值得看见"),
  merchantName: String(job.merchant?.name || ""),
  coverTime: 0,
  captions: styledCaptions,
  cameraCues,
  transitionCues,
  chapters: [],
  cards: [],
  theme: {
    name: "轻奢白·双语 · 完整字幕版",
    background: "#050505",
    foreground: "#ffffff",
    accent: "#ffef00",
    accentSoft: "#ffef0033",
    titlePosition: "top",
    subtitlePosition: "middle",
    captionMode: "kinetic-yellow-white",
    keywordColor: "#ffef00",
    headlineDuration: 2.6,
    headlineTop: 220,
    headlinePersistent: true,
    headlineAnimation: "staggered-punch",
    headlineFontSize: 148,
    headlineLineGap: -12,
    captionSafeInset: 96,
    captionMaxWidth: 888,
    captionLineMaxChars: 8,
  },
};

await writeFile(path.join(outputDir, "timeline.json"), `${JSON.stringify(timeline, null, 2)}\n`, "utf8");
process.stdout.write(JSON.stringify({ok: true, captions: styledCaptions.length, duration}));
