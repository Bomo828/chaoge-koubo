import { getMemberSession } from "../../../member-session";
import { chanjingErrorResponse, createSpeechTask, ensureChanjingBalance, getSpeechTask } from "../../../../lib/chanjing";
import { estimatedSpeechPoints, speechPoints } from "../../../../lib/chanjing-pricing";
import { saveMemberAsset } from "../../../../lib/member-assets";
import {
  getWallet,
  getReservedAiPoints,
  pointsErrorResponse,
  refundAiPoints,
  reserveAiPoints,
  settleAiPointsByRequest,
} from "../../../../lib/points";

function assetId(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `audio_${(hash >>> 0).toString(36)}_${value.length.toString(36)}`;
}

async function archiveAudio(member: NonNullable<Awaited<ReturnType<typeof getMemberSession>>>, input: {
  audioUrl: string;
  taskId: string;
  projectName: string;
  voiceName: string;
}) {
  if (!input.audioUrl) return { audioUrl: "", saved: false };
  try {
    const id = assetId(input.taskId || input.audioUrl);
    await saveMemberAsset(member, {
      id,
      projectName: input.projectName,
      kind: "audio",
      name: `${input.voiceName || "口播声音"} · 口播音频`,
      sourceUrl: input.audioUrl,
      sourceTaskId: input.taskId || null,
      createdAt: Date.now(),
    });
    return { audioUrl: `/api/member/assets/${encodeURIComponent(id)}`, saved: true };
  } catch (error) {
    console.error("Archive speech audio failed", error);
    return { audioUrl: input.audioUrl, saved: false };
  }
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });

  let reservation: Awaited<ReturnType<typeof reserveAiPoints>> | null = null;
  let submitted = false;
  try {
    const body = await request.json() as {
      voiceId?: unknown;
      text?: unknown;
      speed?: unknown;
      requestId?: unknown;
    };
    const voiceId = typeof body.voiceId === "string" ? body.voiceId.trim().slice(0, 200) : "";
    const text = typeof body.text === "string" ? body.text.trim().slice(0, 3000) : "";
    const requestedSpeed = Number(body.speed);
    const allowedSpeeds = [0.75, 1, 1.25, 1.5, 2];
    const speed = allowedSpeeds.includes(requestedSpeed) ? requestedSpeed : 1;
    if (!voiceId) return Response.json({ error: "请先选择一个声音。" }, { status: 400 });
    if (text.length < 2) return Response.json({ error: "请先填写口播文案。" }, { status: 400 });

    const estimatedPoints = estimatedSpeechPoints(text, speed);
    await ensureChanjingBalance(estimatedPoints);
    reservation = await reserveAiPoints(member, "speech_generate", 1, body.requestId, estimatedPoints);
    const task = await createSpeechTask({ voiceId, text, speed });
    submitted = true;
    return Response.json({
      taskId: task.taskId,
      state: "running",
      isFinal: false,
      progress: "0%",
      audioUrl: "",
      requestId: reservation.requestId,
      speed,
      estimatedPoints,
      wallet: await getWallet(member),
    });
  } catch (error) {
    if (reservation && !submitted) await refundAiPoints(reservation).catch(() => undefined);
    return pointsErrorResponse(error) ?? chanjingErrorResponse(error);
  }
}

export async function GET(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  const url = new URL(request.url);
  const taskId = url.searchParams.get("task_id") || "";
  const requestId = url.searchParams.get("request_id") || "";
  const projectName = (url.searchParams.get("project_name") || "口播音频").slice(0, 80);
  const voiceName = (url.searchParams.get("voice_name") || "口播声音").slice(0, 40);
  const estimatedPoints = Math.max(1, Number(url.searchParams.get("estimated_points")) || 1);
  if (!taskId) return Response.json({ error: "缺少口播音频任务编号。" }, { status: 400 });

  try {
    const task = await getSpeechTask(taskId);
    const archived = task.audioUrl
      ? await archiveAudio(member, { audioUrl: task.audioUrl, taskId, projectName, voiceName })
      : { audioUrl: "", saved: false };
    const reservedPoints = requestId ? getReservedAiPoints(member, requestId) : estimatedPoints;
    const actualPoints = task.state === "success" ? Math.min(reservedPoints, speechPoints(task.duration)) : 0;
    const wallet = task.isFinal && requestId
      ? await settleAiPointsByRequest(member, requestId, actualPoints)
      : await getWallet(member);
    return Response.json({
      ...task,
      audioUrl: archived.audioUrl || task.audioUrl,
      saved: archived.saved,
      requestId: requestId || null,
      actualPoints: task.isFinal ? actualPoints : null,
      wallet,
    });
  } catch (error) {
    return pointsErrorResponse(error) ?? chanjingErrorResponse(error);
  }
}
