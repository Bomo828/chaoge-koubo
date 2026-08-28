import { getMemberSession } from "../../../member-session";
import { videoWorkerUpstreamUrl } from "../../../../lib/server/video-worker";

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
  const upstreamBase = videoWorkerUpstreamUrl();

  let sourceUrl: URL;
  let upstreamUrl: URL;
  try {
    sourceUrl = new URL(source);
    const workerBase = new URL(upstreamBase);
    const legacyBase = process.env.LEGACY_VIDEO_WORKER_URL
      ? new URL(process.env.LEGACY_VIDEO_WORKER_URL)
      : null;
    const sameOriginRelay = sourceUrl.origin === requestUrl.origin
      && sourceUrl.pathname.startsWith("/video-worker/media/");
    const directWorkerAsset = sourceUrl.origin === workerBase.origin
      && sourceUrl.pathname.startsWith(`${workerBase.pathname.replace(/\/+$/, "")}/media/`);
    const legacyWorkerAsset = legacyBase !== null
      && sourceUrl.origin === legacyBase.origin
      && sourceUrl.pathname.startsWith(`${legacyBase.pathname.replace(/\/+$/, "")}/media/`);
    if (!sameOriginRelay && !directWorkerAsset && !legacyWorkerAsset) throw new Error("untrusted source");
    if (!sourceUrl.pathname.endsWith("/output.mp4")) throw new Error("invalid asset");

    if (sameOriginRelay) {
      const relayPath = sourceUrl.pathname.slice("/video-worker".length);
      upstreamUrl = new URL(`${upstreamBase}${relayPath}${sourceUrl.search}`);
    } else {
      upstreamUrl = sourceUrl;
    }
  } catch {
    return Response.json({ error: "成片下载地址无效。" }, { status: 400 });
  }

  const upstream = await fetch(upstreamUrl, { cache: "no-store" });
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
