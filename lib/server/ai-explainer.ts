import { AiProviderError, lk888Fetch } from "../lk888";

type ChatResponse = {
  choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
};

export type ExplainerMaterial = {
  id: string;
  name: string;
  kind: string;
  width: number;
  height: number;
  duration: number;
  aspectRatio: number;
};
export type ExplainerCaption = { start: number; end: number; text: string };

export type ExplainerMediaInput = {
  duration: number;
  sourceName: string;
  transcript: string;
  captions: ExplainerCaption[];
  materials: ExplainerMaterial[];
  references: string[];
  referenceRoles: string[];
};

function safeText(value: unknown, limit: number) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("");
  const record = value as Record<string, unknown>;
  for (const key of ["content", "text", "value", "message", "choices", "output_text", "output"]) {
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
    if (start < 0 || end <= start) throw new AiProviderError("AI 没有返回可用的 JSON 方案，请重试。", 502);
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      throw new AiProviderError("AI 返回的方案格式不正确，请重试。", 502);
    }
  }
}

function usageOf(response: ChatResponse) {
  const inputTokens = Number(response.usage?.input_tokens) || 0;
  const outputTokens = Number(response.usage?.output_tokens) || 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: Number(response.usage?.total_tokens) || inputTokens + outputTokens,
  };
}

export function normalizeExplainerInput(payload: Record<string, unknown>): ExplainerMediaInput {
  const duration = Number(payload.duration) || 0;
  if (duration <= 0 || duration > 3600) throw new AiProviderError("口播时长不正确。", 400);

  const materials = Array.isArray(payload.materials) ? payload.materials : [];
  const references = Array.isArray(payload.references) ? payload.references : [];
  const referenceRoles = Array.isArray(payload.reference_roles) ? payload.reference_roles : [];
  const captions = Array.isArray(payload.captions) ? payload.captions : [];
  if (materials.length > 30) throw new AiProviderError("素材数量不能超过 30 个。", 400);
  if (references.length > 20) throw new AiProviderError("参考图数量不能超过 20 张。", 400);

  const safeReferences = references.filter((item): item is string => (
    typeof item === "string" && /^data:image\/(?:jpeg|png|webp);base64,/i.test(item)
  ));
  if (safeReferences.length !== references.length) throw new AiProviderError("参考图格式不正确。", 400);

  return {
    duration,
    sourceName: safeText(payload.source_name, 200) || "口播原片",
    transcript: safeText(payload.transcript, 16_000),
    captions: captions.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const start = Math.max(0, Math.min(duration, Number(record.start) || 0));
      const end = Math.max(start + 0.05, Math.min(duration, Number(record.end) || start + 0.5));
      const text = safeText(record.text, 500);
      return text && end > start ? [{ start, end, text }] : [];
    }).sort((left, right) => left.start - right.start).slice(0, 200),
    materials: materials.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const id = safeText(record.id, 120);
      if (!id) return [];
      const width = Math.max(0, Math.min(12_000, Math.round(Number(record.width) || 0)));
      const height = Math.max(0, Math.min(12_000, Math.round(Number(record.height) || 0)));
      const materialDuration = Math.max(0, Math.min(3600, Number(record.duration) || 0));
      const aspectRatio = width > 0 && height > 0 ? width / height : Math.max(0, Math.min(10, Number(record.aspect_ratio) || 0));
      return [{ id, name: safeText(record.name, 200), kind: safeText(record.kind, 20), width, height, duration: materialDuration, aspectRatio }];
    }),
    references: safeReferences,
    referenceRoles: referenceRoles.map((item) => safeText(item, 300)).filter(Boolean),
  };
}

function estimatedTextTokens(value: unknown) {
  return Math.ceil(JSON.stringify(value ?? {}).length / 2);
}

/** Reserve from semantic text and metadata only. Base64 reference bytes are not language tokens. */
export function estimateExplainerContentUnits(input: ExplainerMediaInput) {
  const semanticPayload = {
    sourceName: input.sourceName,
    transcript: input.transcript,
    captions: input.captions,
    materials: input.materials,
    referenceRoles: input.referenceRoles,
  };
  const estimatedTokens = 2400 + estimatedTextTokens(semanticPayload) + input.references.length * 450;
  return Math.max(1, Math.ceil(estimatedTokens / 1000));
}

export function estimateExplainerDirectorUnits(input: ExplainerMediaInput, contentBrief: Record<string, unknown>) {
  const semanticPayload = {
    sourceName: input.sourceName,
    transcript: input.transcript,
    captions: input.captions,
    materials: input.materials,
    referenceRoles: input.referenceRoles,
    contentBrief,
  };
  const estimatedTokens = 2800 + estimatedTextTokens(semanticPayload) + input.references.length * 450;
  return Math.max(1, Math.ceil(estimatedTokens / 1000));
}

async function chatJson(system: string, prompt: string, references: string[], temperature: number) {
  const userContent = [
    { type: "text", text: prompt },
    ...references.map((url) => ({ type: "image_url", image_url: { url, detail: "low" } })),
  ];
  const response = await lk888Fetch<ChatResponse>("/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model: "gpt-5.5",
      temperature,
      max_tokens: 4200,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    }),
  });
  const content = extractText(response);
  if (!content) throw new AiProviderError("AI 内容服务没有返回结果，请重试。", 502);
  return { result: parseJson(content), usage: usageOf(response) };
}

export async function createExplainerContentBrief(input: ExplainerMediaInput) {
  const materialLines = input.materials.map((item) => `- id=${item.id}; name=${item.name}; type=${item.kind}; size=${item.width || "?"}x${item.height || "?"}; ratio=${item.aspectRatio ? item.aspectRatio.toFixed(3) : "?"}; duration=${item.duration ? item.duration.toFixed(2) : "?"}s`).join("\n") || "- 无上传素材";
  const transcriptBlock = input.transcript || "当前未提供可用转写，只能根据口播抽帧、素材画面和文件名保守分析，不得编造具体台词。";
  const timelineBlock = input.captions.length
    ? JSON.stringify(input.captions).slice(0, 20_000)
    : "当前没有逐句时间轴";
  const prompt = `你是“AI讲解成片”的内容编辑。请把本次上传内容整理成唯一的共享内容简报，后续AI导演和封面设计必须同时使用它。

口播原片：${input.sourceName}
总时长：${input.duration.toFixed(3)}秒
口播文案：${transcriptBlock}
逐句口播时间轴：${timelineBlock}
素材：
${materialLines}
参考图说明：
${input.referenceRoles.join("\n") || "- 图1为口播人物，其余按素材顺序"}

要求：
1. 主题、摘要、标题必须与本次上传的人物和素材有关，不得沿用旧示例。
2. cover_titles 给出3个4至8个汉字的封面主标题，简洁、可读、不夸大。
3. recommended_cover_styles 从1至10中选2个：1深色渐变、2扁平纯色、3产品视觉、4对比卡片、5极简留白、6海报拼贴、7侧身留白、8背影、9局部出镜、10正面对视。
4. 逐个说明素材的可视信息、适合表达的语义、关键词，以及它最适合对应的口播句子；素材 id 必须原样返回。同一素材的多张参考图代表该视频不同时刻，必须综合判断，不能只看首帧。
5. 没有转写时 transcript_status 为 visual_only；有转写时为 available。

只返回 JSON：
{"topic":"内容主题","summary":"一句话摘要","industry":"行业","audience":"受众","key_points":["要点1"],"cover_titles":["标题1","标题2","标题3"],"recommended_cover_styles":[6,10],"materials":[{"id":"素材id","meaning":"语义","keywords":["关键词"],"matching_lines":["对应口播短句"]}],"transcript_status":"visual_only"}`;
  const { result, usage } = await chatJson("你只输出严格 JSON，所有结论必须来自本次上传内容。", prompt, input.references, 0.15);
  const allowedIds = new Set(input.materials.map((item) => item.id));
  const coverTitles = Array.isArray(result.cover_titles)
    ? result.cover_titles.map((item) => safeText(item, 20)).filter(Boolean).slice(0, 3)
    : [];
  const styles = Array.isArray(result.recommended_cover_styles)
    ? result.recommended_cover_styles.map(Number).filter((item, index, list) => item >= 1 && item <= 10 && list.indexOf(item) === index).slice(0, 2)
    : [];
  const materialMeanings = Array.isArray(result.materials) ? result.materials.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const id = safeText(record.id, 120);
    if (!allowedIds.has(id)) return [];
    return [{
      id,
      meaning: safeText(record.meaning, 300),
      keywords: Array.isArray(record.keywords) ? record.keywords.map((value) => safeText(value, 80)).filter(Boolean).slice(0, 8) : [],
      matching_lines: Array.isArray(record.matching_lines) ? record.matching_lines.map((value) => safeText(value, 200)).filter(Boolean).slice(0, 6) : [],
    }];
  }) : [];
  return {
    brief: {
      topic: safeText(result.topic, 120) || input.sourceName.replace(/\.[^.]+$/, ""),
      summary: safeText(result.summary, 500) || "AI 已完成本次内容分析",
      industry: safeText(result.industry, 80) || "通用",
      audience: safeText(result.audience, 120) || "内容观众",
      key_points: Array.isArray(result.key_points) ? result.key_points.map((item) => safeText(item, 200)).filter(Boolean).slice(0, 8) : [],
      cover_titles: coverTitles.length ? coverTitles : [safeText(result.topic, 8) || "内容讲解"],
      recommended_cover_styles: styles.length ? styles : [6, 10],
      materials: materialMeanings,
      transcript: input.transcript,
      captions: input.captions,
      transcript_status: input.transcript ? "available" : "visual_only",
      analysis_basis: input.transcript ? "transcript_visual_metadata" : "visual_metadata",
    },
    usage,
  };
}

export async function createExplainerDirectorPlan(input: ExplainerMediaInput, contentBrief: Record<string, unknown>) {
  if (!safeText(contentBrief.topic, 120)) throw new AiProviderError("缺少本次上传内容的共享分析简报。", 400);
  const materialLines = input.materials.map((item) => `- id=${item.id}; name=${item.name}; type=${item.kind}; size=${item.width || "?"}x${item.height || "?"}; ratio=${item.aspectRatio ? item.aspectRatio.toFixed(3) : "?"}; duration=${item.duration ? item.duration.toFixed(2) : "?"}s`).join("\n") || "- 无上传素材";
  if (!input.captions.length || !input.transcript) {
    throw new AiProviderError("没有取得原片的真实口播时间轴，不能进行内容匹配剪辑。", 400);
  }
  const prompt = `你是竖屏口播视频的AI导演。请根据口播原片画面、素材参考图、素材文件名和时长，输出可以直接执行的剪辑时间表。

口播原片：${input.sourceName}
总时长：${input.duration.toFixed(3)}秒
真实口播全文：${input.transcript}
真实逐句时间轴：${JSON.stringify(input.captions).slice(0, 20_000)}
本次共享内容简报：${JSON.stringify(contentBrief).slice(0, 16_000)}
素材：
${materialLines}
参考图说明：
${input.referenceRoles.join("\n") || "- 图1为口播人物，其余按素材顺序"}

导演规则：
1. 前3秒和最后3秒优先保留口播人物；总时长不足8秒时按比例缩短保护区。
2. 每个素材最多使用一次，而且只在真正匹配某句口播时出现。start/end 必须落在对应口播句子的真实时间范围内，单次1.2到4秒。
3. mode 只能是 full、pip、strip。界面、表格、文字、横屏截图等信息密集素材优先 full 或 strip；人物表达必须保留时才用 pip。
4. 素材视频只作为无声画面，不能改变口播音频和总时长。
5. 不得编造不存在的素材 ID，不得让镜头重叠。
6. 至少安排一个素材镜头；不要求平均使用所有素材。宁可少用，也不能把不相关素材硬塞进成片。
7. reason 必须写出该镜头对应的原口播短句；semantic_match 用一句话说明素材画面为什么与这句口播匹配。
8. fit 只能是 contain 或 cover。带文字、界面、表格、海报和横屏录屏必须用 contain，完整保留四边信息；纯场景或人物照片才可用 cover。
9. size 只能是 large 或 medium，默认 large，禁止小画中画。position 只能是 top_left、top_right、bottom_left、bottom_right，应避开画面主体和字幕区域。

只返回 JSON：
{"summary":"一句话导演思路","shots":[{"asset_id":"素材id","start":3.2,"end":6.2,"mode":"pip","fit":"contain","size":"large","position":"top_right","reason":"对应的原口播短句","semantic_match":"素材与口播的匹配依据"}]}`;
  const { result, usage } = await chatJson("你只输出严格 JSON，是可以直接执行的短视频导演。", prompt, input.references, 0.2);
  const allowedIds = new Set(input.materials.map((item) => item.id));
  const materialMap = new Map(input.materials.map((item) => [item.id, item]));
  const usedAssetIds = new Set<string>();
  const safeEdge = input.duration > 8 ? 3 : Math.max(0.35, input.duration * 0.08);
  let previousEnd = safeEdge;
  const shots = (Array.isArray(result.shots) ? result.shots : [])
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .sort((left, right) => Number(left.start || 0) - Number(right.start || 0))
    .flatMap((shot) => {
      const assetId = safeText(shot.asset_id, 120);
      if (!allowedIds.has(assetId) || usedAssetIds.has(assetId)) return [];
      let start = Math.max(safeEdge, Math.min(Number(shot.start) || safeEdge, input.duration - safeEdge));
      start = Math.max(start, previousEnd);
      const end = Math.max(start + 1.2, Math.min(Number(shot.end) || start + 3, start + 4, input.duration - safeEdge));
      if (end > input.duration - safeEdge + 0.001 || end - start < 1) return [];
      usedAssetIds.add(assetId);
      previousEnd = end;
      const requestedMode = safeText(shot.mode, 10);
      const material = materialMap.get(assetId);
      const requestedFit = safeText(shot.fit, 12);
      const requestedPosition = safeText(shot.position, 20);
      const informationDense = /界面|截图|表格|海报|文档|页面|屏幕|录屏|ppt|excel/i.test(material?.name || "") || (material?.aspectRatio || 0) >= 1.25;
      const normalizedMode = requestedMode === "full" || requestedMode === "strip" ? requestedMode : "pip";
      return [{
        asset_id: assetId,
        start: Number(start.toFixed(2)),
        end: Number(end.toFixed(2)),
        mode: informationDense && normalizedMode === "pip" ? "strip" : normalizedMode,
        fit: informationDense || requestedFit === "contain" ? "contain" : "cover",
        size: safeText(shot.size, 12) === "medium" && !informationDense ? "medium" : "large",
        position: ["top_left", "top_right", "bottom_left", "bottom_right"].includes(requestedPosition) ? requestedPosition : "top_right",
        reason: safeText(shot.reason, 200) || "AI 导演匹配",
        semantic_match: safeText(shot.semantic_match, 300),
      }];
    });
  if (allowedIds.size && !shots.length) throw new AiProviderError("AI 导演没有为已上传素材安排有效镜头，请重试。", 502);
  return {
    plan: { summary: safeText(result.summary, 300) || "AI 已完成素材编排", shots },
    usage,
  };
}
