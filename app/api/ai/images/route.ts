import { getMemberSession } from "../../../member-session";
import { aiErrorResponse, lk888Fetch } from "../../../../lib/lk888";
import { ensureProviderBalance, providerCostToPoints, quoteGptImage2 } from "../../../../lib/ai-pricing";
import { getWallet, pointsErrorResponse, refundAiPoints, refundAiPointsByRequest, reserveAiPoints, settleAiPointsByRequest } from "../../../../lib/points";
import { createAiTask, getAiTask, updateAiTask } from "../../../../lib/server/ai-tasks";

type ProviderImageResponse = Record<string, unknown>;
type NormalizedImagePayload = ReturnType<typeof normalizedPayload>;

const allowedNamedSizes = new Set([
  "auto", "1024x1024", "1024x1536", "1536x1024", "960x1280", "1280x960",
  "1088x1920", "1920x1088", "2048x2048", "2048x3072", "3072x2048", "1920x2560",
  "2560x1920", "1440x2560", "2560x1440", "2880x2880", "2304x3456", "3456x2304",
  "2400x3200", "3200x2400", "2160x3840", "3840x2160", "1536x864", "1280x1024",
]);

function normalizeSize(value: unknown) {
  const size = typeof value === "string" ? value.toLowerCase() : "auto";
  return allowedNamedSizes.has(size) ? size : "auto";
}

function collectUrls(value: unknown, target = new Set<string>()) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^https?:\/\//i.test(trimmed) || /^data:image\//i.test(trimmed)) target.add(trimmed);
    else if ((trimmed.startsWith("[") || trimmed.startsWith("{")) && trimmed.length < 100_000) {
      try { collectUrls(JSON.parse(trimmed), target); } catch { /* provider may return a plain status string */ }
    }
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectUrls(item, target));
  } else if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => {
      if (["url", "result_url", "image_url", "images", "data", "output"].includes(key)) collectUrls(item, target);
    });
  }
  return [...target].slice(0, 4);
}

function findField(value: unknown, keys: string[], depth = 0): unknown {
  if (!value || typeof value !== "object" || depth > 5) return undefined;
  if (!Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
    }
    for (const nested of Object.values(record)) {
      const found = findField(nested, keys, depth + 1);
      if (found !== undefined) return found;
    }
  } else {
    for (const nested of value) {
      const found = findField(nested, keys, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function normalizedPayload(data: ProviderImageResponse) {
  const urls = collectUrls(data);
  const taskId = findField(data, ["task_id", "taskId", "taskid", "id"]) ?? null;
  const providerState = findField(data, ["state", "task_state"]);
  const providerFinal = findField(data, ["is_final", "isFinal"]);
  const providerProgress = findField(data, ["progress"]);
  const providerError = findField(data, ["error", "error_message"]);
  const rawProviderCost = findField(data, ["cost"]);
  const providerCost = Number(rawProviderCost ?? 0);
  const providerRefunded = findField(data, ["refunded"]);
  const state = typeof providerState === "string"
    ? providerState
    : urls.length
      ? "success"
      : "pending";
  const isFinal = typeof providerFinal === "boolean"
    ? providerFinal
    : state === "success" || state === "failed" || urls.length > 0;

  return {
    taskId: taskId === null ? null : String(taskId),
    state,
    isFinal,
    progress: typeof providerProgress === "string" ? providerProgress : isFinal ? "100%" : "0%",
    urls,
    error: typeof providerError === "string" ? providerError : "",
    cost: Number.isFinite(providerCost) ? Math.max(0, providerCost) : 0,
    costKnown: rawProviderCost !== undefined,
    refunded: providerRefunded === true,
  };
}

function aggregateTasks(tasks: NormalizedImagePayload[]) {
  const urls = [...new Set(tasks.flatMap((task) => task.urls))].slice(0, 4);
  const taskIds = [...new Set(tasks.map((task) => task.taskId).filter((id): id is string => Boolean(id)))];
  const allFinal = tasks.length > 0 && tasks.every((task) => task.isFinal);
  const allFailed = allFinal && tasks.every((task) => task.state === "failed");
  const progressValues = tasks.map((task) => Number.parseInt(task.progress, 10)).filter(Number.isFinite);
  const averageProgress = progressValues.length
    ? Math.round(progressValues.reduce((total, value) => total + value, 0) / progressValues.length)
    : allFinal ? 100 : 0;
  const providerCost = tasks.reduce((total, task) => total + task.cost, 0);
  const costKnown = tasks.length > 0 && tasks.every((task) => task.costKnown);

  return {
    taskId: taskIds[0] ?? null,
    taskIds,
    state: allFailed ? "failed" : allFinal ? "success" : "running",
    isFinal: allFinal,
    progress: `${averageProgress}%`,
    urls,
    error: tasks.map((task) => task.error).filter(Boolean).join("；"),
    providerCost: Number(providerCost.toFixed(6)),
    actualPoints: allFinal && costKnown ? providerCostToPoints(providerCost) : null,
    costKnown,
    refunded: tasks.length > 0 && tasks.every((task) => task.refunded || task.state === "failed"),
  };
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });

  let reservation: Awaited<ReturnType<typeof reserveAiPoints>> | null = null;
  let usableResult = false;
  try {
    const body = await request.json() as { prompt?: unknown; size?: unknown; quality?: unknown; images?: unknown; copies?: unknown; section?: unknown; count?: unknown; navigationShape?: unknown; customerShape?: unknown; navigationLabels?: unknown; package?: unknown; requestId?: unknown };
    const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 5000) : "";
    if (prompt.length < 8) return Response.json({ error: "请补充更完整的图片生成要求。" }, { status: 400 });
    const images = Array.isArray(body.images)
      ? body.images.filter((item): item is string => typeof item === "string" && (/^https?:\/\//i.test(item) || /^data:image\//i.test(item))).slice(0, 10)
      : [];
    const quality = ["auto", "high", "medium", "low"].includes(String(body.quality)) ? String(body.quality) : "auto";
    const section = typeof body.section === "string" ? body.section : "";
    const requestedCount = section === "营销海报" ? 3 : Math.max(1, Math.min(4, Number(body.count) || 4));
    const fixedSectionSizes: Record<string, string> = {
      "门店招牌": "1536x864",
      "服务导航": "1536x1024",
      "横幅配置": "1536x864",
      "团购套餐": "1280x1024",
      "客服配置": "1024x1024",
      "小绿书制作": "960x1280",
    };
    const outputSize = fixedSectionSizes[section] ?? normalizeSize(body.size);
    const navigationShape = body.navigationShape === "circle" ? "circle" : "square";
    const customerShape = body.customerShape === "square" ? "square" : "circle";
    const navigationLabels = Array.isArray(body.navigationLabels)
      ? body.navigationLabels.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, 12)).slice(0, 4)
      : [];
    const navigationInstruction = section === "服务导航"
      ? `这是小程序服务导航按钮图案设计。四项功能依次为：${navigationLabels.join("、") || "项目预约、团购入口、到店打卡、我的订单"}。每套方案必须只生成一张包含四枚按钮图案的横向素材，四枚按钮从左到右与功能顺序严格一致、等宽等距、边界清楚，方便平均切分。每枚按钮外轮廓必须是${navigationShape === "circle" ? "完整圆形" : "四角圆角正方形"}，图案居中且保持安全留白。文字仅用于理解功能语义，图片内严禁出现任何文字、字母、数字、价格、标语、水印或Logo。四枚图案要含义不同，但线条、底色、图案色、光影和视觉重量必须统一。`
      : "";
    const packageInput = body.package && typeof body.package === "object"
      ? body.package as Record<string, unknown>
      : {};
    const packageTitle = typeof packageInput.title === "string" ? packageInput.title.trim().slice(0, 80) : "当前团购套餐";
    const packageTextMode = packageInput.textMode === "with-text" ? "with-text" : "without-text";
    const packageInstruction = section === "团购套餐"
      ? packageTextMode === "with-text"
        ? `这是团购链接“${packageTitle || "当前团购套餐"}”的独立5:4主图设计。画面必须带有团购标题“${packageTitle || "当前团购套餐"}”，请在安全区内准确、清晰地完成中文排版，不得错字、漏字或乱码；缩小到小程序团购列表后仍应易读。除该团购标题外，严禁出现价格、原价、销量、折扣、购买按钮、二维码、角标、水印或无关文字。画面主体必须与套餐商品、服务成果或核心体验直接相关，真实可信，不得虚构套餐没有提供的项目。最终按1000×800比例使用。`
        : `这是团购链接“${packageTitle || "当前团购套餐"}”的独立5:4主图设计。团购标题只用于理解套餐内容，不得画入图片；图片中严禁出现任何文字、字母、数字、价格、原价、销量、折扣、购买按钮、二维码、角标或水印。画面主体必须与套餐商品、服务成果或核心体验直接相关，真实可信，不得虚构套餐没有提供的项目。最终按1000×800比例使用。`
      : "";
    const bannerInstruction = section === "横幅配置"
      ? "这是小程序店铺页面的横向品牌横幅，输出必须为16:9构图、固定1536×864。结合本次需求和参考素材表现核心商品、服务或活动氛围，主体清晰，重要内容放在移动端安全区域；不要生成无关水印、二维码或虚假价格信息。"
      : "";
    const customerInstruction = section === "客服配置"
      ? `这是小程序浮动客服入口图标。只设计一枚1:1客服图标，外轮廓必须为${customerShape === "circle" ? "完整圆形" : "四角圆角方形"}，主体居中、轮廓简洁、友好亲切，缩小后仍清晰可辨，并与商家品牌色统一。背景干净，不要出现文字、字母、数字、二维码、复杂场景或水印。`
      : "";
    const referenceInstruction = images.length
      ? `本任务包含${images.length}张参考图。必须重点参考其风格样式、构图关系、光线与色彩氛围，同时结合本次生成要求重新设计；不要机械复制参考图中的无关文字或水印。`
      : "本任务没有参考图，请完全依据本次文字要求、主题色系与生成要求进行文生图设计。";
    const littleGreenCopies = Array.isArray(body.copies)
      ? body.copies.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, 360)).slice(0, 3)
      : [];
    const littleGreenInstruction = section === "小绿书制作"
      ? "这是小绿书图文笔记的3:4竖版主图。完整发布文案会在图片下方独立展示，所以图片只负责视觉吸引与主题表达，不要把长段正文画进图片；最多保留一句不超过12个汉字的准确中文封面钩子。主体位于移动端安全区，视觉自然、真实、有生活感，缩略图状态下仍清晰，不得出现虚假价格、效果承诺、无关Logo、水印或乱码。"
      : "";
    const quote = await quoteGptImage2({ size: outputSize, quality, count: requestedCount, referenceCount: images.length });
    await ensureProviderBalance(quote.estimatedProviderCost);
    reservation = await reserveAiPoints(member, "image_generate", requestedCount, body.requestId, quote.estimatedPoints);
    createAiTask(member, {
      id: reservation.requestId,
      kind: "image",
      provider: "lk888",
      payload: {
        model: "gpt-image-2",
        section,
        prompt: prompt.slice(0, 1200),
        size: outputSize,
        quality,
        requestedCount,
        referenceCount: images.length,
      },
      pointsReserved: reservation.reservedCost,
    });

    const directions = section === "小绿书制作"
      ? [
        "方案一（故事场景型）：用一个真实生活场景作为视觉钩子，强调到店或使用体验，情绪自然克制。",
        "方案二（信息价值型）：主体清晰、信息层级明确，突出最值得收藏的服务亮点或实用价值。",
        "方案三（视觉氛围型）：以品牌气质、光线、材质和生活方式氛围取胜，画面简洁有记忆点。",
      ]
      : section === "营销海报"
        ? [
          "生成变体一（构图基准）：严格执行用户已经选择的创意方向、营销目标与参考图角色，以最清晰的主视觉层级完成一张可投放成品。",
          "生成变体二（镜头变化）：保持同一创意方向、品牌锚点、真实约束和安全区不变，改变镜头距离、主体姿态或场景纵深，不能变成另一套概念。",
          "生成变体三（编辑强化）：保持同一创意方向与事实信息不变，强化材质细节、视觉节奏和缩略图辨识度，仍需保留指定的后期文字安全区。",
        ]
        : [
          "方案一：主体清晰、经典稳妥、适合首屏展示。",
          "方案二：构图更有生活感，强调真实体验与氛围。",
          "方案三：视觉更现代简洁，突出品牌色和留白。",
          "方案四：画面更有传播力，但保持真实可信。",
        ];
    const settled = await Promise.allSettled(directions.slice(0, requestedCount).map((direction, index) => lk888Fetch<ProviderImageResponse>("/v1/media/generate", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-image-2",
        prompt: `${prompt}\n${referenceInstruction}\n${section === "门店招牌" ? "输出必须为横向16:9门店首页招牌图，固定1536×864，重要主体与品牌信息放在移动端安全区域内。" : ""}\n${navigationInstruction}\n${bannerInstruction}\n${packageInstruction}\n${customerInstruction}\n${littleGreenInstruction}\n${littleGreenCopies[index] ? `本方案对应的小绿书发布文案如下，只提炼其主题和视觉线索，不要把整段文字排进图片：${littleGreenCopies[index]}` : ""}\n${direction}`,
        params: {
          size: outputSize,
          quality,
          images,
          n: 1,
          response_format: "url",
        },
      }),
    })));
    const tasks = settled
      .filter((result): result is PromiseFulfilledResult<ProviderImageResponse> => result.status === "fulfilled")
      .map((result) => normalizedPayload(result.value));
    if (!tasks.length) {
      const firstError = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
      throw firstError?.reason ?? new Error("图片任务创建失败");
    }
    usableResult = true;
    const aggregate = aggregateTasks(tasks);
    const chargedPoints = aggregate.actualPoints ?? quote.estimatedPoints;
    const wallet = aggregate.isFinal
      ? aggregate.state === "failed"
        ? await refundAiPointsByRequest(member, reservation.requestId)
        : await settleAiPointsByRequest(member, reservation.requestId, chargedPoints)
      : await getWallet(member);
    updateAiTask(member, reservation.requestId, {
      providerTaskIds: aggregate.taskIds,
      state: aggregate.state as "running" | "success" | "failed",
      progress: Number.parseInt(aggregate.progress, 10) || 0,
      result: { urls: aggregate.urls, model: "gpt-image-2", section, size: outputSize },
      error: aggregate.error,
      pointsCharged: aggregate.isFinal && aggregate.state === "success" ? chargedPoints : 0,
    });

    return Response.json({ ...aggregate, model: "gpt-image-2", requestId: reservation.requestId, pricing: quote, wallet });
  } catch (error) {
    if (reservation && !usableResult) {
      await refundAiPoints(reservation).catch(() => undefined);
      updateAiTask(member, reservation.requestId, {
        state: "failed",
        progress: 100,
        error: error instanceof Error ? error.message : "图片任务创建失败",
      });
    }
    return pointsErrorResponse(error) ?? aiErrorResponse(error);
  }
}

export async function GET(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });

  const url = new URL(request.url);
  const taskIds = (url.searchParams.get("task_ids") || url.searchParams.get("task_id") || "")
    .split(",")
    .map((taskId) => taskId.trim())
    .filter(Boolean)
    .slice(0, 4);
  if (!taskIds.length) return Response.json({ error: "缺少任务编号。" }, { status: 400 });
  const requestId = url.searchParams.get("request_id") || "";

  try {
    const settled = await Promise.allSettled(taskIds.map((taskId) => lk888Fetch<ProviderImageResponse>(`/v1/skills/task-status?task_id=${encodeURIComponent(taskId)}`)));
    const tasks = settled
      .filter((result): result is PromiseFulfilledResult<ProviderImageResponse> => result.status === "fulfilled")
      .map((result) => normalizedPayload(result.value));
    if (!tasks.length) {
      const firstError = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
      throw firstError?.reason ?? new Error("图片任务查询失败");
    }
    const aggregate = aggregateTasks(tasks);
    const stored = requestId ? getAiTask(member, requestId) : null;
    const chargedPoints = aggregate.actualPoints ?? stored?.pointsReserved ?? 0;
    const wallet = aggregate.isFinal && requestId
      ? aggregate.state === "failed"
        ? await refundAiPointsByRequest(member, requestId)
        : await settleAiPointsByRequest(member, requestId, chargedPoints)
      : await getWallet(member);
    if (requestId) updateAiTask(member, requestId, {
      providerTaskIds: aggregate.taskIds,
      state: aggregate.state as "running" | "success" | "failed",
      progress: Number.parseInt(aggregate.progress, 10) || 0,
      result: { urls: aggregate.urls, model: "gpt-image-2" },
      error: aggregate.error,
      pointsCharged: aggregate.isFinal && aggregate.state === "success" ? chargedPoints : 0,
    });
    return Response.json({ ...aggregate, model: "gpt-image-2", requestId: requestId || null, wallet });
  } catch (error) {
    return aiErrorResponse(error);
  }
}
