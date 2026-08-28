const DEFAULT_VIDEO_WORKER_URL = "http://127.0.0.1:8790";

function absoluteHttpUrl(value: string | undefined) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function videoWorkerUpstreamUrl() {
  // Browser-facing routes may be relative (for example `/video-worker`), but
  // server-to-server fetches require an absolute URL. Never reuse the public
  // browser route as the upstream or a valid request will fail before fetch.
  return absoluteHttpUrl(process.env.VIDEO_WORKER_UPSTREAM_URL)
    || absoluteHttpUrl(process.env.VIDEO_WORKER_BASE_URL)
    || DEFAULT_VIDEO_WORKER_URL;
}

export function videoWorkerPublicUrl() {
  return (process.env.NEXT_PUBLIC_VIDEO_WORKER_URL
    || "/video-worker").replace(/\/+$/, "");
}
