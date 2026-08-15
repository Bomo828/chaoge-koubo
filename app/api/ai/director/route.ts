import { getMemberSession } from "../../../member-session";
import { AiProviderError, aiErrorResponse, lk888Fetch } from "../../../../lib/lk888";
import { AI_VIDEO_DIRECTOR_SKILL_VERSION, aiDirectorSystemPrompt, aiDirectorUserInstruction } from "../../../../lib/ai-video-director-skills";
import { pointsErrorResponse, refundAiPoints, reserveAiPoints, settleAiPoints } from "../../../../lib/points";

type ProviderChatResponse = {
  choices?: Array<{ message?: { content?: string | Array<{ text?: string }> }; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
};

type DirectorAsset = {
  id: string;
  name: string;
  kind: "image" | "video";
  duration: number;
  frameLabels: string[];
};

function safeText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
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
    if (start < 0 || end <= start) throw new AiProviderError("AI 导演没有返回可用结果，请重试。", 502);
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  }
}

function normalizeAssets(value: unknown): DirectorAsset[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const id = safeText(record.id, 80);
    const name = safeText(record.name, 120);
    const kind = record.kind === "video" ? "video" : "image";
    if (!id || !name) return [];
    return [{
      id,
      name,
      kind,
      duration: kind === "video" ? Math.max(0, Math.min(1800, Number(record.duration) || 0)) : 0,
      frameLabels: Array.isArray(record.frameLabels)
        ? record.frameLabels.map((label) => safeText(label, 80)).filter(Boolean).slice(0, 4)
        : [],
    } satisfies DirectorAsset];
  }).slice(0, 24);
}

function numberValue(value: unknown, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function normalizedStoryboard(result: Record<string, unknown>, duration: number, assets: DirectorAsset[]) {
  const rawShots = Array.isArray(result.shots) ? result.shots : [];
  const safeDuration = Math.max(1, Math.min(300, duration));
  const shots = rawShots.slice(0, 18).flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const requestedAssetId = safeText(record.assetId, 80);
    const asset = assets.find((candidate) => candidate.id === requestedAssetId) ?? assets[index % Math.max(1, assets.length)];
    if (!asset) return [];
    const requestedRenderMode = safeText(record.renderMode, 40);
    const renderMode = asset.kind === "image" || requestedRenderMode === "ai-generated-video"
      ? "ai-generated-video" as const
      : "source-video" as const;
    const requestedCreationMode = safeText(record.creationMode, 20);
    const creationMode = requestedCreationMode === "rebuild" || requestedCreationMode === "extend"
      ? requestedCreationMode
      : "preserve";
    return [{
      id: safeText(record.id, 80) || `shot-${index + 1}`,
      start: numberValue(record.start, 0),
      end: numberValue(record.end, 0),
      beat: safeText(record.beat, 80) || `镜头 ${index + 1}`,
      purpose: safeText(record.purpose, 240) || "准确表达对应口播内容",
      narration: safeText(record.narration, 500),
      visual: safeText(record.visual, 500),
      assetId: asset.id,
      referenceFrame: Math.max(0, Math.min(Math.max(0, asset.frameLabels.length - 1), Math.round(numberValue(record.referenceFrame, 0)))),
      sourceIn: Math.max(0, numberValue(record.sourceIn, 0)),
      sourceOut: Math.max(0, numberValue(record.sourceOut, 0)),
      renderMode,
      creationMode,
      characters: safeText(record.characters, 320) || "无明确人物要求",
      environment: safeText(record.environment, 320) || "延续参考素材中的真实空间",
      props: safeText(record.props, 240),
      shotSize: safeText(record.shotSize, 80) || "中近景",
      cameraAngle: safeText(record.cameraAngle, 100) || "平视",
      composition: safeText(record.composition, 240) || "主体清晰，前中后景层次自然",
      cameraMotion: safeText(record.cameraMotion, 180) || safeText(record.motion, 180) || "稳定的单一镜头运动",
      subjectAction: safeText(record.subjectAction, 260) || "主体完成与口播语义一致的自然动作",
      lighting: safeText(record.lighting, 160) || "真实自然光",
      color: safeText(record.color, 120) || "自然商业色彩",
      transition: safeText(record.transition, 120) || "自然切换",
      soundDesign: safeText(record.soundDesign, 180) || "仅保留口播，环境声弱化",
      continuity: safeText(record.continuity, 240) || "保持参考素材中的主体、商品和空间识别特征",
      negativePrompt: safeText(record.negativePrompt, 300),
      confidence: Math.max(0, Math.min(100, Math.round(numberValue(record.confidence, 80)))),
    }];
  });
  if (!shots.length) throw new AiProviderError("AI 导演没有生成有效镜头，请补充素材后重试。", 502);

  const weights = shots.map((shot) => Math.max(.5, shot.end - shot.start || safeDuration / shots.length));
  const weightTotal = weights.reduce((total, weight) => total + weight, 0);
  let cursor = 0;
  const timedShots = shots.map((shot, index) => {
    const start = cursor;
    const end = index === shots.length - 1
      ? safeDuration
      : Math.min(safeDuration, cursor + safeDuration * (weights[index] / weightTotal));
    cursor = end;
    const asset = assets.find((candidate) => candidate.id === shot.assetId);
    const shotDuration = Math.max(.1, end - start);
    const sourceIn = asset?.kind === "video" ? Math.min(shot.sourceIn, Math.max(0, asset.duration - .1)) : 0;
    const sourceOut = asset?.kind === "video"
      ? Math.min(asset.duration || sourceIn + shotDuration, Math.max(sourceIn + .1, shot.sourceOut || sourceIn + shotDuration))
      : 0;
    return {
      ...shot,
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      sourceIn: Number(sourceIn.toFixed(2)),
      sourceOut: Number(sourceOut.toFixed(2)),
    };
  });

  const generatedShots = timedShots.filter((shot) => shot.renderMode === "ai-generated-video");
  if (timedShots.some((shot) => !shot.narration.trim() || shot.visual.trim().length < 8)) {
    throw new AiProviderError("AI 导演分镜缺少口播对应关系或完整画面，请重试生成。", 502);
  }
  if (generatedShots.some((shot) => shot.end - shot.start > 15)) {
    throw new AiProviderError("AI 导演生成了超过15秒的创意镜头，请重试以获得更合理的镜头拆分。", 502);
  }
  const warnings: string[] = [];
  const creativeShots = generatedShots.filter((shot) => shot.creationMode === "extend" || shot.creationMode === "rebuild");
  const uniqueShotSizes = new Set(timedShots.map((shot) => shot.shotSize)).size;
  const uniqueCameraMoves = new Set(timedShots.map((shot) => shot.cameraMotion)).size;
  if (generatedShots.length >= 3 && !creativeShots.length) warnings.push("生成镜头全部采用保留模式，创意补镜偏少");
  if (timedShots.length >= 5 && uniqueShotSizes < 2) warnings.push("景别变化不足");
  if (timedShots.length >= 5 && uniqueCameraMoves < 2) warnings.push("镜头运动变化不足");
  const qualityScore = Math.max(0, 100 - warnings.length * 10);
  if (qualityScore < 80) {
    throw new AiProviderError(`AI 导演分镜质量未达标：${warnings.join("；")}。请重新生成。`, 502);
  }

  return {
    projectTitle: safeText(result.projectTitle, 100) || "AI 导演成片",
    creativeConcept: safeText(result.creativeConcept, 500),
    directorNote: safeText(result.directorNote, 1000),
    musicDirection: safeText(result.musicDirection, 300),
    visualRhythm: safeText(result.visualRhythm, 300),
    shots: timedShots,
    duration: safeDuration,
    qualityGate: {
      passed: qualityScore >= 80,
      score: qualityScore,
      warnings,
      checkedAt: new Date().toISOString(),
    },
  };
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });

  let reservation: Awaited<ReturnType<typeof reserveAiPoints>> | null = null;
  let completed = false;
  try {
    const body = await request.json() as Record<string, unknown>;
    const stage = body.stage === "storyboard" ? "storyboard" : "analyze";
    const script = safeText(body.script, 6000);
    const requestedSpeechDuration = numberValue(body.speechDuration, 0);
    if (requestedSpeechDuration > 300) {
      return Response.json({ error: "单条口播最长支持5分钟，请缩短文案或拆分为两条视频。" }, { status: 400 });
    }
    const speechDuration = Math.max(1, Math.min(300, requestedSpeechDuration));
    const assets = normalizeAssets(body.assets);
    const referenceImages = Array.isArray(body.referenceImages)
      ? body.referenceImages.filter((item): item is string => typeof item === "string" && /^data:image\/(?:jpeg|png|webp);base64,/i.test(item)).slice(0, 18)
      : [];
    if (stage === "storyboard" && script.length < 10) return Response.json({ error: "请先确认完整口播文案。" }, { status: 400 });
    if (!assets.length || !referenceImages.length) return Response.json({ error: "请至少添加一项可读取的图片或视频素材。" }, { status: 400 });
    if (stage === "storyboard" && requestedSpeechDuration <= 0) {
      return Response.json({ error: "请先生成口播音频并锁定真实时长。" }, { status: 400 });
    }

    const context = {
      industry: safeText(body.industry, 60),
      platform: safeText(body.platform, 30) || "抖音",
      goal: safeText(body.goal, 100),
      audience: safeText(body.audience, 300),
      brief: safeText(body.brief, 1600),
      script,
      speechDuration,
      referenceTitle: safeText(body.referenceTitle, 160),
      referenceTranscript: safeText(body.referenceTranscript, 5000),
      assets,
      materialAnalysis: stage === "storyboard" && body.materialAnalysis && typeof body.materialAnalysis === "object"
        ? body.materialAnalysis
        : null,
    };
    const estimatedTokens = 2200 + Math.ceil(JSON.stringify(context).length / 2) + referenceImages.length * 450;
    const tokenUnits = Math.max(2, Math.ceil(estimatedTokens / 1000));
    reservation = await reserveAiPoints(member, "prompt_optimize", tokenUnits, body.requestId);

    const system = aiDirectorSystemPrompt(stage);

    const userContent = [
      { type: "text", text: aiDirectorUserInstruction(stage, context) },
      ...referenceImages.map((url) => ({ type: "image_url", image_url: { url, detail: "low" } })),
    ];
    const response = await lk888Fetch<ProviderChatResponse>("/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: "gpt-5.5",
        temperature: stage === "analyze" ? 0.35 : 0.45,
        max_tokens: stage === "analyze" ? 3200 : 5200,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
      }),
    });
    const result = parseJson(extractText(response));
    const inputTokens = Number(response.usage?.input_tokens) || 0;
    const outputTokens = Number(response.usage?.output_tokens) || 0;
    const totalTokens = Number(response.usage?.total_tokens) || inputTokens + outputTokens;
    const actualUnits = totalTokens > 0 ? Math.max(1, Math.ceil(totalTokens / 1000)) : tokenUnits;
    const wallet = await settleAiPoints(reservation, actualUnits);
    completed = true;
    return Response.json({
      ...(stage === "storyboard" ? normalizedStoryboard(result, speechDuration, assets) : result),
      model: "gpt-5.5",
      skillVersion: AI_VIDEO_DIRECTOR_SKILL_VERSION,
      wallet,
      usage: { inputTokens, outputTokens, totalTokens },
    });
  } catch (error) {
    if (reservation && !completed) await refundAiPoints(reservation).catch(() => undefined);
    return pointsErrorResponse(error) ?? aiErrorResponse(error);
  }
}
