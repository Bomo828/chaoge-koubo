import { getMemberSession } from "../../../member-session";
import { ChanjingError, chanjingErrorResponse, createCustomVoice, ensureChanjingBalance, getCustomVoice } from "../../../../lib/chanjing";
import { CHANJING_VOICE_CLONE_POINTS } from "../../../../lib/chanjing-pricing";
import { listMemberAssets, saveMemberAsset } from "../../../../lib/member-assets";
import { listClonedVoicesForMember, upsertClonedVoice } from "../../../../lib/server/cloned-voices";
import {
  getWallet,
  pointsErrorResponse,
  refundAiPoints,
  reserveAiPoints,
  settleAiPointsByRequest,
} from "../../../../lib/points";

const DEFAULT_RELAY_BASE_URL = "https://api.chaogeai.top";
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

function normalizeVoiceLanguage(value: unknown): "cn" | "en" {
  return value === "en" ? "en" : "cn";
}

function assetIdForVoice(voiceId: string) {
  let hash = 2166136261;
  for (let index = 0; index < voiceId.length; index += 1) {
    hash ^= voiceId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `voice_${(hash >>> 0).toString(36)}_${voiceId.length.toString(36)}`;
}

function relayBaseUrl() {
  return (process.env.VOICE_SAMPLE_RELAY_BASE_URL || DEFAULT_RELAY_BASE_URL).replace(/\/$/, "");
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function relayJson<T>(response: Response): Promise<T> {
  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  } catch {
    payload = { error: raw };
  }
  if (!response.ok) {
    const message = typeof payload.error === "string" && payload.error.trim()
      ? payload.error.trim()
      : `声音样本中转服务返回 ${response.status}`;
    throw new ChanjingError(message, response.status >= 400 ? response.status : 502);
  }
  return payload as T;
}

async function uploadPublicVoiceSample(member: NonNullable<Awaited<ReturnType<typeof getMemberSession>>>, file: File) {
  const baseUrl = relayBaseUrl();
  const loginResponse = await fetch(`${baseUrl}/api/member/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId: `merchant-web-voice-${member.id}`,
      merchantId: member.id,
      merchantName: member.displayName,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const login = await relayJson<{ token?: string }>(loginResponse);
  if (!login.token) throw new ChanjingError("声音样本中转服务没有返回授权信息。");

  const safeFileName = file.name.replace(/[^\w.\-]/g, "_") || `voice-${Date.now()}.wav`;
  const uploadResponse = await fetch(`${baseUrl}/api/voice/upload`, {
    method: "POST",
    headers: {
      "x-member-token": login.token,
      "x-file-name": encodeURIComponent(safeFileName),
      "Content-Type": file.type || "application/octet-stream",
    },
    body: await file.arrayBuffer(),
    signal: AbortSignal.timeout(120_000),
  });
  const uploaded = await relayJson<{ audioUrl?: string }>(uploadResponse);
  const audioUrl = typeof uploaded.audioUrl === "string" ? uploaded.audioUrl.trim() : "";
  if (!/^https:\/\//i.test(audioUrl)) {
    throw new ChanjingError("声音样本没有生成公网 HTTPS 地址，请检查中转服务的 PUBLIC_BASE_URL。");
  }
  return audioUrl;
}

async function archiveVoice(
  member: NonNullable<Awaited<ReturnType<typeof getMemberSession>>>,
  input: { voiceId: string; name: string; demoAudio: string; language?: "cn" | "en" },
) {
  const id = assetIdForVoice(input.voiceId);
  await saveMemberAsset(member, {
    id,
    projectName: "克隆声音",
    kind: "voice",
    name: input.name,
    sourceUrl: input.demoAudio,
    sourceTaskId: input.voiceId,
    createdAt: Date.now(),
  });
  upsertClonedVoice({
    ownerId: member.id,
    name: input.name,
    providerVoiceId: input.voiceId,
    sampleAssetId: id,
    language: normalizeVoiceLanguage(input.language),
  });
  return `/api/member/assets/${encodeURIComponent(id)}`;
}

export async function GET(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });

  const url = new URL(request.url);
  const voiceId = (url.searchParams.get("voice_id") || "").trim();
  const language = normalizeVoiceLanguage(url.searchParams.get("language"));
  if (url.searchParams.get("support_recover") === "execute") {
    const name = (url.searchParams.get("name") || "克隆声音").trim().slice(0, 40);
    const demoAudio = (url.searchParams.get("demo_audio") || "").trim();
    if (!voiceId || !demoAudio) {
      return Response.json({ error: "缺少声音模型或试听样本信息。" }, { status: 400 });
    }
    let sourceUrl: URL;
    try {
      sourceUrl = new URL(demoAudio);
    } catch {
      return Response.json({ error: "试听样本地址无效。" }, { status: 400 });
    }
    const relayUrl = new URL(relayBaseUrl());
    if (sourceUrl.protocol !== "https:" || sourceUrl.hostname !== relayUrl.hostname) {
      return Response.json({ error: "只允许恢复本平台上传的 HTTPS 试听样本。" }, { status: 400 });
    }
    try {
      const sample = await fetch(demoAudio, {
        headers: { Accept: "audio/*" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!sample.ok) {
        return Response.json({
          error: `试听样本地址暂时无法读取（HTTP ${sample.status}）。`,
        }, { status: 502 });
      }
      await sample.body?.cancel();
      const playableAudio = await archiveVoice(member, {
        voiceId,
        name,
        demoAudio,
        language,
      });
      return Response.json({
        saved: true,
        voice: {
          voiceId,
          name,
          demoAudio: playableAudio,
          language,
        },
        wallet: await getWallet(member),
      });
    } catch (error) {
      console.error("Recover cloned voice failed", error);
      return Response.json({
        error: error instanceof Error
          ? error.message
          : "声音试听样本恢复失败，请稍后重试。",
      }, { status: 500 });
    }
  }
  if (url.searchParams.get("support_recover") === "1") {
    const name = (url.searchParams.get("name") || "克隆声音").trim().slice(0, 40);
    const demoAudio = (url.searchParams.get("demo_audio") || "").trim();
    return new Response(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>恢复声音资产</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f2f5f1;color:#173d31;display:grid;place-items:center;min-height:100vh;margin:0}
    form{width:min(520px,calc(100vw - 48px));background:white;border:1px solid #dbe5df;border-radius:20px;padding:28px;box-shadow:0 18px 48px rgba(20,58,45,.12)}
    h1{font-size:24px;margin:0 0 10px}.hint{color:#728079;font-size:14px;line-height:1.6;margin:0 0 22px}
    label{display:block;font-size:13px;font-weight:700;margin:14px 0 7px}input{box-sizing:border-box;width:100%;border:1px solid #d3ddd7;border-radius:10px;padding:12px;background:#f8faf8;color:#173d31}
    button{width:100%;margin-top:22px;border:0;border-radius:12px;padding:14px;background:#174b3a;color:white;font-weight:700;cursor:pointer}
  </style>
</head>
<body>
  <form method="post" action="/api/ai/voices">
    <h1>恢复已克隆声音</h1>
    <p class="hint">仅补回会员资产中的试听样本，不会重新克隆，也不会扣除积分。</p>
    <input type="hidden" name="action" value="recover">
    <input type="hidden" name="language" value="${language}">
    <label>声音名称</label>
    <input name="name" value="${escapeHtml(name)}" readonly>
    <label>声音模型 ID</label>
    <input name="voiceId" value="${escapeHtml(voiceId)}" readonly>
    <label>试听样本</label>
    <input name="demoAudio" value="${escapeHtml(demoAudio)}" readonly>
    <button type="submit">恢复声音资产</button>
  </form>
</body>
</html>`, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }
  if (!voiceId) {
    try {
      const items = await listMemberAssets(member);
      const registeredVoices = listClonedVoicesForMember(member.id);
      const registeredById = new Map(registeredVoices.map((voice) => [voice.voiceId, voice]));
      const voices = items
        .filter((item) => item.kind === "voice" && item.source_task_id)
        .map((item) => ({
          voiceId: item.source_task_id as string,
          name: item.name,
          language: registeredById.get(item.source_task_id as string)?.language ?? "cn" as const,
          demoAudio: `/api/member/assets/${encodeURIComponent(item.id)}`,
          createdAt: Number(item.created_at) * 1000,
        }));
      const merged = [...voices];
      for (const voice of registeredVoices) {
        if (!merged.some((item) => item.voiceId === voice.voiceId)) merged.push(voice);
      }
      return Response.json({ voices: merged });
    } catch (error) {
      console.error("Load cloned voices failed", error);
      return Response.json({ error: "已克隆声音暂时无法读取，请稍后重试。" }, { status: 500 });
    }
  }

  const requestId = (url.searchParams.get("request_id") || "").trim();
  const name = (url.searchParams.get("name") || "克隆声音").trim().slice(0, 40);
  const demoAudio = (url.searchParams.get("demo_audio") || "").trim();
  try {
    const task = await getCustomVoice(voiceId);
    let saved = false;
    let playableAudio = demoAudio || task.demoAudio;
    let warning = "";
    if (task.state === "success") {
      if (playableAudio) {
        try {
          playableAudio = await archiveVoice(member, { voiceId, name: task.name || name, demoAudio: playableAudio, language });
          saved = true;
        } catch (error) {
          warning = "声音已克隆成功，但会员资产保存失败；本次页面仍可继续使用。";
          console.error("Archive cloned voice failed", error);
        }
      } else {
        warning = "声音已克隆成功，但试听样本地址缺失；可继续生成口播音频。";
        upsertClonedVoice({
          ownerId: member.id,
          name: task.name || name,
          providerVoiceId: voiceId,
          language,
        });
      }
    }
    const wallet = task.isFinal && requestId
      ? await settleAiPointsByRequest(member, requestId, task.state === "success" ? CHANJING_VOICE_CLONE_POINTS : 0)
      : await getWallet(member);
    return Response.json({
      ...task,
      voice: task.state === "success"
        ? { voiceId, name: task.name || name, demoAudio: playableAudio, language }
        : null,
      demoAudio: playableAudio,
      saved,
      warning,
      requestId: requestId || null,
      wallet,
    });
  } catch (error) {
    return pointsErrorResponse(error) ?? chanjingErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });

  let reservation: Awaited<ReturnType<typeof reserveAiPoints>> | null = null;
  let submitted = false;
  try {
    const form = await request.formData();
    if (String(form.get("action") || "") === "recover") {
      const voiceId = String(form.get("voiceId") || "").trim();
      const name = String(form.get("name") || "克隆声音").trim().slice(0, 40);
      const demoAudio = String(form.get("demoAudio") || "").trim();
      const recoverLanguage = normalizeVoiceLanguage(form.get("language"));
      if (!voiceId || !demoAudio) {
        return Response.json({ error: "缺少声音模型或试听样本信息。" }, { status: 400 });
      }
      let sourceUrl: URL;
      try {
        sourceUrl = new URL(demoAudio);
      } catch {
        return Response.json({ error: "试听样本地址无效。" }, { status: 400 });
      }
      const relayUrl = new URL(relayBaseUrl());
      if (sourceUrl.protocol !== "https:" || sourceUrl.hostname !== relayUrl.hostname) {
        return Response.json({ error: "只允许恢复本平台上传的 HTTPS 试听样本。" }, { status: 400 });
      }
      const playableAudio = await archiveVoice(member, {
        voiceId,
        name,
        demoAudio,
        language: recoverLanguage,
      });
      return Response.json({
        saved: true,
        voice: {
          voiceId,
          name,
          demoAudio: playableAudio,
          language: recoverLanguage,
        },
        wallet: await getWallet(member),
      });
    }
    const fileValue = form.get("audio");
    const file = fileValue instanceof File ? fileValue : null;
    const name = String(form.get("name") || "").trim().slice(0, 40);
    const requestId = String(form.get("requestId") || "").trim();
    const language = normalizeVoiceLanguage(form.get("language"));

    if (!name) return Response.json({ error: "请先填写声音名称。" }, { status: 400 });
    if (!file || !file.size) return Response.json({ error: "请先上传一段清晰的人声音频。" }, { status: 400 });
    if (file.size > MAX_AUDIO_BYTES) {
      return Response.json({ error: "本地测试的音频文件不能超过 10MB。" }, { status: 413 });
    }
    if (!/^audio\//i.test(file.type) && !/\.(mp3|wav|m4a|aac|ogg|webm)$/i.test(file.name)) {
      return Response.json({ error: "请上传 MP3、WAV、M4A、AAC、OGG 或 WebM 音频。" }, { status: 400 });
    }

    await ensureChanjingBalance(CHANJING_VOICE_CLONE_POINTS);
    reservation = await reserveAiPoints(member, "voice_clone", 1, requestId, CHANJING_VOICE_CLONE_POINTS);
    const audioUrl = await uploadPublicVoiceSample(member, file);
    const created = await createCustomVoice({ name, audioUrl, language });
    submitted = true;
    return Response.json({
      voiceId: created.voiceId,
      name,
      language,
      demoAudio: audioUrl,
      state: "running",
      isFinal: false,
      progress: 0,
      requestId: reservation.requestId,
      wallet: await getWallet(member),
    });
  } catch (error) {
    if (reservation && !submitted) await refundAiPoints(reservation).catch(() => undefined);
    return pointsErrorResponse(error) ?? chanjingErrorResponse(error);
  }
}
