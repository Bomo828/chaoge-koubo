const DEFAULT_VIDEO_WORKER_URL = "http://127.0.0.1:8790";

export function videoWorkerUpstreamUrl() {
  return (process.env.VIDEO_WORKER_UPSTREAM_URL
    || process.env.VIDEO_WORKER_BASE_URL
    || process.env.NEXT_PUBLIC_VIDEO_WORKER_URL
    || DEFAULT_VIDEO_WORKER_URL).replace(/\/+$/, "");
}

export function videoWorkerPublicUrl() {
  return (process.env.NEXT_PUBLIC_VIDEO_WORKER_URL
    || "/video-worker").replace(/\/+$/, "");
}
