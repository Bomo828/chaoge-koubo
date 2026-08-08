import { getMemberSession } from "../../../member-session";
import { AiProviderError, aiErrorResponse, lk888Fetch } from "../../../../lib/lk888";
import { getWallet, pointsErrorResponse, refundAiPoints, reserveAiPoints, settleAiPoints } from "../../../../lib/points";

type ProviderChatResponse = {
  choices?: Array<{ message?: { content?: string | Array<{ text?: string }> }; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
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
    if (start < 0 || end <= start) throw new AiProviderError("AI 没有返回可用的视频策划结果，请重试。", 502);
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  }
}

function usageOf(payload: ProviderChatResponse) {
  const inputTokens = Number(payload.usage?.input_tokens) || 0;
  const outputTokens = Number(payload.usage?.output_tokens) || 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: Number(payload.usage?.total_tokens) || inputTokens + outputTokens,
  };
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });

  let reservation: Awaited<ReturnType<typeof reserveAiPoints>> | null = null;
  let completed = false;
  try {
    const body = await request.json() as {
      stage?: unknown;
      merchant?: Record<string, unknown>;
      brief?: unknown;
      platforms?: unknown;
      materialNames?: unknown;
      referenceImages?: unknown;
      selectedDirection?: Record<string, unknown>;
      campaign?: unknown;
      audience?: unknown;
      duration?: unknown;
      resolution?: unknown;
      requestId?: unknown;
    };
    const stage = body.stage === "storyboard" ? "storyboard" : "analyze";
    const brief = safeText(body.brief, 1200);
    const referenceImages = Array.isArray(body.referenceImages)
      ? body.referenceImages.filter((item): item is string => typeof item === "string" && (/^data:image\//i.test(item) || /^https?:\/\//i.test(item))).slice(0, 7)
      : [];
    const materialNames = Array.isArray(body.materialNames)
      ? body.materialNames.map((item) => safeText(item, 100)).filter(Boolean).slice(0, 12)
      : [];
    const context = {
      merchant: body.merchant ?? {},
      brief,
      platforms: Array.isArray(body.platforms) ? body.platforms.map((item) => safeText(item, 20)).filter(Boolean).slice(0, 3) : ["视频号"],
      materialNames,
      selectedDirection: body.selectedDirection ?? null,
      campaign: safeText(body.campaign, 500),
      audience: safeText(body.audience, 300),
      duration: Math.max(3, Math.min(16, Number(body.duration) || 15)),
      resolution: body.resolution === "480p" ? "480p" : "720p",
    };
    const estimatedTokens = 2600 + Math.ceil(JSON.stringify(context).length / 2) + referenceImages.length * 650;
    const tokenUnits = Math.max(1, Math.ceil(estimatedTokens / 1000));
    reservation = await reserveAiPoints(member, "prompt_optimize", tokenUnits, body.requestId);

    const system = stage === "analyze"
      ? `你是本地商家短视频总导演。请结合商家资料、真实素材内容、目标平台和需求，先完成商家与素材分析，再只推荐3个最适合当前商家的短视频方向，避免让非专业商家在十几个方向中选择。方向必须分别体现：快速获客、专业信任、真实体验三类价值，但标题与内容要贴合商家行业。不得虚构素材中不存在的服务、价格、资质、顾客评价或效果。只返回JSON：{"summary":"商家与素材摘要","platformInsight":"平台传播建议","directions":[{"id":"direction-1","title":"方向标题","tag":"价值标签","hook":"前三秒钩子","story":"内容结构","reason":"为什么适合","risk":"需要注意"}],"missing":["仍建议补充的信息"]}。directions必须恰好3项。`
      : `你是本地商家短视频总导演。商家已经从3个方向中选定一个，请根据商家资料、素材、活动信息、目标人群、视频时长和输出分辨率，输出可直接交给 Seedance 2.0 参考生视频模型的15秒以内竖版短视频方案。每个镜头都必须能由上传素材或合理的关键帧实现，不得虚构价格、资质、顾客评价或效果。视频提示词需要明确：使用1至9张参考图保持人物、门店、商品和品牌一致；9:16竖版；采用项目上下文指定的480p或720p输出；自然运镜；主体一致性；移动端安全区；不要生成乱码文字，字幕由后期叠加。只返回JSON：{"title":"项目名称","script":"完整口播或字幕文案","generationPrompt":"可直接交给 Seedance 2.0 的专业提示词","shots":[{"time":"0-3s","title":"镜头标题","visual":"画面与运镜","caption":"字幕","source":"建议使用的素材"}],"modelPlan":[{"step":"策划分析","model":"gpt-5.5","reason":"用途"},{"step":"关键帧补充","model":"gpt-image-2","reason":"用途"},{"step":"参考生视频","model":"kwvideo-v2-ref","reason":"Seedance 2.0 参考生视频"}]}。shots为4至6项，时间总长不得超过指定时长。`;

    const userContent = referenceImages.length
      ? [
        { type: "text", text: `项目上下文：${JSON.stringify(context)}\n请逐张识别以下真实素材的主体、场景、构图、光线、品牌元素和可用镜头。` },
        ...referenceImages.map((url) => ({ type: "image_url", image_url: { url, detail: "low" } })),
      ]
      : `项目上下文：${JSON.stringify(context)}\n本次没有可直接传入的图片画面。请直接读取商家资料、商家素材摘要和素材文件名称完成分析；不要假装看到了未传入的视频或图片画面。`;

    const response = await lk888Fetch<ProviderChatResponse>("/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(referenceImages.length ? 90_000 : 45_000),
      body: JSON.stringify({
        model: "gpt-5.5",
        temperature: stage === "analyze" ? 0.65 : 0.5,
        max_tokens: stage === "analyze" ? 2200 : 3000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
      }),
    });
    const content = extractText(response);
    if (!content) throw new AiProviderError("AI 没有返回视频策划结果，请重试。", 502);
    const result = parseJson(content);
    const usage = usageOf(response);
    const actualUnits = usage.totalTokens > 0 ? Math.max(1, Math.ceil(usage.totalTokens / 1000)) : tokenUnits;
    const wallet = await settleAiPoints(reservation, actualUnits);
    completed = true;
    return Response.json({
      ...result,
      model: "gpt-5.5",
      costPoints: Math.min(reservation.reservedCost, actualUnits * 2),
      wallet,
      usage,
    });
  } catch (error) {
    if (reservation && !completed) await refundAiPoints(reservation).catch(() => undefined);
    const pointsFailure = pointsErrorResponse(error);
    if (pointsFailure) return pointsFailure;
    if (reservation) {
      const wallet = await getWallet(member).catch(() => undefined);
      return Response.json({ error: "AI 视频策划本次没有完成，积分已退回，请直接重试。", wallet }, { status: 502 });
    }
    return aiErrorResponse(error);
  }
}
