const DEFAULT_VIDEO_WORKER_URL = "https://api.chaogeai.top/video-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ path: string[] }> };

function upstreamBaseUrl() {
  return (process.env.VIDEO_WORKER_UPSTREAM_URL
    || process.env.NEXT_PUBLIC_VIDEO_WORKER_URL
    || DEFAULT_VIDEO_WORKER_URL).replace(/\/+$/, "");
}

async function relay(request: Request, context: RouteContext) {
  const { path } = await context.params;
  const requestUrl = new URL(request.url);
  const upstreamUrl = new URL(`${upstreamBaseUrl()}/${path.map(encodeURIComponent).join("/")}`);
  upstreamUrl.search = requestUrl.search;

  const headers = new Headers(request.headers);
  // Never forward the member's local session or browser-origin headers to the
  // independent video worker.
  for (const name of [
    "host",
    "cookie",
    "origin",
    "referer",
    "connection",
    "accept-encoding",
    "expect",
    // The incoming browser request may carry a fixed Content-Length while
    // Next/undici forwards its body as a stream. Keeping that stale length
    // makes multipart video uploads fail with a body-length mismatch. Let
    // fetch choose the correct transfer framing for the streamed body.
    "content-length",
    "transfer-encoding",
  ]) {
    headers.delete(name);
  }

  try {
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const init: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(10 * 60 * 1000),
    };
    if (hasBody) init.duplex = "half";
    const upstream = await fetch(upstreamUrl, init);
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "视频处理服务连接失败";
    const cause = error && typeof error === "object" && "cause" in error
      ? String((error as { cause?: unknown }).cause || "")
      : "";
    return Response.json({
      detail: `视频处理服务连接失败：${message}${cause ? `（${cause}）` : ""}`,
    }, { status: 502 });
  }
}

export const GET = relay;
export const POST = relay;
export const PUT = relay;
export const PATCH = relay;
export const DELETE = relay;
