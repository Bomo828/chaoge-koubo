export function browserFfmpegLoadConfig() {
  if (typeof window === "undefined") {
    throw new Error("浏览器端视频引擎只能在页面中加载。");
  }

  const baseUrl = new URL("/ffmpeg/", window.location.origin);
  return {
    classWorkerURL: new URL("ffmpeg-worker.js", baseUrl).href,
    coreURL: new URL("ffmpeg-core.js", baseUrl).href,
    wasmURL: new URL("ffmpeg-core.wasm", baseUrl).href,
  };
}
