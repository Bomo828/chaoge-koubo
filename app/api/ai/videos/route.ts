import { getMemberSession } from "../../../member-session";
import { AiProviderError, aiErrorResponse, lk888Fetch } from "../../../../lib/lk888";
import { providerCostToPoints } from "../../../../lib/ai-pricing";
import { getWallet, pointsErrorResponse, refundAiPoints, refundAiPointsByRequest, reserveAiPoints, settleAiPointsByRequest } from "../../../../lib/points";
import { quoteMerchantVideo } from "../../../../lib/video-pricing";
import { createAiTask, getAiTask, updateAiTask } from "../../../../lib/server/ai-tasks";

type ProviderPayload = Record<string, unknown>;

function findField(value: unknown, keys: string[], depth = 0): unknown {
  if (!value || typeof value !== "object" || depth > 5) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findField(item, keys, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
  }
  for (const item of Object.values(record)) {
    const found = findField(item, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function normalizedPayload(data: ProviderPayload) {
  const rawTaskId = findField(data, ["task_id", "taskId", "taskid", "任务id", "任务ID", "任务ids", "id"]);
  const taskId = Array.isArray(rawTaskId) ? rawTaskId[0] : rawTaskId;
  const stateValue = findField(data, ["state", "task_state"]);
  const resultUrl = findField(data, ["result_url", "url", "video_url"]);
  const finalValue = findField(data, ["is_final", "isFinal"]);
  const progressValue = findField(data, ["progress"]);
  const errorValue = findField(data, ["error", "error_message"]);
  const costValue = findField(data, ["cost"]);
  const state = typeof stateValue === "string" ? stateValue : typeof resultUrl === "string" ? "success" : "pending";
  const isFinal = typeof finalValue === "boolean" ? finalValue : state === "success" || state === "failed";
  const providerCost = Math.max(0, Number(costValue) || 0);
  return {
    taskId: taskId === undefined ? null : String(taskId),
    state,
    isFinal,
    progress: typeof progressValue === "string" ? progressValue : isFinal ? "100%" : "0%",
    resultUrl: typeof resultUrl === "string" ? resultUrl : "",
    error: typeof errorValue === "string" ? errorValue : "",
    providerCost,
    actualPoints: isFinal && costValue !== undefined ? providerCostToPoints(providerCost) : null,
  };
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });

  let reservation: Awaited<ReturnType<typeof reserveAiPoints>> | null = null;
  let submitted = false;
  try {
    const body = await request.json() as {
      prompt?: unknown;
      images?: unknown;
      duration?: unknown;
      resolution?: unknown;
      version?: unknown;
      projectName?: unknown;
      requestId?: unknown;
    };
    const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 6000) : "";
    if (prompt.length < 20) return Response.json({ error: "请先完成视频分镜和生成提示词。" }, { status: 400 });
    const images = Array.isArray(body.images)
      ? body.images.filter((item): item is string => typeof item === "string" && (/^data:image\//i.test(item) || /^https?:\/\//i.test(item))).slice(0, 9)
      : [];
    if (!images.length) return Response.json({ error: "参考生视频至少需要一张图片素材。" }, { status: 400 });
    const quote = await quoteMerchantVideo({ duration: Number(body.duration), resolution: String(body.resolution || ""), version: String(body.version || "") });
    reservation = await reserveAiPoints(member, "video_generate", 1, body.requestId, quote.reservedPoints);
    const projectName = typeof body.projectName === "string" ? body.projectName.slice(0, 80) : "素材智能成片";
    createAiTask(member, {
      id: reservation.requestId,
      kind: "video",
      provider: "lk888",
      payload: {
        model: quote.model,
        projectName,
        prompt: prompt.slice(0, 1600),
        referenceCount: images.length,
        duration: quote.duration,
        resolution: quote.resolution,
        version: quote.version,
      },
      pointsReserved: reservation.reservedCost,
    });

    const provider = await lk888Fetch<ProviderPayload>("/v1/media/generate", {
      method: "POST",
      signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({
        model: quote.model,
        prompt,
        params: {
          images,
          version: quote.version,
          resolution: quote.resolution,
          duration: String(quote.duration),
          aspect_ratio: quote.aspectRatio,
        },
      }),
    });
    const task = normalizedPayload(provider);
    if (!task.taskId && !task.resultUrl) {
      throw new AiProviderError("Seedance 任务响应中没有任务编号或视频地址，已自动退回本次预授权积分。", 502);
    }
    submitted = true;
    const chargedPoints = task.actualPoints ?? quote.reservedPoints;
    const wallet = task.isFinal
      ? task.state === "failed"
        ? await refundAiPointsByRequest(member, reservation.requestId)
        : await settleAiPointsByRequest(member, reservation.requestId, chargedPoints)
      : await getWallet(member);
    updateAiTask(member, reservation.requestId, {
      providerTaskIds: task.taskId ? [task.taskId] : [],
      state: task.state as "pending" | "running" | "success" | "failed",
      progress: Number.parseInt(task.progress, 10) || 0,
      result: { resultUrl: task.resultUrl, model: quote.model, projectName },
      error: task.error,
      pointsCharged: task.isFinal && task.state === "success" ? chargedPoints : 0,
    });
    return Response.json({
      ...task,
      model: quote.model,
      modelDisplayName: quote.displayName,
      projectName,
      requestId: reservation.requestId,
      quote,
      wallet,
    });
  } catch (error) {
    if (reservation && !submitted) {
      await refundAiPoints(reservation).catch(() => undefined);
      updateAiTask(member, reservation.requestId, {
        state: "failed",
        progress: 100,
        error: error instanceof Error ? error.message : "视频任务创建失败",
      });
    }
    return pointsErrorResponse(error) ?? aiErrorResponse(error);
  }
}

export async function GET(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });

  const url = new URL(request.url);
  const requestId = url.searchParams.get("request_id") || "";
  if (url.searchParams.get("media") === "1") {
    const stored = requestId ? getAiTask(member, requestId) : null;
    const resultUrl = typeof stored?.result.resultUrl === "string" ? stored.result.resultUrl : "";
    if (!stored || stored.kind !== "video" || stored.state !== "success" || !resultUrl) {
      return Response.json({ error: "这个视频镜头尚未生成完成。" }, { status: 404 });
    }
    let sourceUrl: URL;
    try {
      sourceUrl = new URL(resultUrl);
      if (sourceUrl.protocol !== "https:" && sourceUrl.protocol !== "http:") throw new Error("invalid protocol");
    } catch {
      return Response.json({ error: "视频结果地址无效。" }, { status: 502 });
    }
    try {
      const source = await fetch(sourceUrl, { signal: AbortSignal.timeout(120_000) });
      if (!source.ok || !source.body) return Response.json({ error: "视频镜头暂时无法读取，请稍后重试。" }, { status: 502 });
      const headers = new Headers({
        "Content-Type": source.headers.get("content-type") || "video/mp4",
        "Cache-Control": "private, max-age=300",
        "Content-Disposition": "inline",
      });
      const contentLength = source.headers.get("content-length");
      if (contentLength) headers.set("Content-Length", contentLength);
      return new Response(source.body, { status: 200, headers });
    } catch (error) {
      return aiErrorResponse(error);
    }
  }
  const taskId = url.searchParams.get("task_id") || "";
  if (!taskId) {
    try {
      const quote = await quoteMerchantVideo({
        duration: Number(url.searchParams.get("duration")),
        resolution: url.searchParams.get("resolution") || "720p",
        version: url.searchParams.get("version") || "快速",
      });
      return Response.json({ quote });
    } catch (error) {
      return aiErrorResponse(error);
    }
  }
  try {
    const provider = await lk888Fetch<ProviderPayload>(`/v1/skills/task-status?task_id=${encodeURIComponent(taskId)}`, { cache: "no-store" });
    const task = normalizedPayload(provider);
    const stored = requestId ? getAiTask(member, requestId) : null;
    const chargedPoints = task.actualPoints ?? stored?.pointsReserved ?? 0;
    const wallet = task.isFinal && requestId
      ? task.state === "failed"
        ? await refundAiPointsByRequest(member, requestId)
        : await settleAiPointsByRequest(member, requestId, chargedPoints)
      : await getWallet(member);
    if (requestId) updateAiTask(member, requestId, {
      providerTaskIds: task.taskId ? [task.taskId] : [taskId],
      state: task.state as "pending" | "running" | "success" | "failed",
      progress: Number.parseInt(task.progress, 10) || 0,
      result: { resultUrl: task.resultUrl, model: stored?.input.model || "kwvideo-v2-ref" },
      error: task.error,
      pointsCharged: task.isFinal && task.state === "success" ? chargedPoints : 0,
    });
    return Response.json({ ...task, model: stored?.input.model || "kwvideo-v2-ref", requestId: requestId || null, wallet });
  } catch (error) {
    return pointsErrorResponse(error) ?? aiErrorResponse(error);
  }
}
