import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { getMemberSession } from "../../../member-session";
import { isAdmin } from "../../../../lib/server/auth";

export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

function uploadDirectory() {
  const root = process.env.APP_DATA_DIR?.trim() || ".data";
  return path.join(root, "uploads");
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!isAdmin(member)) return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "请选择需要上传的文件。" }, { status: 400 });
  if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "文件大小必须在 500MB 以内。" }, { status: 400 });
  }
  const allowed = new Set(["video/mp4", "video/webm", "video/quicktime", "image/jpeg", "image/png", "image/webp"]);
  if (!allowed.has(file.type)) return Response.json({ error: "仅支持 MP4、MOV、WebM、JPG、PNG 和 WebP。" }, { status: 400 });
  const extensionByType: Record<string, string> = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
  const name = `${randomUUID()}.${extensionByType[file.type] || "bin"}`;
  const directory = uploadDirectory();
  mkdirSync(directory, { recursive: true });
  await pipeline(Readable.fromWeb(file.stream() as never), createWriteStream(path.join(directory, name)));
  return Response.json({
    name: file.name,
    size: file.size,
    contentType: file.type,
    url: `/api/uploads/${name}`,
  }, { status: 201 });
}
