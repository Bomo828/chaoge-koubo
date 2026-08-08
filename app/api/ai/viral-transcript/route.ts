import { getMemberSession } from "../../../member-session";
import { AiProviderError, aiErrorResponse, lk888Fetch } from "../../../../lib/lk888";

type Caption = {
  start: number;
  end: number;
  text: string;
};

type ProviderResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
  output_text?: string;
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
    if (start < 0 || end <= start) throw new AiProviderError("大模型没有返回可用的口播文案。", 502);
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  }
}

function plainText(value: string) {
  return value.replace(/[\s，。！？；：、,.!?;:'"“”‘’（）()【】\[\]《》<>—…·-]/g, "");
}

function punctuation(value: string) {
  const text = value.replace(/\s+/g, "").trim();
  if (!text) return "";
  return /[。！？!?]$/.test(text) ? text : `${text}。`;
}

function phraseText(value: string) {
  return value
    .replace(/\s+/g, "")
    .replace(/^[，,。！？!?；;：:、]+|[，,。！？!?；;：:、]+$/gu, "")
    .trim();
}

function completeTitle(value: unknown) {
  if (typeof value !== "string") return "";
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

function chunkPhrase(value: string, maxChars = 15, minTailChars = 5) {
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
  return value
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
}

function localSentenceCaptions(captions: Caption[]): Caption[] {
  const output: Caption[] = [];
  let current: Caption | null = null;
  captions.forEach((caption, index) => {
    if (!current) current = { ...caption };
    else {
      current.end = Math.max(current.end, caption.end);
      current.text = `${current.text}${caption.text}`.replace(/\s+/g, "");
    }
    const next = captions[index + 1];
    const pause = next ? Math.max(0, next.start - caption.end) : 0;
    const shouldClose = /[。！？!?]$/.test(current.text.trim())
      || pause >= 0.78
      || plainText(current.text).length >= 42
      || !next;
    if (shouldClose) {
      const text = punctuation(current.text);
      if (text) output.push({ start: current.start, end: current.end, text });
      current = null;
    }
  });
  return splitCaptionPhrases(output);
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
      .split(/[，,。！？!?；;：:\n]+/u)
      .flatMap((part) => chunkPhrase(part))
      .filter(Boolean);
    if (parts.length <= 1) return parts.length ? [{ ...caption, text: parts[0] }] : [];
    const weights = parts.map((part) => Math.max(1, plainText(part).length));
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
  const sourceText = source.map((item) => item.text).join("");
  const resultText = captions.map((item) => item.text).join("");
  const lengthRatio = plainText(resultText).length / Math.max(1, plainText(sourceText).length);
  if (lengthRatio < 0.72 || lengthRatio > 1.35 || textCoverage(sourceText, resultText) < 0.62) return [];
  return splitCaptionPhrases(captions);
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });

  try {
    const body = await request.json() as {
      captions?: unknown;
      frames?: unknown;
      merchant?: Record<string, unknown>;
      duration?: unknown;
    };
    const duration = Math.max(1, Math.min(600, Number(body.duration) || 60));
    const sourceCaptions = normalizeSourceCaptions(body.captions, duration);
    if (!sourceCaptions.length) {
      return Response.json({ error: "没有读取到视频中的原始口播，请确认视频带有清晰人声。" }, { status: 400 });
    }
    const frames = Array.isArray(body.frames)
      ? body.frames.filter((item): item is string => typeof item === "string" && /^data:image\/(?:jpeg|png|webp);base64,/i.test(item)).slice(0, 5)
      : [];
    const sourceText = sourceCaptions.map((item) => item.text).join("");
    const system = `你是中文短视频口播校对师。输入已经包含从视频人声识别出的原始文字和真实时间轴，另有视频关键帧与商家资料供你核对专有名词。
要求：
1. 保留原口播的全部有效信息，不总结、不缩写、不加入营销文案，不虚构原片没有说过的内容。
2. 结合整段上下文和关键画面校正同音错字、品牌名、机构名、数字与明显漏字；不能确认时保留原词。
3. 输出用于视频字幕列表的“口播短句”，不是长段落。优先按照真实停顿、逗号和语义短语拆分；一般每条4到15个中文字、持续0.8到3.5秒，问候语等自然短句可少于4字。
4. 每条只保留字幕文字，不带句末标点。start和end必须对应这段话真实出现的位置；时间递增、不重叠、不超过视频时长。
5. 输出句子的纯文字按顺序拼接后，应与原始口播基本一致。
6. 标题必须先理解完整口播的主题、对象和最终结论后再提炼，不能截取第一句，也不能把开头两段机械拼接。生成3个不同角度的候选，再选择语义最完整、最准确的一条；标题控制在8到15字，必须可以独立阅读，不能在“不是、而是、因为、所以、很多岗位”等半句话处结束。
7. 32秒口播通常应整理为10到18条短句，不能把多个句子合成一个长段。只返回JSON：{"titleCandidates":["候选1","候选2","候选3"],"title":"最终标题","summary":"一句识别说明","captions":[{"start":0,"end":2.1,"text":"想提升办公和职场技能"}]}。`;
    const content = [
      {
        type: "text",
        text: `视频时长：${duration.toFixed(2)}秒\n商家资料：${JSON.stringify(body.merchant || {})}\n原始口播时间轴：${JSON.stringify(sourceCaptions)}\n原始口播全文：${sourceText}`,
      },
      ...frames.map((url) => ({ type: "image_url", image_url: { url, detail: "low" } })),
    ];
    const tokenBudget = Math.max(1600, Math.min(5000, plainText(sourceText).length * 8));
    let endpoint: "chat-completions" | "responses" = "responses";
    let response: ProviderResponse;
    try {
      response = await lk888Fetch<ProviderResponse>("/v1/responses", {
        method: "POST",
        signal: AbortSignal.timeout(55_000),
        body: JSON.stringify({
          model: "gpt-5.5",
          instructions: system,
          input: [{
            role: "user",
            content: content.map((part) => "image_url" in part
              ? { type: "input_image", image_url: part.image_url.url }
              : { type: "input_text", text: part.text }),
          }],
          temperature: 0.05,
          max_output_tokens: tokenBudget,
        }),
      });
      if (!extractText(response)) throw new AiProviderError("主识别通道没有返回有效内容。", 502);
    } catch {
      // 多模态主通道异常时自动切换兼容接口，不让用户重新上传视频。
      endpoint = "chat-completions";
      response = await lk888Fetch<ProviderResponse>("/v1/chat/completions", {
        method: "POST",
        signal: AbortSignal.timeout(55_000),
        body: JSON.stringify({
          model: "gpt-5.5",
          temperature: 0.05,
          max_tokens: tokenBudget,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content },
          ],
        }),
      });
      if (!extractText(response)) throw new AiProviderError("备用识别通道没有返回有效内容。", 502);
    }
    const parsed = parseJson(extractText(response));
    const aiCaptions = normalizedAiCaptions(parsed.captions, sourceCaptions, duration);
    const captions = aiCaptions.length ? aiCaptions : localSentenceCaptions(sourceCaptions);
    const titleCandidates = [
      parsed.title,
      ...(Array.isArray(parsed.titleCandidates) ? parsed.titleCandidates : []),
    ];
    const title = titleCandidates.map(completeTitle).find(Boolean) || "";
    return Response.json({
      title,
      summary: typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 180) : "",
      captions,
      model: "gpt-5.5",
      endpoint,
      degraded: !aiCaptions.length,
    });
  } catch (error) {
    return aiErrorResponse(error);
  }
}
