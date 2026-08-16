import { randomUUID } from "node:crypto";
import { getMemberSession } from "../../../../member-session";
import { putCosObject, signedCosObjectUrl, tencentMpsConfigStatus } from "../../../../../lib/server/tencent-mps";

export const runtime = "nodejs";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const allowedTypes = new Set([
  "image/jpeg", "image/png", "image/webp", "application/pdf", "text/plain", "text/csv",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

function safeFilename(name: string) {
  const cleaned = name.normalize("NFKC").replace(/[^a-zA-Z0-9._\u4e00-\u9fff-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(-100) || "attachment.bin";
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  const status = tencentMpsConfigStatus();
  if (!status.configured) return Response.json({ error: "文档上传服务尚未配置。" }, { status: 503 });
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size < 1) return Response.json({ error: "请选择需要分析的文件。" }, { status: 400 });
  if (file.size > MAX_FILE_BYTES) return Response.json({ error: "单个附件不能超过 25MB。" }, { status: 413 });
  if (!allowedTypes.has(file.type)) return Response.json({ error: "支持图片、PDF、Word、Excel、PPT、TXT 和 CSV。" }, { status: 415 });
  try {
    const objectKey = `assistant/attachments/${member.id}/${Date.now()}-${randomUUID()}-${safeFilename(file.name)}`;
    await putCosObject(objectKey, Buffer.from(await file.arrayBuffer()), file.type || "application/octet-stream");
    return Response.json({
      name: file.name,
      size: file.size,
      contentType: file.type,
      url: signedCosObjectUrl(objectKey),
    });
  } catch (error) {
    console.error("AI assistant attachment upload failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "附件上传失败。" }, { status: 500 });
  }
}
