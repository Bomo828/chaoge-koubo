import { getMemberSession } from "../../../member-session";

const DEFAULT_VIDEO_WORKER_URL = "https://api.chaogeai.top/video-worker";

function safeFilename(value: string) {
  const base = value
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 100) || "一键网感成片";
  return /\.mp4$/i.test(base) ? base : `${base}.mp4`;
}

export async function GET(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });

  const requestUrl = new URL(request.url);
  const source = requestUrl.searchParams.get("source")?.trim() || "";
  const configuredBase = (process.env.NEXT_PUBLIC_VIDEO_WORKER_URL || DEFAULT_VIDEO_WORKER_URL).replace(/\/+$/, "");

  let sourceUrl: URL;
  let allowedBase: URL;
  try {
    sourceUrl = new URL(source);
    allowedBase = new URL(configuredBase);
  } catch {
    return Response.json({ error: "成片下载地址无效。" }, { status: 400 });
  }

  const allowedPath = `${allowedBase.pathname.replace(/\/+$/, "")}/media/`;
  if (
    sourceUrl.protocol !== allowedBase.protocol
    || sourceUrl.host !== allowedBase.host
    || !sourceUrl.pathname.startsWith(allowedPath)
    || !sourceUrl.pathname.endsWith("/output.mp4")
  ) {
    return Response.json({ error: "不允许下载这个地址。" }, { status: 400 });
  }

  const upstream = await fetch(sourceUrl, { cache: "no-store" });
  if (!upstream.ok || !upstream.body) {
    return Response.json({ error: "成片文件暂时无法读取，请稍后重试。" }, { status: 502 });
  }

  const filename = safeFilename(requestUrl.searchParams.get("filename") || "一键网感成片.mp4");
  const headers = new Headers({
    "Content-Type": upstream.headers.get("content-type") || "video/mp4",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) headers.set("Content-Length", contentLength);

  return new Response(upstream.body, { headers });
}
