export type ViralLineMode = "single" | "two-line";

export type ViralLineLayout = {
  mode: ViralLineMode;
  lines: string[];
};

const TITLE_PROTECTED_PHRASES = [
  // Protect lexical atoms, not an entire headline phrase.  Protecting
  // “商家入驻新机会” as one range made every natural two-row break illegal
  // and could force the renderer to split the word “入驻”.
  "商家", "入驻", "新机会", "机会", "开放入驻", "首批类目", "激励翻倍",
  "华为", "小红书", "朋友圈", "直播间",
  "微信支付", "人工智能", "对口型", "一键网感", "超级剪辑",
  "市场动态", "会员中心", "短视频", "供应链", "创作平台",
  "酒店景区旅行社", "酒店", "景区", "旅行社", "体育场馆",
];

const CAPTION_PROTECTED_PHRASES = [
  ...TITLE_PROTECTED_PHRASES,
  "酒店景区旅行社", "酒店", "景区", "旅行社", "体育场馆",
  "用户", "客户", "品牌", "平台", "政策", "活动", "方案", "功能",
  "服务", "视频", "内容", "账号", "作品", "关键词", "背景音乐",
];

const SEMANTIC_MARKERS = [
  "商家入驻机会", "商家入驻", "开放入驻", "首批类目", "激励翻倍",
  "如果", "但是", "不过", "所以", "然后", "因为", "同时", "以及",
  "而且", "而是", "就是", "可以", "需要", "通过", "这样", "比如",
  "例如", "首先", "其次", "最后", "想要", "怎么", "如何", "为什么",
  "商家", "用户", "客户", "品牌", "平台", "机会", "政策", "活动",
];

const INVALID_LEFT_ENDINGS = ["的", "和", "与", "就", "都", "也", "在", "让", "把", "被", "从", "向", "为", "及"];
const INVALID_RIGHT_STARTS = ["的", "和", "与", "就", "都", "也", "才", "了", "着", "过"];

function compactChinese(value: string) {
  return value.replace(/[\s，。！？；：、,.!?;:'"“”‘’（）()【】\[\]《》<>—…·|｜-]/g, "").trim();
}

function compactEnglish(value: string) {
  return value.replace(/[|｜]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Remove common AI headline inversions before visual line breaking.  The title
 * still comes from the spoken content; this only restores natural Chinese
 * modifier order and avoids treating a verb as a dangling noun modifier.
 */
export function normalizeViralTitleSyntax(value: string) {
  let title = value.replace(/\s+/g, "").replace(/[，。！？；：、,.!?;:]+$/g, "").trim();
  title = title.replace(
    /^(.{2,8}?)(激励|扶持|补贴)(商家|企业|用户)(入驻|增长|获客)机会$/u,
    "$1$3$4新机会",
  );
  title = title.replace(/(机会)机会$/u, "$1");
  return title;
}

function isEnglish(value: string) {
  const cjk = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = value.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || [];
  return latin.length * 2 > cjk;
}

function cleanPreferredLines(value: unknown, english: boolean) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => english ? compactEnglish(item) : compactChinese(item))
    .filter(Boolean)
    .slice(0, 2);
}

function protectedRanges(text: string, phrases: string[]) {
  const ranges: Array<[number, number]> = [];
  for (const phrase of phrases) {
    let cursor = text.indexOf(phrase);
    while (cursor >= 0) {
      ranges.push([cursor, cursor + phrase.length]);
      cursor = text.indexOf(phrase, cursor + 1);
    }
  }
  for (const match of text.matchAll(/[A-Za-z]+(?:[A-Za-z0-9+._-]*[A-Za-z0-9])?|\d+(?:\.\d+)?(?:%|万|亿|元|折)?/g)) {
    const start = match.index ?? 0;
    ranges.push([start, start + match[0].length]);
  }
  return ranges;
}

function safeBreak(position: number, ranges: Array<[number, number]>) {
  return !ranges.some(([start, end]) => start < position && position < end);
}

function semanticPositions(text: string) {
  const positions = new Set<number>();
  for (const marker of SEMANTIC_MARKERS) {
    let cursor = text.indexOf(marker);
    while (cursor >= 0) {
      if (cursor > 0) positions.add(cursor);
      if (cursor + marker.length < text.length) positions.add(cursor + marker.length);
      cursor = text.indexOf(marker, cursor + 1);
    }
  }
  return positions;
}

function validPreferredLines(text: string, preferred: unknown, ranges: Array<[number, number]>, minSide: number) {
  const lines = cleanPreferredLines(preferred, false);
  if (lines.length !== 2 || lines.join("") !== text) return [];
  const position = lines[0].length;
  if (position < minSide || text.length - position < minSide || !safeBreak(position, ranges)) return [];
  return lines;
}

function splitChinese(text: string, maxChars: number, preferred: unknown, phrases: string[], forceTwoLines: boolean): ViralLineLayout {
  if (!text) return { mode: "single", lines: [] };
  if (!forceTwoLines && text.length <= maxChars) return { mode: "single", lines: [text] };

  const minSide = Math.max(2, Math.min(4, Math.floor(text.length / 3)));
  const ranges = protectedRanges(text, phrases);
  const preferredLines = validPreferredLines(text, preferred, ranges, minSide);
  if (preferredLines.length === 2) return { mode: "two-line", lines: preferredLines };

  const midpoint = text.length / 2;
  const semantic = semanticPositions(text);
  const candidates = Array.from({ length: Math.max(0, text.length - minSide * 2 + 1) }, (_, index) => index + minSide)
    .filter((position) => position <= text.length - minSide && safeBreak(position, ranges));
  const splitAt = (candidates.length ? candidates : [Math.max(1, Math.min(text.length - 1, Math.round(midpoint)))])
    .sort((left, right) => {
      const score = (position: number) => {
        const leftText = text.slice(0, position);
        const rightText = text.slice(position);
        const overflow = Math.max(0, leftText.length - maxChars) + Math.max(0, rightText.length - maxChars);
        const dangling = INVALID_LEFT_ENDINGS.some((item) => leftText.endsWith(item)) ? 10 : 0;
        const leading = INVALID_RIGHT_STARTS.some((item) => rightText.startsWith(item)) ? 10 : 0;
        const semanticBonus = semantic.has(position) ? -7 : 0;
        return overflow * 12 + Math.abs(position - midpoint) + dangling + leading + semanticBonus;
      };
      return score(left) - score(right);
    })[0];
  return { mode: "two-line", lines: [text.slice(0, splitAt), text.slice(splitAt)] };
}

function splitEnglish(text: string, maxWords: number, preferred: unknown, forceTwoLines: boolean): ViralLineLayout {
  const words = compactEnglish(text).split(" ").filter(Boolean);
  if (!words.length) return { mode: "single", lines: [] };
  if (!forceTwoLines && words.length <= maxWords) return { mode: "single", lines: [words.join(" ")] };
  const directed = cleanPreferredLines(preferred, true);
  if (directed.length === 2 && compactEnglish(directed.join(" ")) === words.join(" ")) {
    return { mode: "two-line", lines: directed };
  }
  const midpoint = Math.ceil(words.length / 2);
  return { mode: "two-line", lines: [words.slice(0, midpoint).join(" "), words.slice(midpoint).join(" ")] };
}

export function planViralTitleLayout(value: string, preferredLines?: unknown, forceTwoLines = false): ViralLineLayout & { title: string; serializedTitle: string } {
  const explicit = value.split(/[|｜]/).map((line) => line.trim()).filter(Boolean);
  const english = isEnglish(value);
  const source = explicit.join("") || value;
  const text = english ? compactEnglish(explicit.join(" ") || value) : compactChinese(normalizeViralTitleSyntax(source));
  const preferred = explicit.length === 2 ? explicit : preferredLines;
  const layout = english
    ? splitEnglish(text, 6, preferred, explicit.length === 2 || forceTwoLines || text.split(" ").length >= 6)
    : splitChinese(text, 9, preferred, TITLE_PROTECTED_PHRASES, explicit.length === 2 || forceTwoLines || text.length >= 8);
  return {
    ...layout,
    title: text,
    serializedTitle: layout.lines.join("｜"),
  };
}

export function planViralCaptionLayout(value: string, preferredLines?: unknown, maxChars = 10): ViralLineLayout {
  const english = isEnglish(value);
  const text = english ? compactEnglish(value) : compactChinese(value);
  if (english) return splitEnglish(text, Math.max(4, maxChars), preferredLines, text.split(" ").length > maxChars);
  return splitChinese(text, Math.max(6, maxChars), preferredLines, CAPTION_PROTECTED_PHRASES, text.length > maxChars);
}
