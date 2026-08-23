import {cp, mkdir, readFile, symlink} from "node:fs/promises";
import {existsSync} from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {bundle} from "@remotion/bundler";
import {renderStill, selectComposition} from "@remotion/renderer";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const serviceDir = path.resolve(currentDir, "..");
const [manifestArg, outputArg, frameArg] = process.argv.slice(2);
if (!manifestArg || !outputArg) {
  throw new Error("用法：node scripts/render-still.mjs <timeline.json> <output.png> [frame]");
}

const manifestPath = path.resolve(manifestArg);
const outputPath = path.resolve(outputArg);
const timeline = JSON.parse(await readFile(manifestPath, "utf8"));
const manifestDir = path.dirname(manifestPath);
const runtimeDir = path.resolve(
  process.env.REMOTION_RUNTIME_DIR || path.join(manifestDir, ".remotion-runtime-still"),
);
await mkdir(runtimeDir, {recursive: true});
process.chdir(runtimeDir);

const builtInPublicDir = path.join(serviceDir, "public");
for (const assetFolder of ["fonts", "music", "sfx", "licenses"]) {
  const source = path.join(builtInPublicDir, assetFolder);
  const destination = path.join(manifestDir, assetFolder);
  if (existsSync(source) && !existsSync(destination)) {
    try {
      await symlink(source, destination, "dir");
    } catch (error) {
      if (error?.code !== "EPERM" && error?.code !== "EACCES" && error?.code !== "ENOTSUP") throw error;
      await cp(source, destination, {recursive: true, force: false});
    }
  }
}

const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || (existsSync(systemChrome) ? systemChrome : null);
const fps = Number(timeline.fps) || 30;
const durationInFrames = Math.max(1, Math.ceil((Number(timeline.duration) || 1) * fps));
const requestedFrame = Number.isFinite(Number(frameArg)) ? Number(frameArg) : 0;
const frame = Math.max(0, Math.min(durationInFrames - 1, Math.round(requestedFrame)));
const bundledUrl = await bundle({
  entryPoint: path.join(serviceDir, "src", "index.ts"),
  publicDir: manifestDir,
  enableCaching: false,
  webpackOverride: (config) => config,
});
const serveUrl = bundledUrl.replace("http://localhost:", "http://127.0.0.1:");
const port = Number(process.env.REMOTION_PORT || 32123);
const selected = await selectComposition({
  serveUrl,
  port,
  id: "MerchantViralVertical",
  inputProps: {timeline},
  browserExecutable,
  logLevel: process.env.REMOTION_LOG_LEVEL || "info",
});

await renderStill({
  composition: {...selected, fps, durationInFrames, width: 1080, height: 1920},
  serveUrl,
  port,
  output: outputPath,
  frame,
  inputProps: {timeline},
  browserExecutable,
  logLevel: process.env.REMOTION_LOG_LEVEL || "info",
  imageFormat: outputPath.toLowerCase().endsWith(".jpg") ? "jpeg" : "png",
});

process.stdout.write(JSON.stringify({ok: true, output: outputPath, frame}));
process.exit(0);
