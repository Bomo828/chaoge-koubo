import { getMemberSession } from "../../../../member-session";
import { providerCostToPoints } from "../../../../../lib/ai-pricing";
import { AiProviderError, aiErrorResponse, lk888Request } from "../../../../../lib/lk888";
import { getWallet, pointsErrorResponse, refundAiPoints, reserveAiPoints, settleAiPointsByRequest } from "../../../../../lib/points";
import { billablePointsFromCost } from "../../../../../lib/billing";
import { ownsAgentConversation, rememberAgentConversation, rememberAgentTask } from "../../../../../lib/server/agent-conversations";

export const runtime = "nodejs";
export const maxDuration = 900;

type AgentSettings = Record<string, unknown>;

function text(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function conversationTitle(message: string) {
  return message.replace(/\s+/g, " ").trim().slice(0, 30) || "新对话";
}

function settingsFrom(value: unknown): AgentSettings {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const enabled = (key: string, fallback: boolean) => typeof source[key] === "boolean" ? source[key] : fallback;
  const generateImage = enabled("generate_image", true);
  return {
    web_search: enabled("web_search", true),
    url_fetch: enabled("url_fetch", true),
    history_recall: enabled("history_recall", true),
    memory: enabled("memory", true),
    carry_history: true,
    generate_image: generateImage,
    ...(generateImage ? { image_models: ["gpt-image-2"], image_limit: 2 } : {}),
    generate_video: false,
    generate_audio: false,
    document_generate: true,
    media_process: true,
    mindmap: false,
    chart: false,
    deep_research: enabled("deep_research", false),
    smart_context: true,
    doc_summary: true,
    task_budget_tokens: 160_000,
  };
}

function normalizeTaskIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter((item) => /^\d{1,30}$/.test(item)).slice(0, 8);
}

function providerJsonError(raw: string) {
  try {
    const payload = JSON.parse(raw) as { msg?: unknown; error?: { message?: unknown } };
    if (typeof payload.msg === "string" && payload.msg.trim()) return payload.msg.trim();
    if (typeof payload.error?.message === "string" && payload.error.message.trim()) return payload.error.message.trim();
  } catch {
    // Preserve the generic message when the provider did not return JSON.
  }
  return "AI 助手暂时无法开始对话，请稍后重试。";
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });

  let reservation: Awaited<ReturnType<typeof reserveAiPoints>> | null = null;
  try {
    const body = await request.json() as Record<string, unknown>;
    const message = text(body.message, 30_000);
    const model = text(body.model, 100) || "gpt-5.4-mini";
    const conversationId = text(body.conversation_id, 180);
    if (!message) return Response.json({ error: "请输入要发送的内容。" }, { status: 400 });
    if (!/^[a-zA-Z0-9_./-]{2,100}$/.test(model)) return Response.json({ error: "聊天模型无效。" }, { status: 400 });
    if (conversationId && !ownsAgentConversation(member.id, conversationId)) {
      return Response.json({ error: "没有权限继续这个对话。" }, { status: 403 });
    }

    const attachments = Array.isArray(body.attachments)
      ? body.attachments.filter((item): item is string => typeof item === "string" && (/^https:\/\//i.test(item) || /^data:image\/(?:png|jpeg|webp);base64,/i.test(item))).slice(0, 8)
      : [];
    const requestId = text(body.request_id, 100) || `assistant_${crypto.randomUUID()}`;
    const reservedPoints = Math.max(20, Math.min(500, Number(process.env.AI_ASSISTANT_RESERVE_POINTS) || 100));
    reservation = await reserveAiPoints(member, "chat_assistant", 1, requestId, reservedPoints);

    const upstream = await lk888Request("/v1/agent/chat", {
      method: "POST",
      signal: AbortSignal.timeout(15 * 60_000),
      body: JSON.stringify({
        model,
        message,
        ...(conversationId ? { conversation_id: conversationId } : {}),
        ...(attachments.length ? { attachments } : {}),
        memory_id: member.id,
        system_prompt: "你是爆点实验室的 AI 助手。优先帮助商家完成内容策划、营销分析、资料整理和创作决策；涉及价格、资质、销量、功效或客户案例时，不得虚构未经用户确认的事实。回答使用清晰自然的中文。",
        settings: settingsFrom(body.settings),
        params: { temperature: 0.65 },
      }),
    });

    const contentType = upstream.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream") || !upstream.body) {
      const raw = await upstream.text();
      await refundAiPoints(reservation);
      reservation = null;
      return Response.json({ error: providerJsonError(raw) }, { status: upstream.ok ? 400 : upstream.status });
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    let buffer = "";
    let streamedConversationId = conversationId;
    let providerCost = 0;
    let failed = false;
    let completed = false;

    const inspectLine = (line: string) => {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!data || data === "[DONE]") return;
      try {
        const frame = JSON.parse(data) as Record<string, unknown>;
        if (frame.type === "meta" && typeof frame.conversation_id === "string") {
          streamedConversationId = frame.conversation_id;
          rememberAgentConversation(member.id, {
            conversationId: streamedConversationId,
            model,
            title: conversationTitle(message),
          });
        }
        if (frame.type === "usage") providerCost = Math.max(0, Number(frame.cost) || 0);
        if (frame.type === "generation_status" && frame.stage === "submitted") {
          for (const taskId of normalizeTaskIds(frame.task_ids)) {
            rememberAgentTask(member.id, taskId, streamedConversationId, text(frame.result_type, 30));
          }
        }
        if (frame.type === "error") failed = true;
        if (frame.type === "done") {
          completed = frame.status === "completed";
          if (frame.status === "failed") failed = true;
        }
      } catch {
        // Malformed and unknown frames are passed through and ignored.
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";
            for (const line of lines) inspectLine(line);
          }
          if (buffer) inspectLine(buffer);

          let wallet = await getWallet(member);
          let chargedPoints = 0;
          if (!failed && completed) {
            chargedPoints = providerCostToPoints(providerCost);
            wallet = await settleAiPointsByRequest(member, requestId, chargedPoints);
            if (streamedConversationId) {
              rememberAgentConversation(member.id, {
                conversationId: streamedConversationId,
                model,
                title: conversationTitle(message),
                cost: providerCost,
              });
            }
          } else if (reservation) {
            await refundAiPoints(reservation);
            wallet = await getWallet(member);
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "wallet", points: wallet.points, cost: providerCost, cost_points: billablePointsFromCost(chargedPoints) })}\n\n`));
        } catch (error) {
          if (reservation) await refundAiPoints(reservation).catch(() => undefined);
          const message = error instanceof Error ? error.message : "AI 助手连接中断。";
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message })}\n\n`));
        } finally {
          controller.close();
          reader.releaseLock();
        }
      },
      async cancel() {
        await reader.cancel().catch(() => undefined);
        if (reservation) await refundAiPoints(reservation).catch(() => undefined);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (reservation) await refundAiPoints(reservation).catch(() => undefined);
    const pointsFailure = pointsErrorResponse(error);
    if (pointsFailure) return pointsFailure;
    if (error instanceof AiProviderError) return aiErrorResponse(error);
    console.error("AI assistant chat failed", error);
    return Response.json({ error: "AI 助手暂时不可用，请稍后再试。" }, { status: 500 });
  }
}
