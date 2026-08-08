import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

export const runtime = "nodejs";

function contentType(name: string) {
  if (name.endsWith(".mp4")) return "video/mp4";
  if (name.endsWith(".webm")) return "video/webm";
  if (name.endsWith(".mov")) return "video/quicktime";
  if (name.endsWith(".jpg")) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

export async function GET(request: Request, context: { params: Promise<{ name: string }> }) {
  const { name } = await context.params;
  if (!/^[a-f0-9-]+\.(mp4|webm|mov|jpg|png|webp)$/i.test(name)) {
    return new Response("Not found", { status: 404 });
  }
  const root = process.env.APP_DATA_DIR?.trim() || ".data";
  const filePath = path.join(root, "uploads", name);
  if (!existsSync(filePath)) return new Response("Not found", { status: 404 });
  const size = statSync(filePath).size;
  const range = request.headers.get("range");
  const headers = { "Content-Type": contentType(name), "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=31536000, immutable" };
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return new Response(null, { status: 416 });
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start < 0 || end < start || start >= size) return new Response(null, { status: 416 });
    const stream = createReadStream(filePath, { start, end });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: { ...headers, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${size}` },
    });
  }
  return new Response(Readable.toWeb(createReadStream(filePath)) as ReadableStream, {
    headers: { ...headers, "Content-Length": String(size) },
  });
}
