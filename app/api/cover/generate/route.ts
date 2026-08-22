import { getMemberSession } from "../../../member-session";
import { AiProviderError, aiErrorResponse, lk888Fetch } from "../../../../lib/lk888";
import { ensureProviderBalance, providerCostToPoints, quoteGptImage2 } from "../../../../lib/ai-pricing";
import { pointsErrorResponse, refundAiPoints, reserveAiPoints, settleAiPointsByRequest } from "../../../../lib/points";

type ProviderPayload = Record<string, unknown>;

function nestedField(value: unknown, keys: string[], depth = 0): unknown {
  if (!value || typeof value !== "object" || depth > 8) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = nestedField(item, keys, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
  }
  for (const item of Object.values(record)) {
    const found = nestedField(item, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function collectUrls(value: unknown, result = new Set<string>()) {
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) result.add(value);
    else if ((value.startsWith("{") || value.startsWith("[")) && value.length < 100_000) {
      try { collectUrls(JSON.parse(value), result); } catch { /* provider status text */ }
    }
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectUrls(item, result));
  } else if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => {
      if (["url", "image_url", "result_url", "resultUrl", "data", "images", "output"].includes(key)) collectUrls(item, result);
    });
  }
  return [...result];
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ ok: false, error: "请先登录会员账号。" }, { status: 401 });

  let reservation: Awaited<ReturnType<typeof reserveAiPoints>> | null = null;
  let completed = false;
  try {
    const body = await request.json() as Record<string, unknown>;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 4000) : "";
    if (!prompt) return Response.json({ ok: false, error: "封面提示词不能为空。" }, { status: 400 });
    const sourceReferences = Array.isArray(body.references) ? body.references : [];
    if (sourceReferences.length > 10) return Response.json({ ok: false, error: "参考图数量不能超过 10 张。" }, { status: 400 });
    const references = sourceReferences.filter((item): item is string => (
      typeof item === "string" && (/^data:image\//i.test(item) || /^https:\/\//i.test(item))
    ));
    if (references.length !== sourceReferences.length) return Response.json({ ok: false, error: "参考图格式不正确。" }, { status: 400 });

    const quote = await quoteGptImage2({ size: "960x1280", quality: "high", count: 1, referenceCount: references.length });
    await ensureProviderBalance(quote.estimatedProviderCost);
    reservation = await reserveAiPoints(member, "image_generate", 1, body.request_id, quote.estimatedPoints);
    const created = await lk888Fetch<ProviderPayload>("/v1/media/generate", {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: "gpt-image-2",
        prompt,
        params: { size: "960x1280", quality: "high", images: references, n: 1, response_format: "url" },
      }),
    });

    let taskId = String(nestedField(created, ["task_id", "taskId", "taskid", "id"]) || "");
    let finalPayload: ProviderPayload = created;
    let urls = collectUrls(created);
    if (!urls.length && !taskId) throw new AiProviderError("图片服务未返回任务编号。", 502);

    for (let attempt = 0; !urls.length && attempt < 120; attempt += 1) {
      await wait(3000);
      finalPayload = await lk888Fetch<ProviderPayload>(`/v1/skills/task-status?task_id=${encodeURIComponent(taskId)}`, { cache: "no-store" });
      taskId = String(nestedField(finalPayload, ["task_id", "taskId", "taskid", "id"]) || taskId);
      const state = String(nestedField(finalPayload, ["state", "task_state", "status"]) || "").toLowerCase();
      const isFinal = nestedField(finalPayload, ["is_final", "isFinal"]) === true;
      if (["failed", "error", "cancelled", "canceled"].includes(state)) {
        throw new AiProviderError(String(nestedField(finalPayload, ["error", "message", "msg"]) || "图片生成失败。"), 502);
      }
      urls = collectUrls(finalPayload);
      if (isFinal && !urls.length) throw new AiProviderError("图片任务完成但没有返回图片。", 502);
    }
    if (!urls.length) throw new AiProviderError("图片生成等待超时，请重试。", 504);

    const providerCost = Number(nestedField(finalPayload, ["cost"]));
    const chargedPoints = Number.isFinite(providerCost) && providerCost > 0 ? providerCostToPoints(providerCost) : quote.estimatedPoints;
    const wallet = await settleAiPointsByRequest(member, reservation.requestId, chargedPoints);
    completed = true;
    return Response.json({
      ok: true,
      task_id: taskId,
      image_url: urls[0],
      model: "gpt-image-2",
      size: "960x1280",
      wallet,
    });
  } catch (error) {
    if (reservation && !completed) await refundAiPoints(reservation).catch(() => undefined);
    return pointsErrorResponse(error) ?? aiErrorResponse(error);
  }
}
