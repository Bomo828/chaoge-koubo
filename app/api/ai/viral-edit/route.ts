import { getMemberSession } from "../../../member-session";
import { AiProviderError, aiErrorResponse, lk888Fetch } from "../../../../lib/lk888";
import {
  getWallet,
  pointsErrorResponse,
  refundAiPointsByRequest,
  reserveAiPoints,
  settleAiPointsByRequest,
} from "../../../../lib/points";

const VIRAL_EDIT_POINTS = 28;

type ProviderChatResponse = {
  choices?: Array<{ message?: { content?: string | Array<{ text?: string }> }; text?: string }>;
};

type ProviderResponsesResponse = {
  output_text?: string;
  output?: Array<{ content?: Array<{ text?: string; value?: string }> }>;
};

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
    if (start < 0 || end <= start) throw new AiProviderError("AI 没有返回可用的视频内容分析，请重试。", 502);
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  }
}

function cleanText(value: unknown, fallback: string, maxLength: number) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : fallback;
}

function localTemplateAnalysis(input: {
  duration: number;
  fallbackTitle: string;
  fallbackSubtitle: string;
}) {
  const taskTerms = [input.fallbackSubtitle]
    .flatMap((value) => typeof value === "string" ? value.split(/[，,、·/|]/) : [])
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, items) => items.indexOf(value) === index)
    .slice(0, 5);
  const captionTexts = taskTerms.length
    ? taskTerms
    : ["走进真实现场", "看看真实环境", "了解特色服务", "记录自然体验"];
  const segmentDuration = input.duration / captionTexts.length;
  return {
    summary: "AI主备通道均未在限定时间内响应，已切换本地模板规则继续生成；本次内容仅采用原片和当前填写内容。",
    title: cleanText(input.fallbackTitle, "真实体验", 28),
    captions: captionTexts.map((text, index) => ({
      start: Number((index * segmentDuration).toFixed(2)),
      end: Number(Math.min(input.duration, (index + 1) * segmentDuration).toFixed(2)),
      text: text.slice(0, 42),
    })),
    model: "local-template",
    endpoint: "local-template",
    degraded: true,
  };
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });

  try {
    const body = await request.json() as {
      phase?: unknown;
      requestId?: unknown;
      frames?: unknown;
      duration?: unknown;
      template?: Record<string, unknown>;
      fallbackTitle?: unknown;
      fallbackSubtitle?: unknown;
      actualCost?: unknown;
    };
    const phase = String(body.phase || "reserve");
    const requestId = String(body.requestId || "").trim();
    if (!/^[a-zA-Z0-9_-]{8,120}$/.test(requestId)) {
      return Response.json({ error: "任务编号无效。" }, { status: 400 });
    }

    if (phase === "reserve") {
      await reserveAiPoints(member, "video_generate", 1, requestId, VIRAL_EDIT_POINTS);
      return Response.json({ requestId, points: VIRAL_EDIT_POINTS, wallet: await getWallet(member) });
    }

    if (phase === "analyze") {
      const frames = Array.isArray(body.frames)
        ? body.frames.filter((item): item is string => typeof item === "string" && /^data:image\/(?:jpeg|png|webp);base64,/i.test(item)).slice(0, 5)
        : [];
      const duration = Math.max(3, Math.min(180, Number(body.duration) || 15));
      const template = body.template ?? {};
      const fallbackTitle = cleanText(body.fallbackTitle, "", 28);
      const fallbackSubtitle = cleanText(body.fallbackSubtitle, "", 160);
      const userContent = [
        {
          type: "text",
          text: `视频时长：${duration.toFixed(1)}秒
已选模板：${JSON.stringify(template)}
请根据抽取的关键帧识别原片的真实主体、场景、动作、商品或服务内容，再生成一个短视频标题和按时间顺序出现的字幕。`,
        },
        ...frames.map((url) => ({ type: "image_url", image_url: { url, detail: "low" } })),
      ];
      const systemPrompt = `你是短视频后期内容导演。你的任务不是重写原片，而是从关键帧和当前任务信息中提炼原片内容，生成适合模板化后期叠加的标题和字幕。
要求：
1. 不虚构画面中没有出现的商品、服务、价格、功效、荣誉、顾客评价。
2. title为8到18个中文字，适合封面和开场标题。
3. captions为4到8段，每段8到22个中文字，时间连续递增，覆盖视频主要时段；字幕口语化、易读，不写镜头说明。
4. 第一段从0秒开始，最后一段结束时间不得超过视频时长。
5. 模板只影响语气和节奏，不得改变事实。
6. 只返回JSON，不要Markdown。格式：{"summary":"原片内容摘要","title":"视频标题","captions":[{"start":0,"end":2.5,"text":"字幕内容"}]}。`;
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ];
      let providerPayload: unknown = null;
      let endpoint: "chat-completions" | "responses" | "local-template" = "chat-completions";
      try {
        providerPayload = await lk888Fetch<ProviderChatResponse>("/v1/chat/completions", {
          method: "POST",
          signal: AbortSignal.timeout(42_000),
          body: JSON.stringify({
            model: "gpt-5.5",
            temperature: 0.45,
            max_tokens: 1400,
            response_format: { type: "json_object" },
            messages,
          }),
        });
        if (!extractText(providerPayload)) throw new AiProviderError("主分析通道没有返回有效内容。", 502);
      } catch {
        endpoint = "responses";
        try {
          providerPayload = await lk888Fetch<ProviderResponsesResponse>("/v1/responses", {
            method: "POST",
            signal: AbortSignal.timeout(42_000),
            body: JSON.stringify({
              model: "gpt-5.5",
              instructions: systemPrompt,
              input: [{
                role: "user",
                content: userContent.map((part) => "image_url" in part
                  ? { type: "input_image", image_url: part.image_url.url }
                  : { type: "input_text", text: part.text }),
              }],
              temperature: 0.45,
              max_output_tokens: 1400,
            }),
          });
          if (!extractText(providerPayload)) throw new AiProviderError("备用分析通道没有返回有效内容。", 502);
        } catch {
          endpoint = "local-template";
        }
      }
      if (endpoint === "local-template") {
        return Response.json(localTemplateAnalysis({
          duration,
          fallbackTitle,
          fallbackSubtitle,
        }));
      }
      const parsed = parseJson(extractText(providerPayload));
      const rawCaptions = Array.isArray(parsed.captions) ? parsed.captions : [];
      const captions = rawCaptions.map((item, index) => {
        const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
        const fallbackStart = index * duration / Math.max(1, rawCaptions.length);
        const fallbackEnd = (index + 1) * duration / Math.max(1, rawCaptions.length);
        const start = Math.max(0, Math.min(duration, Number(record.start) || fallbackStart));
        const end = Math.max(start + 0.4, Math.min(duration, Number(record.end) || fallbackEnd));
        return {
          start: Number(start.toFixed(2)),
          end: Number(end.toFixed(2)),
          text: cleanText(record.text, "", 42),
        };
      }).filter((item) => item.text);
      if (!captions.length) throw new AiProviderError("AI 没有生成可用字幕，请重新处理。", 502);
      return Response.json({
        summary: cleanText(parsed.summary, "已根据原片关键帧完成内容分析。", 180),
        title: cleanText(parsed.title, "真实体验", 28),
        captions,
        model: "gpt-5.5",
        endpoint,
        degraded: false,
      });
    }

    if (phase === "settle") {
      const actualCost = Math.max(0, Math.min(VIRAL_EDIT_POINTS, Math.ceil(Number(body.actualCost) || 0)));
      return Response.json({
        requestId,
        points: actualCost,
        wallet: await settleAiPointsByRequest(member, requestId, actualCost),
      });
    }

    if (phase === "refund") {
      return Response.json({
        requestId,
        points: 0,
        wallet: await refundAiPointsByRequest(member, requestId),
      });
    }

    return Response.json({ error: "不支持的任务阶段。" }, { status: 400 });
  } catch (error) {
    return pointsErrorResponse(error) ?? aiErrorResponse(error);
  }
}
