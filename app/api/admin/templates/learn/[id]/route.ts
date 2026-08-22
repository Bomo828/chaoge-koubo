import { getMemberSession } from "../../../../../member-session";
import { isAdmin } from "../../../../../../lib/server/auth";
import { videoWorkerUpstreamUrl } from "../../../../../../lib/server/video-worker";

export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const member = await getMemberSession();
  if (!isAdmin(member)) return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  const token = process.env.VIDEO_WORKER_ADMIN_TOKEN?.trim() || "";
  if (!token) return Response.json({ error: "服务器尚未配置模板学习管理密钥。" }, { status: 503 });
  const { id } = await context.params;
  if (!/^[a-f0-9]{32}$/i.test(id)) return Response.json({ error: "模板学习任务编号无效。" }, { status: 400 });
  const base = videoWorkerUpstreamUrl();
  try {
    const response = await fetch(`${base}/v1/template-learning/jobs/${id}`, {
      headers: { "x-video-worker-admin-token": token }, cache: "no-store",
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) return Response.json({ error: String(data.detail || data.error || "模板学习状态读取失败。") }, { status: response.status });
    return Response.json(data);
  } catch {
    return Response.json({ error: "无法连接视频模板学习服务。" }, { status: 502 });
  }
}
