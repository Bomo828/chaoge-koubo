import { createHash } from "node:crypto";
import { getMemberSession } from "../../../member-session";
import { lk888Fetch } from "../../../../lib/lk888";
import {
  buildViralDirectorPlan,
  markViralKeywordSfx,
  sanitizeViralCaptionPlan,
  VIRAL_DIRECTOR_PROMPT_VERSION,
  type ViralCaptionPlanItem,
} from "../../../../lib/viral-workflow";
import { planViralCaptionLayout, planViralTitleLayout } from "../../../../lib/viral-semantic-layout";

type ProviderResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
  output_text?: string;
};

const MODEL = "gpt-5.4-mini";
const DIRECTOR_TIMEOUT_MS = 8_000;
const DIRECTOR_CACHE_MAX = 128;
const directorCache = new Map<string, { expiresAt: number; value: Record<string, unknown> }>();
const NODES = new Set<ViralCaptionPlanItem["contentNode"]>([
  "hook", "pain_reversal", "core_viewpoint", "number_benefit",
  "example_step", "brand_entity", "cta", "supporting",
]);

function extractText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("");
  const record = value as Record<string, unknown>;
  for (const key of ["output_text", "text", "value", "content", "message", "choices", "output"]) {
    const text = extractText(record[key]);
    if (text) return text;
  }
  return "";
}

function parseJson(value: string) {
  const cleaned = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("AI 没有返回结构化字幕规划。");
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  }
}

function plain(value: string) {
  return value.toLocaleLowerCase().replace(/[\s，。！？；：、,.!?;:'"“”‘’（）()【】\[\]《》<>—…·-]/g, "");
}

function overlapRatio(source: string, result: string) {
  const counts = new Map<string, number>();
  for (const char of plain(result)) counts.set(char, (counts.get(char) || 0) + 1);
  let matched = 0;
  for (const char of plain(source)) {
    const count = counts.get(char) || 0;
    if (count > 0) {
      matched += 1;
      counts.set(char, count - 1);
    }
  }
  return matched / Math.max(1, plain(source).length);
}

function localKeyword(text: string) {
  const normalized = text.replace(/\s+/g, "").replace(/[，。！？；：、,.!?;:'"“”‘’（）()【】\[\]《》<>—…·-]/g, "");
  const marked = normalized.match(/(?:\d+(?:\.\d+)?[%折元万+]?|[一二三四五六七八九十百千万]+(?:个|类|项|种)|效率|提升|关键|核心|方法|步骤|技能|专业|免费|优惠|结果|问题|价值|马上|现在)/)?.[0];
  if (marked && marked.length >= 2) return marked.slice(0, 8);
  if (normalized.length <= 4) return normalized;
  const start = Math.max(0, Math.floor(normalized.length * 0.45) - 2);
  return normalized.slice(start, start + Math.min(4, normalized.length - start));
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

function localIntents(node: ViralCaptionPlanItem["contentNode"], weight: number) {
  const cameraIntent: ViralCaptionPlanItem["cameraIntent"] = node === "hook"
    ? "push-in"
    : node === "number_benefit"
      ? "close-up"
      : node === "example_step"
        ? "reframe"
        : node === "cta"
          ? "pull-back"
          : weight >= 0.72
            ? "push-in"
            : "hold";
  const transitionIntent: ViralCaptionPlanItem["transitionIntent"] = node === "hook"
    ? "cut"
    : node === "pain_reversal"
      ? "focus-bridge"
      : node === "example_step"
        ? "matched-reframe"
        : node === "cta"
          ? "foreground-occlusion"
          : "none";
  const sfxRole: ViralCaptionPlanItem["sfxRole"] = ({
    hook: "hook",
    pain_reversal: "reversal",
    core_viewpoint: "viewpoint",
    number_benefit: "number",
    example_step: "step",
    brand_entity: "brand",
    cta: "cta",
    supporting: "none",
  } as const)[node || "supporting"];
  return { cameraIntent, transitionIntent, sfxRole };
}

function localPlan(captions: ViralCaptionPlanItem[], script: string) {
  const planned = captions.map((caption, index) => {
    const lineLayout = planViralCaptionLayout(caption.text, caption.captionLines, 10);
    const contentNode = localNode(caption.text, index, captions.length);
    const contentWeight = index === 0 || index === captions.length - 1 ? 0.9 : 0.55;
    return {
      ...caption,
      keyword: localKeyword(caption.text),
      translation: caption.translation || "",
      contentNode,
      contentWeight,
      keywordOrigin: "local" as const,
      captionLineMode: lineLayout.mode,
      captionLines: lineLayout.lines,
      ...localIntents(contentNode, contentWeight),
    };
  });
  const first = (script || captions.map((caption) => caption.text).join(""))
    .split(/[。！？!?\n]/, 1)[0]
    ?.replace(/\s+/g, "") || "";
  const titleLayout = planViralTitleLayout(first.slice(0, 16) || "口播重点");
  return { title: titleLayout.serializedTitle, titleLines: titleLayout.lines, captions: markViralKeywordSfx(planned) };
}

function cacheKey(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cachedDirectorPlan(key: string) {
  const entry = directorCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    directorCache.delete(key);
    return null;
  }
  directorCache.delete(key);
  directorCache.set(key, entry);
  return entry.value;
}

function rememberDirectorPlan(key: string, value: Record<string, unknown>) {
  directorCache.set(key, { expiresAt: Date.now() + 24 * 60 * 60 * 1000, value });
  while (directorCache.size > DIRECTOR_CACHE_MAX) {
    const oldest = directorCache.keys().next().value;
    if (!oldest) break;
    directorCache.delete(oldest);
  }
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const duration = Math.max(1, Math.min(600, Number(body.duration) || 600));
  const source = sanitizeViralCaptionPlan(body.captions, duration);
  if (!source.length) return Response.json({ error: "没有可用于网感剪辑的字幕时间轴。" }, { status: 400 });
  const script = typeof body.script === "string" ? body.script.trim().slice(0, 12_000) : "";
  const templateId = typeof body.templateId === "string" ? body.templateId.trim().slice(0, 64) : "template-9";
  const fallback = localPlan(source, script);
  const input = source.map((caption, id) => ({ id, start: caption.start, end: caption.end, text: caption.text }));
  const key = cacheKey({ prompt: VIRAL_DIRECTOR_PROMPT_VERSION, model: MODEL, templateId, script, input });
  const cached = cachedDirectorPlan(key);
  if (cached) return Response.json({ ...cached, cache: "hit" });
  const system = `你是专业竖屏口播短视频的字幕总监。用户已经确认了口播文字和逐句时间轴，你只做一次性轻量校正与导演标注。
规则：
1. 不改变id、start、end和条目数量，不重新断句，不删减信息，不添加原文没有的内容；只校正确定的同音错字、品牌名和明显错字。
2. keyword必须是corrected_text中原样连续出现的1到8个字；普通承接句可以为空，不要每句都强行提亮。
3. content_node只能是hook/pain_reversal/core_viewpoint/number_benefit/example_step/brand_entity/cta/supporting。
4. translation输出自然简短英文字幕；原文为英文时输出简短中文。
5. title理解完整口播后提炼，中文8到16字，不能只是机械复制开头。
6. title_lines必须把title按完整语义分为1到2行；caption_lines只负责同一条字幕内部的视觉换行，最多2行。各行拼接必须与原文字完全一致，禁止拆开品牌名、专有名词及“商家入驻、首批类目、激励翻倍”等固定短语。
7. camera_intent只表达镜头意图：hold/push-in/pull-back/reframe/close-up/wide；transition_intent只能是none/cut/matched-reframe/focus-bridge/foreground-occlusion；sfx_role只能是none/hook/reversal/viewpoint/number/step/brand/cta。不要输出具体像素、时间或素材文件名。
8. bgm_mood只能是calm/warm/professional/uplifting/neutral。
只返回JSON：{"title":"标题","title_lines":["第一行","第二行"],"bgm_mood":"professional","items":[{"id":0,"corrected_text":"原句","caption_lines":["第一行","第二行"],"keyword":"关键词","translation":"English caption","content_node":"hook","weight":0.9,"camera_intent":"push-in","transition_intent":"cut","sfx_role":"hook"}]}。`;
  const requestStartedAt = Date.now();
  try {
    const response = await lk888Fetch<ProviderResponse>("/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(DIRECTOR_TIMEOUT_MS),
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.05,
        max_tokens: Math.max(900, Math.min(3600, source.length * 105)),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: `完整口播：${script || source.map((item) => item.text).join("。")}\n确认时间轴：${JSON.stringify(input)}` },
        ],
      }),
    });
    const parsed = parseJson(extractText(response));
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    if (items.length !== source.length) throw new Error("AI 字幕规划数量不一致。");
    const captions = markViralKeywordSfx(source.map((caption, index) => {
      const raw = items[index] && typeof items[index] === "object" ? items[index] as Record<string, unknown> : {};
      if (Number(raw.id) !== index) throw new Error("AI 字幕规划顺序不一致。");
      const corrected = typeof raw.corrected_text === "string" ? raw.corrected_text.trim().slice(0, 180) : caption.text;
      const lengthRatio = plain(corrected).length / Math.max(1, plain(caption.text).length);
      const text = corrected && lengthRatio >= 0.72 && lengthRatio <= 1.35 && overlapRatio(caption.text, corrected) >= 0.62
        ? corrected
        : caption.text;
      const candidate = typeof raw.keyword === "string" ? raw.keyword.trim().replace(/\s+/g, "").slice(0, 8) : "";
      const keyword = candidate && plain(text).includes(plain(candidate)) ? candidate : "";
      const node = NODES.has(raw.content_node as ViralCaptionPlanItem["contentNode"])
        ? raw.content_node as ViralCaptionPlanItem["contentNode"]
        : localNode(text, index, source.length);
      const lineLayout = planViralCaptionLayout(text, raw.caption_lines, 10);
      const contentWeight = Math.max(0, Math.min(1, Number(raw.weight) || 0.5));
      const local = localIntents(node, contentWeight);
      const cameraIntent = ["hold", "push-in", "pull-back", "reframe", "close-up", "wide"].includes(String(raw.camera_intent))
        ? raw.camera_intent as ViralCaptionPlanItem["cameraIntent"]
        : local.cameraIntent;
      const transitionIntent = ["none", "cut", "matched-reframe", "focus-bridge", "foreground-occlusion"].includes(String(raw.transition_intent))
        ? raw.transition_intent as ViralCaptionPlanItem["transitionIntent"]
        : local.transitionIntent;
      const sfxRole = ["none", "hook", "reversal", "viewpoint", "number", "step", "brand", "cta"].includes(String(raw.sfx_role))
        ? raw.sfx_role as ViralCaptionPlanItem["sfxRole"]
        : local.sfxRole;
      return {
        ...caption,
        text,
        ...(keyword ? { keyword } : {}),
        translation: typeof raw.translation === "string" ? raw.translation.trim().slice(0, 240) : "",
        contentNode: node,
        contentWeight,
        keywordOrigin: keyword ? "ai" as const : "none" as const,
        captionLineMode: lineLayout.mode,
        captionLines: lineLayout.lines,
        cameraIntent,
        transitionIntent,
        sfxRole,
      };
    }), duration);
    const rawTitle = typeof parsed.title === "string" && parsed.title.trim()
      ? parsed.title.trim().replace(/[。！？!?]+$/g, "").slice(0, 40)
      : fallback.title;
    const titleLayout = planViralTitleLayout(rawTitle, parsed.title_lines);
    const title = titleLayout.serializedTitle;
    const directorPlan = buildViralDirectorPlan({
      templateId,
      title,
      titleLines: titleLayout.lines,
      duration,
      captions,
      bgmMood: parsed.bgm_mood as "calm" | "warm" | "professional" | "uplifting" | "neutral",
      source: "ai",
      model: MODEL,
      degraded: false,
    });
    const result = {
      title,
      titleLines: titleLayout.lines,
      captions: directorPlan.captions,
      planReady: true,
      degraded: false,
      model: MODEL,
      directorPlan,
      requestMs: Date.now() - requestStartedAt,
      cache: "miss",
    };
    rememberDirectorPlan(key, result);
    return Response.json(result);
  } catch (error) {
    console.warn("Fast viral caption plan fell back to local rules", error);
    const directorPlan = buildViralDirectorPlan({
      templateId,
      title: fallback.title,
      titleLines: fallback.titleLines,
      duration,
      captions: fallback.captions,
      source: "local-fallback",
      model: "local-fast-plan",
      degraded: true,
    });
    const result = {
      ...fallback,
      captions: directorPlan.captions,
      planReady: true,
      degraded: true,
      model: "local-fast-plan",
      directorPlan,
      requestMs: Date.now() - requestStartedAt,
      cache: "miss",
    };
    rememberDirectorPlan(key, result);
    return Response.json(result);
  }
}
