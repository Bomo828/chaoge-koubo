import { createHash } from "node:crypto";
import { getMemberSession } from "../../../member-session";
import { AiProviderError, aiErrorResponse, lk888Fetch } from "../../../../lib/lk888";
import { repairEnglishWordFragments, segmentViralCaptions } from "../../../../lib/viral-caption-segmentation";
import { planViralCaptionLayout, planViralTitleLayout } from "../../../../lib/viral-semantic-layout";
import {
  buildViralDirectorPlan,
  markViralKeywordSfx,
  type ViralCaptionPlanItem,
} from "../../../../lib/viral-workflow";

type Caption = ViralCaptionPlanItem;

type ProviderResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
  output_text?: string;
};

// The transcript has already been produced by Tencent Flash ASR. One short AI
// pass is enough; render workers must never repeat this request.
const TRANSCRIPT_MODEL = "gpt-5.4-mini";
const TRANSCRIPT_TIMEOUT_MS = 8_000;
const TRANSCRIPT_CACHE_MAX = 96;
const transcriptCache = new Map<string, { expiresAt: number; value: Record<string, unknown> }>();

function transcriptCacheKey(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function readTranscriptCache(key: string) {
  const entry = transcriptCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    transcriptCache.delete(key);
    return null;
  }
  transcriptCache.delete(key);
  transcriptCache.set(key, entry);
  return entry.value;
}

function writeTranscriptCache(key: string, value: Record<string, unknown>) {
  transcriptCache.set(key, { expiresAt: Date.now() + 24 * 60 * 60 * 1000, value });
  while (transcriptCache.size > TRANSCRIPT_CACHE_MAX) {
    const oldest = transcriptCache.keys().next().value;
    if (!oldest) break;
    transcriptCache.delete(oldest);
  }
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("");
  const record = value as Record<string, unknown>;
  for (const key of ["output_text", "text", "value", "content", "message", "choices", "output"]) {
    const result = extractText(record[key]);
    if (result) return result;
  }
  return "";
}

function parseJson(content: string) {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) throw new AiProviderError("大模型没有返回可用的口播文案。", 502);
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  }
}

function plainText(value: string) {
  return value
    .toLocaleLowerCase()
    .replace(/[\s，。！？；：、,.!?;:'"“”‘’（）()【】\[\]《》<>—…·-]/g, "");
}

function languageOf(value: string) {
  const cjk = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const latinWords = value.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || [];
  return latinWords.length * 2 > cjk ? "en" as const : "zh" as const;
}

function textUnits(value: string) {
  if (languageOf(value) === "en") {
    return (value.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
  }
  return [...plainText(value)].length;
}

function joinCaptionText(left: string, right: string) {
  const joiner = languageOf(`${left} ${right}`) === "en" ? " " : "";
  return `${left.trim()}${joiner}${right.trim()}`.replace(/\s+/g, " ").trim();
}

function punctuation(value: string) {
  const text = languageOf(value) === "en"
    ? value.replace(/\s+/g, " ").trim()
    : value.replace(/\s+/g, "").trim();
  if (!text) return "";
  if (/[。！？.!?]$/.test(text)) return text;
  return languageOf(text) === "en" ? `${text}.` : `${text}。`;
}

function phraseText(value: string) {
  const normalized = languageOf(value) === "en"
    ? value.replace(/\s+/g, " ")
    : value.replace(/\s+/g, "");
  return normalized
    .replace(/^[，,.。！？!?；;：:、]+|[，,.。！？!?；;：:、]+$/gu, "")
    .trim();
}

function completeTitle(value: unknown) {
  if (typeof value !== "string") return "";
  if (languageOf(value) === "en") {
    const title = value
      .replace(/^[\s'"“”‘’.,!?;:—-]+|[\s'"“”‘’.,!?;:—-]+$/gu, "")
      .replace(/\s+/g, " ")
      .trim();
    const words = title.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || [];
    if (words.length < 3 || words.length > 12) return "";
    if (/\b(?:and|or|but|because|so|the|a|an|to|of|for|with|that|which)$/i.test(title)) return "";
    return title;
  }
  const title = value
    .replace(/[《》“”"'‘’：:。！？!?，,；;、*#\s]+/gu, "")
    .trim();
  if (title.length < 6 || title.length > 16) return "";
  const incompleteEndings = ["不是", "而是", "但是", "因为", "所以", "以及", "还有", "对于", "关于", "已经", "正在", "很多岗位", "这个问题", "这件事"];
  if (incompleteEndings.some((ending) => title.endsWith(ending))) return "";
  if (title.includes("不是")) {
    if (!title.includes("而是")) return "";
    if ((title.split("而是").pop() || "").length < 4) return "";
  }
  return title;
}

function fallbackEnglishTitle(captions: Caption[]) {
  const candidate = captions
    .map((caption) => caption.text.replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim())
    .find((text) => textUnits(text) >= 3 && textUnits(text) <= 12) || "";
  return completeTitle(candidate);
}

function fallbackChineseTitle(captions: Caption[]) {
  const phrases = captions
    .map((caption) => phraseText(caption.text))
    .filter(Boolean);
  const standalone = phrases.find((text) => text.length >= 6 && text.length <= 16);
  if (standalone) return standalone;
  const combined = phrases.slice(0, 2).join("");
  return combined.length >= 6 ? combined.slice(0, 15) : combined;
}

function chunkPhrase(value: string, maxChars = 15, minTailChars = 5) {
  if (languageOf(value) === "en") {
    const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    const maxWords = 11;
    const minTailWords = 4;
    if (words.length <= maxWords) return words.length ? [words.join(" ")] : [];
    const output: string[] = [];
    let cursor = 0;
    while (cursor < words.length) {
      const remaining = words.length - cursor;
      let size = Math.min(maxWords, remaining);
      if (remaining > maxWords && remaining - size < minTailWords) {
        size = Math.max(minTailWords, remaining - minTailWords);
      }
      const window = words.slice(cursor, cursor + size);
      const semanticBreak = window.findLastIndex((word, index) => (
        index >= 4 && /^(?:and|but|or|because|so|while|when|that|which|who)$/i.test(word)
      ));
      if (semanticBreak > 4 && remaining - semanticBreak >= minTailWords) size = semanticBreak;
      output.push(words.slice(cursor, cursor + size).join(" "));
      cursor += size;
    }
    return output;
  }
  const chars = [...phraseText(value)];
  if (chars.length <= maxChars) return chars.length ? [chars.join("")] : [];
  const output: string[] = [];
  let cursor = 0;
  while (cursor < chars.length) {
    const remaining = chars.length - cursor;
    let size = Math.min(maxChars, remaining);
    if (remaining > maxChars && remaining - size < minTailChars) {
      size = Math.max(minTailChars, remaining - minTailChars);
    }
    output.push(chars.slice(cursor, cursor + size).join(""));
    cursor += size;
  }
  return output;
}

function normalizeSourceCaptions(value: unknown, duration: number): Caption[] {
  if (!Array.isArray(value)) return [];
  const captions = value
    .map((item) => {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const start = Math.max(0, Math.min(duration, Number(record.start) || 0));
      const end = Math.max(start + 0.05, Math.min(duration, Number(record.end) || start + 0.5));
      const text = typeof record.text === "string" ? record.text.trim().slice(0, 500) : "";
      return { start, end, text };
    })
    .filter((item) => item.text && item.end > item.start)
    .sort((a, b) => a.start - b.start)
    .slice(0, 160);
  return repairEnglishWordFragments(captions);
}

function localSentenceCaptions(captions: Caption[]): Caption[] {
  const output: Caption[] = [];
  let current: Caption | null = null;
  captions.forEach((caption, index) => {
    if (!current) current = { ...caption };
    else {
      current.end = Math.max(current.end, caption.end);
      current.text = joinCaptionText(current.text, caption.text);
    }
    const next = captions[index + 1];
    const pause = next ? Math.max(0, next.start - caption.end) : 0;
    const shouldClose = /[.。！？!?]$/.test(current.text.trim())
      || pause >= 0.78
      || textUnits(current.text) >= (languageOf(current.text) === "en" ? 24 : 42)
      || !next;
    if (shouldClose) {
      const text = punctuation(current.text);
      if (text) output.push({ start: current.start, end: current.end, text });
      current = null;
    }
  });
  return segmentViralCaptions(splitCaptionPhrases(output));
}

function textCoverage(source: string, result: string) {
  const sourceChars = [...plainText(source)];
  const resultCounts = new Map<string, number>();
  for (const char of plainText(result)) resultCounts.set(char, (resultCounts.get(char) || 0) + 1);
  let matched = 0;
  for (const char of sourceChars) {
    const count = resultCounts.get(char) || 0;
    if (count > 0) {
      matched += 1;
      resultCounts.set(char, count - 1);
    }
  }
  return matched / Math.max(1, sourceChars.length);
}

function splitCaptionPhrases(captions: Caption[]): Caption[] {
  return captions.flatMap((caption) => {
    const parts = caption.text
      .split(/[，,.。！？!?；;：:\n]+/u)
      .flatMap((part) => chunkPhrase(part))
      .filter(Boolean);
    if (parts.length <= 1) return parts.length ? [{ ...caption, text: parts[0] }] : [];
    const weights = parts.map((part) => Math.max(1, textUnits(part)));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const duration = Math.max(0.1, caption.end - caption.start);
    let cursor = caption.start;
    return parts.map((part, index) => {
      const end = index === parts.length - 1
        ? caption.end
        : Math.min(caption.end, cursor + duration * (weights[index] / totalWeight));
      const item = {
        start: Number(cursor.toFixed(2)),
        end: Number(Math.max(cursor + 0.05, end).toFixed(2)),
        text: phraseText(part),
      };
      cursor = item.end;
      return item;
    });
  });
}

function normalizedAiCaptions(value: unknown, source: Caption[], duration: number): Caption[] {
  if (!Array.isArray(value)) return [];
  let cursor = 0;
  const captions = value.map((item) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const start = Math.max(cursor, Math.min(duration, Number(record.start) || cursor));
    const end = Math.max(start + 0.08, Math.min(duration, Number(record.end) || start + 1));
    cursor = end;
    return {
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      text: phraseText(typeof record.text === "string" ? record.text.slice(0, 180) : ""),
    };
  }).filter((item) => item.text && item.end > item.start);
  if (!captions.length) return [];
  const sourceLanguage = languageOf(source.map((item) => item.text).join(" "));
  const resultLanguage = languageOf(captions.map((item) => item.text).join(" "));
  if (resultLanguage !== sourceLanguage) return [];
  const joiner = sourceLanguage === "en" ? " " : "";
  const sourceText = source.map((item) => item.text).join(joiner);
  const resultText = captions.map((item) => item.text).join(joiner);
  const lengthRatio = plainText(resultText).length / Math.max(1, plainText(sourceText).length);
  if (lengthRatio < 0.72 || lengthRatio > 1.35 || textCoverage(sourceText, resultText) < 0.62) return [];
  const segmented = segmentViralCaptions(captions);
  if (sourceLanguage === "en") {
    const wordCounts = segmented.map((caption) => textUnits(caption.text));
    const singleWordRatio = wordCounts.filter((count) => count <= 1).length / Math.max(1, wordCounts.length);
    const averageWords = wordCounts.reduce((sum, count) => sum + count, 0) / Math.max(1, wordCounts.length);
    if (singleWordRatio > 0.18 || averageWords < 3.5) return [];
  }
  return segmented;
}

function captionsWithSemanticLines(captions: Caption[], rawCaptions: unknown) {
  const rawItems = Array.isArray(rawCaptions) ? rawCaptions : [];
  return captions.map((caption, index) => {
    const raw = rawItems.length === captions.length && rawItems[index] && typeof rawItems[index] === "object"
      ? rawItems[index] as Record<string, unknown>
      : {};
    const rawText = typeof raw.text === "string" ? phraseText(raw.text) : "";
    const preferredLines = rawText && plainText(rawText) === plainText(caption.text)
      ? raw.caption_lines
      : undefined;
    const layout = planViralCaptionLayout(caption.text, preferredLines, 10);
    return {
      ...caption,
      captionLineMode: layout.mode,
      captionLines: layout.lines,
    };
  });
}

function localNode(text: string, index: number, total: number): ViralCaptionPlanItem["contentNode"] {
  const value = text.replace(/\s+/g, "");
  if (index === 0 || /为什么|千万|别再|很多人|你知道|想不想/.test(value)) return "hook";
  if (index === total - 1 && /欢迎|咨询|预约|点击|联系|关注|留言/.test(value)) return "cta";
  if (/但是|不过|其实|相反|而是|不是|问题|难|担心/.test(value)) return "pain_reversal";
  if (/\d|提升|增长|效率|收益|优惠|免费|省/.test(value)) return "number_benefit";
  if (/比如|例如|第一|第二|第三|首先|其次|步骤|如何|怎么/.test(value)) return "example_step";
  if (/老师|品牌|公司|门店|产品|我们是|我是/.test(value)) return "brand_entity";
  if (/所以|记住|核心|结论|关键|本质|重点|方法|价值/.test(value)) return "core_viewpoint";
  return "supporting";
}

function localKeyword(text: string) {
  const value = text.replace(/\s+/g, "").replace(/[，。！？；：、,.!?;:'"“”‘’（）()【】\[\]《》<>—…·-]/g, "");
  const match = value.match(/\d+(?:\.\d+)?[%折元万+]?|[一二三四五六七八九十百千万]+(?:个|类|项|种)|效率|提升|关键|核心|方法|步骤|技能|专业|免费|优惠|结果|问题|价值|马上|现在/);
  if (match?.[0]) return match[0].slice(0, 8);
  if (value.length <= 4) return value;
  return value.slice(Math.max(0, Math.floor(value.length * 0.5) - 2), Math.max(0, Math.floor(value.length * 0.5) - 2) + 4);
}

function localIntents(node: ViralCaptionPlanItem["contentNode"], weight: number) {
  return {
    cameraIntent: (node === "hook" ? "push-in" : node === "number_benefit" ? "close-up" : node === "example_step" ? "reframe" : node === "cta" ? "pull-back" : weight >= 0.72 ? "push-in" : "hold") as ViralCaptionPlanItem["cameraIntent"],
    transitionIntent: (node === "hook" ? "cut" : node === "pain_reversal" ? "focus-bridge" : node === "example_step" ? "matched-reframe" : node === "cta" ? "foreground-occlusion" : "none") as ViralCaptionPlanItem["transitionIntent"],
    sfxRole: ({ hook: "hook", pain_reversal: "reversal", core_viewpoint: "viewpoint", number_benefit: "number", example_step: "step", brand_entity: "brand", cta: "cta", supporting: "none" } as const)[node || "supporting"],
  };
}

function directedCaptions(captions: Caption[], rawCaptions: unknown, duration: number) {
  const rawItems = Array.isArray(rawCaptions) ? rawCaptions : [];
  const enriched = captions.map((caption, index) => {
    const midpoint = (caption.start + caption.end) / 2;
    const raw = rawItems.find((item) => {
      if (!item || typeof item !== "object") return false;
      const record = item as Record<string, unknown>;
      return midpoint >= Number(record.start) - 0.2 && midpoint <= Number(record.end) + 0.2;
    }) as Record<string, unknown> | undefined || {};
    const node = ["hook", "pain_reversal", "core_viewpoint", "number_benefit", "example_step", "brand_entity", "cta", "supporting"].includes(String(raw.content_node))
      ? raw.content_node as ViralCaptionPlanItem["contentNode"]
      : localNode(caption.text, index, captions.length);
    const weight = Math.max(0, Math.min(1, Number(raw.weight) || (index === 0 || index === captions.length - 1 ? 0.9 : 0.55)));
    const candidate = typeof raw.keyword === "string" ? raw.keyword.replace(/\s+/g, "").slice(0, 8) : "";
    const keyword = candidate && plainText(caption.text).includes(plainText(candidate)) ? candidate : localKeyword(caption.text);
    const local = localIntents(node, weight);
    return {
      ...caption,
      keyword,
      translation: typeof raw.translation === "string" ? raw.translation.trim().slice(0, 240) : "",
      contentNode: node,
      contentWeight: weight,
      keywordOrigin: candidate ? "ai" as const : "local" as const,
      cameraIntent: ["hold", "push-in", "pull-back", "reframe", "close-up", "wide"].includes(String(raw.camera_intent)) ? raw.camera_intent as ViralCaptionPlanItem["cameraIntent"] : local.cameraIntent,
      transitionIntent: ["none", "cut", "matched-reframe", "focus-bridge", "foreground-occlusion"].includes(String(raw.transition_intent)) ? raw.transition_intent as ViralCaptionPlanItem["transitionIntent"] : local.transitionIntent,
      sfxRole: ["none", "hook", "reversal", "viewpoint", "number", "step", "brand", "cta"].includes(String(raw.sfx_role)) ? raw.sfx_role as ViralCaptionPlanItem["sfxRole"] : local.sfxRole,
    };
  });
  return markViralKeywordSfx(enriched, duration);
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });

  try {
    const body = await request.json() as {
      captions?: unknown;
      frames?: unknown;
      duration?: unknown;
      templateId?: unknown;
    };
    const duration = Math.max(1, Math.min(600, Number(body.duration) || 60));
    const sourceCaptions = normalizeSourceCaptions(body.captions, duration);
    if (!sourceCaptions.length) {
      return Response.json({ error: "没有读取到视频中的原始口播，请确认视频带有清晰人声。" }, { status: 400 });
    }
    const frames = Array.isArray(body.frames)
      ? body.frames.filter((item): item is string => typeof item === "string" && /^data:image\/(?:jpeg|png|webp);base64,/i.test(item)).slice(0, 5)
      : [];
    const sourceLanguage = languageOf(sourceCaptions.map((item) => item.text).join(" "));
    const sourceText = sourceCaptions.map((item) => item.text).join(sourceLanguage === "en" ? " " : "");
    const templateId = typeof body.templateId === "string" ? body.templateId.trim().slice(0, 64) : "template-9";
    const cacheKey = transcriptCacheKey({
      version: "viral-transcript-director-v1",
      model: TRANSCRIPT_MODEL,
      templateId,
      duration,
      sourceCaptions,
      frameHashes: frames.map((frame) => transcriptCacheKey(frame)),
    });
    const cached = readTranscriptCache(cacheKey);
    if (cached) return Response.json({ ...cached, cache: "hit" });
    const system = `你是多语言短视频口播校对师。输入已经包含从视频人声识别出的原始文字和真实时间轴，另有视频关键帧供你核对专有名词。
要求：
1. 保留原口播的全部有效信息，不总结、不缩写、不加入营销文案，不虚构原片没有说过的内容。
2. 结合整段上下文和关键画面校正同音错字、品牌名、机构名、数字与明显漏字；不能确认时保留原词。
3. 保持原口播语言。英文必须保留单词之间的空格，按完整单词、标点、真实停顿和语义从句分段，绝不能从单词中间截断；通常每条4到11个英文单词。中文优先每条7到18个中文字，必须是可独立朗读的完整语义短句，不能机械照搬语音识别的碎片边界。持续时间一般为1.0到3.8秒。
4. 每条只保留字幕文字，不带句末标点。start和end必须对应这段话真实出现的位置；时间递增、不重叠、不超过视频时长。
5. 输出句子的纯文字按顺序拼接后，应与原始口播基本一致。
6. 标题必须先理解完整口播的主题、对象和最终结论后再提炼，保持原语言，不能截取第一句，也不能把开头两段机械拼接。中文标题8到15字；英文标题3到12个单词。标题必须可以独立阅读，不能停在连接词或半句话处。
7. 避免残句：上一条不能停在“的、和、与、就、都、也、在、让、属于、无论”等未完成词语，下一条不能以“的、就、都、也、才、属于、想念的”等承接词开头。“也有让人一吃就想念的经典风味”“无论是早餐午餐还是下午茶”这类结构必须保持完整。
8. 16秒口播通常整理为5到9条，32秒口播通常整理为9到16条；宁可一条稍长，也不要拆成莫名其妙的半句话。
9. title_lines必须把title按完整语义分为1到2行；caption_lines只负责同一条字幕内部的视觉换行，最多2行。各行拼接必须与原文字完全一致，禁止拆开品牌名、专有名词及“商家入驻、首批类目、激励翻倍”等固定短语。
10. 在同一次请求中为每条字幕补充keyword、content_node、weight、camera_intent、transition_intent、sfx_role和translation。镜头与转场只表达语义意图，不输出具体时间和像素。
11. content_node只能是hook/pain_reversal/core_viewpoint/number_benefit/example_step/brand_entity/cta/supporting；camera_intent只能是hold/push-in/pull-back/reframe/close-up/wide；transition_intent只能是none/cut/matched-reframe/focus-bridge/foreground-occlusion；sfx_role只能是none/hook/reversal/viewpoint/number/step/brand/cta。普通承接句不要强加音效。
12. bgm_mood只能是calm/warm/professional/uplifting/neutral。
只返回JSON：{"titleCandidates":["候选1","候选2","候选3"],"title":"最终标题","title_lines":["第一行","第二行"],"summary":"一句识别说明","bgm_mood":"professional","captions":[{"start":0,"end":2.1,"text":"想提升办公和职场技能","caption_lines":["想提升办公","和职场技能"],"keyword":"提升","translation":"Improve your skills","content_node":"hook","weight":0.9,"camera_intent":"push-in","transition_intent":"cut","sfx_role":"hook"}]}。`;
    const content = [
      {
        type: "text",
        text: `原始口播语言：${sourceLanguage === "en" ? "英文；标题和字幕必须全部使用英文" : "中文"}\n视频时长：${duration.toFixed(2)}秒\n原始口播时间轴：${JSON.stringify(sourceCaptions)}\n原始口播全文：${sourceText}`,
      },
      ...frames.map((url) => ({ type: "image_url", image_url: { url, detail: "low" } })),
    ];
    const tokenBudget = Math.max(1200, Math.min(3000, plainText(sourceText).length * 6));
    let endpoint: "chat-completions" | "local" = "local";
    let selectedModel: string = "local-segmentation";
    let response: ProviderResponse | null = null;
    try {
      response = await lk888Fetch<ProviderResponse>("/v1/chat/completions", {
        method: "POST",
        signal: AbortSignal.timeout(TRANSCRIPT_TIMEOUT_MS),
        body: JSON.stringify({
          model: TRANSCRIPT_MODEL,
          temperature: 0.05,
          max_tokens: tokenBudget,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content },
          ],
        }),
      });
      if (!extractText(response)) throw new AiProviderError("识别通道没有返回有效内容。", 502);
      endpoint = "chat-completions";
      selectedModel = TRANSCRIPT_MODEL;
    } catch {
      response = null;
    }
    let parsed: Record<string, unknown> = {};
    if (response) {
      try {
        parsed = parseJson(extractText(response));
      } catch {
        response = null;
        endpoint = "local";
        selectedModel = "local-segmentation";
      }
    }
    const aiCaptions = normalizedAiCaptions(parsed.captions, sourceCaptions, duration);
    const baseCaptions = aiCaptions.length
      ? aiCaptions
      : sourceLanguage === "en"
        ? segmentViralCaptions(sourceCaptions)
        : localSentenceCaptions(sourceCaptions);
    const captions = directedCaptions(captionsWithSemanticLines(baseCaptions, parsed.captions), parsed.captions, duration);
    const titleCandidates = [
      parsed.title,
      ...(Array.isArray(parsed.titleCandidates) ? parsed.titleCandidates : []),
    ];
    const aiTitle = titleCandidates
      .map(completeTitle)
      .find((candidate) => candidate && languageOf(candidate) === sourceLanguage) || "";
    const rawTitle = aiTitle || (sourceLanguage === "en" ? fallbackEnglishTitle(captions) : fallbackChineseTitle(captions));
    const titleLayout = planViralTitleLayout(rawTitle, parsed.title_lines);
    const title = titleLayout.serializedTitle;
    const directorPlan = buildViralDirectorPlan({
      templateId,
      title,
      titleLines: titleLayout.lines,
      duration,
      captions,
      bgmMood: parsed.bgm_mood as "calm" | "warm" | "professional" | "uplifting" | "neutral",
      source: response ? "ai" : "local-fallback",
      model: selectedModel,
      degraded: !response || !aiCaptions.length,
    });
    const result = {
      title,
      titleLines: titleLayout.lines,
      summary: typeof parsed.summary === "string"
        ? parsed.summary.trim().slice(0, 180)
        : response
          ? "AI 已完成英文口播校对与整句分段。"
          : "AI 模型繁忙，已自动使用完整单词与停顿分段，可继续编辑。",
      captions: directorPlan.captions,
      directorPlan,
      planReady: true,
      model: selectedModel,
      endpoint,
      degraded: !response || !aiCaptions.length,
      cache: "miss",
    };
    writeTranscriptCache(cacheKey, result);
    return Response.json(result);
  } catch (error) {
    return aiErrorResponse(error);
  }
}
