import { getMemberSession } from "../../../member-session";
import { videoWorkerUpstreamUrl } from "../../../../lib/server/video-worker";

function workerBaseUrl() {
  return videoWorkerUpstreamUrl();
}

function safeJobId(value: string | null) {
  return value && /^[a-f0-9]{32}$/i.test(value) ? value : "";
}

async function responseData(response: Response) {
  const text = await response.text().catch(() => "");
  try {
    return text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    return { detail: text || `视频服务返回异常（HTTP ${response.status}）。` };
  }
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  const adminToken = process.env.VIDEO_WORKER_ADMIN_TOKEN?.trim() || "";
  if (!adminToken) return Response.json({ error: "AI 对标服务尚未配置，请联系管理员。" }, { status: 503 });

  let body: { shareUrl?: unknown };
  try {
    body = await request.json() as { shareUrl?: unknown };
  } catch {
    return Response.json({ error: "请求内容格式无效。" }, { status: 400 });
  }
  const shareUrl = typeof body.shareUrl === "string" ? body.shareUrl.trim().slice(0, 2000) : "";
  if (!shareUrl) return Response.json({ error: "请粘贴抖音公开视频链接。" }, { status: 400 });

  try {
    const response = await fetch(`${workerBaseUrl()}/v1/douyin/transcriptions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-video-worker-admin-token": adminToken,
      },
      body: JSON.stringify({ share_url: shareUrl }),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const data = await responseData(response);
    if (!response.ok) return Response.json({ error: String(data.detail || "对标链接读取失败。") }, { status: response.status });
    return Response.json(data);
  } catch {
    return Response.json({ error: "视频识别服务暂时无法连接，请稍后重试。" }, { status: 503 });
  }
}

export async function GET(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  const jobId = safeJobId(new URL(request.url).searchParams.get("jobId"));
  if (!jobId) return Response.json({ error: "对标任务编号无效。" }, { status: 400 });
  try {
    const response = await fetch(`${workerBaseUrl()}/v1/jobs/${jobId}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const data = await responseData(response);
    if (!response.ok) return Response.json({ error: String(data.detail || "读取对标任务进度失败。") }, { status: response.status });
    return Response.json(data);
  } catch {
    return Response.json({ error: "视频识别服务暂时无法连接，请稍后重试。" }, { status: 503 });
  }
}
