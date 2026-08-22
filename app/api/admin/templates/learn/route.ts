import { getMemberSession } from "../../../../member-session";
import { isAdmin } from "../../../../../lib/server/auth";
import { videoWorkerUpstreamUrl } from "../../../../../lib/server/video-worker";

export const runtime = "nodejs";

function workerBase() {
  return videoWorkerUpstreamUrl();
}

function adminToken() {
  return process.env.VIDEO_WORKER_ADMIN_TOKEN?.trim() || "";
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!isAdmin(member)) return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  if (!adminToken()) return Response.json({ error: "服务器尚未配置模板学习管理密钥。" }, { status: 503 });
  const input = await request.formData();
  const file = input.get("file");
  const name = String(input.get("name") || "").trim();
  const slug = String(input.get("slug") || "").trim().toLowerCase();
  const previewUrl = String(input.get("previewUrl") || "").trim();
  if (!(file instanceof File) || !file.size) return Response.json({ error: "请先上传参考原视频。" }, { status: 400 });
  if (!name) return Response.json({ error: "请填写模板名称。" }, { status: 400 });
  if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(slug)) {
    return Response.json({ error: "模板标识只能使用小写字母、数字和短横线。" }, { status: 400 });
  }
  const form = new FormData();
  form.append("video", file, file.name);
  form.append("template_id", slug);
  form.append("template_name", name);
  form.append("preview_url", previewUrl);
  try {
    const response = await fetch(`${workerBase()}/v1/template-learning/jobs`, {
      method: "POST",
      headers: { "x-video-worker-admin-token": adminToken() },
      body: form,
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) return Response.json({ error: String(data.detail || data.error || "模板学习任务创建失败。") }, { status: response.status });
    return Response.json(data, { status: 201 });
  } catch {
    return Response.json({ error: "无法连接视频模板学习服务，请检查视频处理服务。" }, { status: 502 });
  }
}
