import { planViralCaptionLayout } from "./viral-semantic-layout";
import type { ViralCaptionPlanItem } from "./viral-workflow";

export type ViralCaptionTemplateContract = {
  templateId: string;
  lineMaxUnits: number;
  cueMaxUnits: number;
  maxLines: number;
  overflowPolicy: "split-timed-cue";
};

const TEMPLATE_CAPTION_CONTRACTS: Record<string, ViralCaptionTemplateContract> = {
  "template-9": {
    templateId: "template-9",
    lineMaxUnits: 7,
    cueMaxUnits: 14,
    maxLines: 2,
    overflowPolicy: "split-timed-cue",
  },
  "template-10": {
    templateId: "template-10",
    lineMaxUnits: 8,
    cueMaxUnits: 14,
    maxLines: 2,
    overflowPolicy: "split-timed-cue",
  },
  "template-11": {
    templateId: "template-11",
    lineMaxUnits: 10,
    cueMaxUnits: 18,
    maxLines: 2,
    overflowPolicy: "split-timed-cue",
  },
  "template-12": {
    templateId: "template-12",
    lineMaxUnits: 8,
    cueMaxUnits: 16,
    maxLines: 2,
    overflowPolicy: "split-timed-cue",
  },
};

const DEFAULT_CAPTION_CONTRACT: ViralCaptionTemplateContract = {
  templateId: "template-9",
  lineMaxUnits: 8,
  cueMaxUnits: 16,
  maxLines: 2,
  overflowPolicy: "split-timed-cue",
};

const SPLIT_MARKERS = [
  "但是", "不过", "所以", "然后", "因为", "如果", "同时", "以及",
  "而且", "而是", "就是", "可以", "需要", "通过", "这样", "比如",
  "例如", "首先", "其次", "最后", "想要", "怎么", "如何", "为什么",
  "特点就是", "口播视频", "一键网感", "超级剪辑",
];

const PROTECTED_CAPTION_PHRASES = [
  "AI剪辑", "AI超级剪辑", "口播视频", "对口型", "一键网感", "超级剪辑",
  "视频素材", "图片素材", "克隆你的声音", "网感十足",
  "微信支付", "人工智能", "小红书", "朋友圈", "直播间", "短视频",
  "商家", "入驻", "新机会", "开放入驻", "首批类目", "激励翻倍",
  "酒店景区旅行社", "体育场馆", "市场动态", "会员中心", "供应链",
];

const INVALID_LEFT_ENDINGS = ["的", "了", "着", "过", "和", "与", "就", "都", "也", "在", "让", "把", "被", "从", "向", "为", "及"];
const INVALID_RIGHT_STARTS = ["的", "和", "与", "就", "都", "也", "才", "了", "着", "过"];

function speechLanguage(value: string) {
  const cjk = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = value.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || [];
  return latin.length * 2 > cjk ? "en" as const : "zh" as const;
}

export function normalizeViralCaptionText(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  const normalized = speechLanguage(text) === "en"
    ? text.replace(/\s+/g, " ")
    : text.replace(/\s+/g, "");
  return normalized.replace(/^[，,.。！？!?；;：:、\s]+|[，,.。！？!?；;：:、\s]+$/gu, "").trim();
}

function comparableCaptionText(value: unknown) {
  return normalizeViralCaptionText(value)
    .toLocaleLowerCase()
    .replace(/[\s，。！？；：、,.!?;:'"“”‘’（）()【】\[\]《》<>—…·|｜-]/g, "");
}

export function viralCaptionUnitCount(value: unknown) {
  const text = normalizeViralCaptionText(value);
  if (!text) return 0;
  if (speechLanguage(text) === "en") {
    return (text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
  }
  return (text.match(/[\u3400-\u9fffA-Za-z0-9]/g) || []).length;
}

export function viralCaptionTemplateContract(templateId: unknown): ViralCaptionTemplateContract {
  const id = typeof templateId === "string" ? templateId.trim() : "";
  return TEMPLATE_CAPTION_CONTRACTS[id] || { ...DEFAULT_CAPTION_CONTRACT, templateId: id || DEFAULT_CAPTION_CONTRACT.templateId };
}

export function viralCaptionConstraintPrompt(contract: ViralCaptionTemplateContract) {
  return `当前模板=${contract.templateId}；每屏字幕最多${contract.maxLines}行；每行最多${contract.lineMaxUnits}个中文/字母数字单位；每屏最多${contract.cueMaxUnits}个单位。请先按全文语义决定每屏覆盖的连续词编号，再用l规划屏内换行。所有字幕必须按词编号完整覆盖原口播，不能遗漏、重复、改序；可以跨越上游ASR句段重新组合。`;
}

function protectedRanges(text: string, keyword: string) {
  const ranges: Array<[number, number]> = [];
  for (const phrase of PROTECTED_CAPTION_PHRASES) {
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
  if (keyword) {
    let cursor = text.indexOf(keyword);
    while (cursor >= 0) {
      ranges.push([cursor, cursor + keyword.length]);
      cursor = text.indexOf(keyword, cursor + 1);
    }
  }
  return ranges;
}

function safeBreak(position: number, ranges: Array<[number, number]>) {
  return !ranges.some(([start, end]) => start < position && position < end);
}

function splitCaptionBeats(text: string, keyword: string, cueMaxUnits: number) {
  const source = normalizeViralCaptionText(text);
  if (!source || viralCaptionUnitCount(source) <= cueMaxUnits) return source ? [source] : [];
  if (speechLanguage(source) === "en") {
    const words = source.split(/\s+/).filter(Boolean);
    const beats: string[] = [];
    for (let cursor = 0; cursor < words.length;) {
      let end = Math.min(words.length, cursor + cueMaxUnits);
      if (end < words.length) {
        const conjunction = words.slice(cursor + 3, end).findLastIndex((word) => /^(?:and|but|or|because|so|while|when|that|which|if|then|also)$/i.test(word));
        if (conjunction >= 0) end = cursor + 3 + conjunction;
      }
      if (end <= cursor) end = Math.min(words.length, cursor + cueMaxUnits);
      beats.push(words.slice(cursor, end).join(" "));
      cursor = end;
    }
    return beats;
  }

  const beats: string[] = [];
  let remaining = source;
  while (viralCaptionUnitCount(remaining) > cueMaxUnits) {
    const ranges = protectedRanges(remaining, keyword);
    const markerPositions = new Set<number>();
    for (const marker of SPLIT_MARKERS) {
      let cursor = remaining.indexOf(marker);
      while (cursor >= 0) {
        if (cursor > 0) markerPositions.add(cursor);
        if (cursor + marker.length < remaining.length) markerPositions.add(cursor + marker.length);
        cursor = remaining.indexOf(marker, cursor + 1);
      }
    }
    for (let index = 1; index < remaining.length; index += 1) {
      if (/[，,。！？!?；;：:、]/.test(remaining[index - 1])) markerPositions.add(index);
    }
    const candidates = Array.from({ length: Math.max(0, remaining.length - 1) }, (_, index) => index + 1)
      .filter((position) => safeBreak(position, ranges))
      .filter((position) => viralCaptionUnitCount(remaining.slice(0, position)) <= cueMaxUnits)
      .filter((position) => viralCaptionUnitCount(remaining.slice(0, position)) >= Math.min(4, cueMaxUnits));
    const splitAt = (candidates.length ? candidates : [Math.min(remaining.length - 1, cueMaxUnits)])
      .sort((left, right) => {
        const score = (position: number) => (
          (cueMaxUnits - viralCaptionUnitCount(remaining.slice(0, position))) * 3
          + (INVALID_LEFT_ENDINGS.some((item) => remaining.slice(0, position).endsWith(item)) ? 10 : 0)
          + (INVALID_RIGHT_STARTS.some((item) => remaining.slice(position).startsWith(item)) ? 10 : 0)
          - (markerPositions.has(position) ? 8 : 0)
        );
        return score(left) - score(right);
      })[0];
    const beat = normalizeViralCaptionText(remaining.slice(0, splitAt));
    remaining = normalizeViralCaptionText(remaining.slice(splitAt));
    if (!beat || !remaining) break;
    beats.push(beat);
  }
  if (remaining) beats.push(remaining);
  return beats.length ? beats : [source];
}

function normalizeDirectedGroups(value: unknown, text: string, keyword: string, contract: ViralCaptionTemplateContract) {
  if (!Array.isArray(value)) return [];
  const groups = value.slice(0, 8).flatMap((group) => {
    if (!Array.isArray(group)) return [];
    const lines = group
      .filter((line): line is string => typeof line === "string")
      .map(normalizeViralCaptionText)
      .filter(Boolean)
      .slice(0, contract.maxLines);
    return lines.length ? [lines] : [];
  });
  if (!groups.length) return [];
  if (comparableCaptionText(groups.flat().join("")) !== comparableCaptionText(text)) return [];
  if (groups.some((lines) => lines.some((line) => viralCaptionUnitCount(line) > contract.lineMaxUnits))) return [];
  if (groups.some((lines) => viralCaptionUnitCount(lines.join("")) > contract.cueMaxUnits)) return [];
  const flattenedLines = groups.flat();
  const boundaries = flattenedLines.slice(0, -1).map((_, index) => flattenedLines.slice(0, index + 1).join("").length);
  const protectedSpans = protectedRanges(text, keyword);
  if (boundaries.some((boundary) => !safeBreak(boundary, protectedSpans))) return [];
  if (typeof Intl.Segmenter === "function" && speechLanguage(text) === "zh") {
    const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
    const wordBoundaries = new Set<number>([0, text.length]);
    for (const segment of segmenter.segment(text)) {
      wordBoundaries.add(segment.index);
      wordBoundaries.add(segment.index + segment.segment.length);
    }
    if (boundaries.some((boundary) => !wordBoundaries.has(boundary))) return [];
  }
  if (boundaries.some((boundary) => (
    INVALID_LEFT_ENDINGS.some((item) => text.slice(0, boundary).endsWith(item))
    || INVALID_RIGHT_STARTS.some((item) => text.slice(boundary).startsWith(item))
  ))) return [];
  return groups;
}

function splitTranslation(value: string, weights: number[]) {
  const translation = value.replace(/\s+/g, " ").trim();
  if (!translation) return weights.map(() => "");
  if (weights.length <= 1) return [translation];
  const words = translation.split(" ").filter(Boolean);
  if (words.length < weights.length) return [translation, ...weights.slice(1).map(() => "")];
  const total = Math.max(1, weights.reduce((sum, weight) => sum + weight, 0));
  const boundaries = [0];
  let consumed = 0;
  weights.slice(0, -1).forEach((weight) => {
    consumed += weight;
    const target = Math.round(words.length * consumed / total);
    boundaries.push(Math.max(boundaries.at(-1)! + 1, Math.min(words.length - 1, target)));
  });
  boundaries.push(words.length);
  return weights.map((_, index) => words.slice(boundaries[index], boundaries[index + 1]).join(" "));
}

function timedCaptionRanges(item: ViralCaptionPlanItem, weights: number[]) {
  const start = Math.max(0, Number(item.start) || 0);
  const end = Math.max(start + 0.04, Number(item.end) || start + 0.5);
  const words = (item.words || [])
    .filter((word) => word && word.text && Number(word.end) > Number(word.start))
    .map((word) => ({
      ...word,
      start: Math.max(start, Number(word.start)),
      end: Math.min(end, Math.max(Number(word.start) + 0.01, Number(word.end))),
    }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (weights.length <= 1) return [{ start, end, words }];
  // A sentence timestamp only proves when the whole sentence was spoken.  It
  // does not prove where an internal visual line break belongs.  Returning the
  // same full range for every beat used to create several simultaneous cues;
  // estimating the split from character counts caused visible subtitle drift.
  // Only real word timestamps may promote visual rows into consecutive cues.
  if (!words.length) return [];

  const wordWeights = words.map((word) => Math.max(1, viralCaptionUnitCount(word.text)));
  const totalWordWeight = Math.max(1, wordWeights.reduce((sum, weight) => sum + weight, 0));
  const totalBeatWeight = Math.max(1, weights.reduce((sum, weight) => sum + weight, 0));
  const ranges: Array<{ start: number; end: number; words: typeof words }> = [];
  let beatWeight = 0;
  let wordStartIndex = 0;
  let rangeStart = start;
  for (let beatIndex = 0; beatIndex < weights.length; beatIndex += 1) {
    beatWeight += weights[beatIndex];
    if (beatIndex === weights.length - 1) {
      ranges.push({ start: rangeStart, end, words: words.slice(wordStartIndex) });
      break;
    }
    const target = totalWordWeight * beatWeight / totalBeatWeight;
    let cumulative = wordWeights.slice(0, wordStartIndex).reduce((sum, weight) => sum + weight, 0);
    let boundaryIndex = wordStartIndex;
    while (boundaryIndex < words.length - 1 && cumulative + wordWeights[boundaryIndex] < target) {
      cumulative += wordWeights[boundaryIndex];
      boundaryIndex += 1;
    }
    const rangeEnd = Math.max(rangeStart + 0.04, words[boundaryIndex].end);
    ranges.push({ start: rangeStart, end: Math.min(end, rangeEnd), words: words.slice(wordStartIndex, boundaryIndex + 1) });
    wordStartIndex = boundaryIndex + 1;
    rangeStart = words[wordStartIndex]?.start ?? rangeEnd;
  }
  return ranges.length === weights.length ? ranges : [];
}

/**
 * Compile one semantic AI decision into the selected template's immutable
 * caption capacity. AI may propose the groups, but timing and safety remain
 * deterministic and grounded in the original caption range.
 */
export function compileViralCaptionCues(
  captions: ViralCaptionPlanItem[],
  templateId: unknown,
  directedGroups: unknown[] = [],
) {
  const contract = viralCaptionTemplateContract(templateId);
  return captions.flatMap((raw, captionIndex) => {
    const item = { ...raw };
    const text = normalizeViralCaptionText(item.text);
    if (!text) return [];
    const keyword = normalizeViralCaptionText(item.keyword);
    const aiGroups = normalizeDirectedGroups(directedGroups[captionIndex], text, keyword, contract);
    const beats = aiGroups.length
      ? aiGroups.map((lines) => ({ text: lines.join(""), lines }))
      : splitCaptionBeats(text, keyword, contract.cueMaxUnits).map((beat) => {
        const layout = planViralCaptionLayout(beat, undefined, contract.lineMaxUnits);
        return { text: beat, lines: layout.lines.slice(0, contract.maxLines) };
      });
    const requestedWeights = beats.map((beat) => Math.max(1, viralCaptionUnitCount(beat.text)));
    const requestedRanges = timedCaptionRanges(item, requestedWeights);
    const groundedBeats = requestedRanges.length === beats.length
      ? beats
      : [{
        text,
        lines: planViralCaptionLayout(text, item.captionLines, contract.lineMaxUnits).lines.slice(0, contract.maxLines),
      }];
    const weights = groundedBeats.map((beat) => Math.max(1, viralCaptionUnitCount(beat.text)));
    const translations = splitTranslation(String(item.translation || ""), weights);
    const ranges = groundedBeats === beats ? requestedRanges : timedCaptionRanges(item, weights);
    return groundedBeats.map((beat, beatIndex) => {
      const range = ranges[beatIndex] || ranges.at(-1)!;
      const containsKeyword = Boolean(keyword) && comparableCaptionText(beat.text).includes(comparableCaptionText(keyword));
      const cue: ViralCaptionPlanItem = {
        ...item,
        start: Number(range.start.toFixed(3)),
        end: Number(Math.max(range.start + 0.04, range.end).toFixed(3)),
        text: beat.text,
        ...(range.words.length ? { words: range.words } : { words: undefined }),
        captionLineMode: beat.lines.length > 1 ? "two-line" : "single",
        captionLines: beat.lines,
        ...(translations[beatIndex] ? { translation: translations[beatIndex] } : { translation: undefined }),
        ...(containsKeyword ? {} : {
          keyword: undefined,
          keywordOrigin: "none",
          keywordSfx: false,
          keywordImportance: undefined,
        }),
        ...(beatIndex > 0 ? {
          cameraIntent: "hold",
          transitionIntent: "none",
          ...(containsKeyword ? {} : { sfxRole: "none" }),
        } : {}),
      };
      return cue;
    });
  });
}
