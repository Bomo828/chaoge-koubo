import {cp, mkdir, readFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {bundle} from "@remotion/bundler";
import {renderMedia, selectComposition} from "@remotion/renderer";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const serviceDir = path.resolve(currentDir, "..");
const [manifestArg, outputArg] = process.argv.slice(2);
if (!manifestArg || !outputArg) {
  throw new Error("用法：node scripts/render.mjs <timeline.json> <output.mp4>");
}

const manifestPath = path.resolve(manifestArg);
const outputPath = path.resolve(outputArg);
const timeline = JSON.parse(await readFile(manifestPath, "utf8"));
const manifestDir = path.dirname(manifestPath);
// The cloud service runs as an unprivileged account and /opt is read-only to
// it. Remotion derives its Chromium cache from process.cwd(), so always move
// runtime files into a writable data directory instead of node_modules.
const runtimeDir = path.resolve(
  process.env.REMOTION_RUNTIME_DIR || path.join(manifestDir, ".remotion-runtime"),
);
await mkdir(runtimeDir, {recursive: true});
process.chdir(runtimeDir);
const builtInPublicDir = path.join(serviceDir, "public");
for (const assetFolder of ["fonts", "music", "sfx", "licenses"]) {
  const source = path.join(builtInPublicDir, assetFolder);
  if (existsSync(source)) {
    await cp(source, path.join(manifestDir, assetFolder), {recursive: true, force: false});
  }
}
const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || (existsSync(systemChrome) ? systemChrome : null);
const fps = Number(timeline.fps) || 30;
const durationInFrames = Math.max(1, Math.ceil((Number(timeline.duration) || 1) * fps));
const supersample = Math.min(2, Math.max(1, Number(process.env.REMOTION_SUPERSAMPLE || 2)));
const outputWidth = 1080;
const outputHeight = 1920;
const bundledUrl = await bundle({
  entryPoint: path.join(serviceDir, "src", "index.ts"),
  publicDir: manifestDir,
  // Webpack's default cache lives in <project>/node_modules/.cache, which is
  // intentionally not writable in production. Rendering jobs are infrequent
  // enough that the small rebundle cost is preferable to permission failures.
  enableCaching: false,
  webpackOverride: (config) => config,
});
// Some macOS proxy/DNS configurations resolve localhost through a proxy for
// Chrome even though the Remotion bundle server is bound to loopback.
const serveUrl = bundledUrl.replace("http://localhost:", "http://127.0.0.1:");
const selected = await selectComposition({
  serveUrl,
  port: Number(process.env.REMOTION_PORT || 32123),
  id: "MerchantViralVertical",
  inputProps: {timeline},
  browserExecutable,
  logLevel: process.env.REMOTION_LOG_LEVEL || "info",
});

await renderMedia({
  composition: {...selected, fps, durationInFrames, width: outputWidth, height: outputHeight},
  serveUrl,
  port: Number(process.env.REMOTION_PORT || 32123),
  codec: "h264",
  audioCodec: "aac",
  imageFormat: "png",
  outputLocation: outputPath,
  inputProps: {timeline},
  browserExecutable,
  logLevel: process.env.REMOTION_LOG_LEVEL || "info",
  // OffthreadVideo can produce partially decoded frames when several Chrome
  // workers seek the same mobile MP4 concurrently. Default to one renderer
  // for deterministic frame-by-frame output; operators may raise it after a
  // clean validation render.
  concurrency: Math.max(1, Number(process.env.REMOTION_CONCURRENCY || 1)),
  // High-contrast Chinese glyphs and white outlines need a substantially
  // cleaner master than ordinary talking-head footage. Render at 2x and let
  // the stitcher downsample with Lanczos for stable edge antialiasing.
  scale: supersample,
  crf: Math.min(22, Math.max(8, Number(process.env.REMOTION_CRF || 10))),
  x264Preset: "slow",
  audioBitrate: process.env.REMOTION_AUDIO_BITRATE || "160k",
  pixelFormat: "yuv420p",
  colorSpace: "bt709",
  ffmpegOverride: ({type, args}) => {
    if (type !== "stitcher") return args;
    const output = args.at(-1);
    const baseArgs = args.slice(0, -1);
    const scaleArgs = supersample > 1
      ? ["-vf", `scale=${outputWidth}:${outputHeight}:flags=lanczos+accurate_rnd+full_chroma_int`]
      : [];
    return [
      ...baseArgs,
      ...scaleArgs,
      "-color_range", "tv",
      "-colorspace", "bt709",
      "-color_primaries", "bt709",
      "-color_trc", "bt709",
      output,
    ];
  },
  chromiumOptions: {enableMultiProcessOnLinux: true},
});

// Remotion's temporary bundle server can keep Node's event loop alive even
// after the MP4 has been fully written. Flush the success payload and exit so
// the Python worker can continue to cover extraction and mark the job done.
await new Promise((resolve, reject) => {
  process.stdout.write(
    JSON.stringify({ok: true, output: outputPath, durationInFrames}),
    (error) => error ? reject(error) : resolve(),
  );
});
process.exit(0);
