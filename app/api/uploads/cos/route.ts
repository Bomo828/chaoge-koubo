import { randomUUID } from "node:crypto";
import { getMemberSession } from "../../../member-session";
import {
  signedCosObjectUrl,
  signedCosUploadUrl,
  tencentMpsConfigStatus,
  viralSourceObjectKey,
} from "../../../../lib/server/tencent-mps";

const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

function cleanFilename(value: unknown) {
  const source = typeof value === "string" ? value.trim() : "";
  return (source || "source.mp4").replace(/[\\/]+/g, "-").slice(-180);
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  const status = tencentMpsConfigStatus();
  if (!status.configured) return Response.json({ error: "云端直传尚未配置。" }, { status: 503 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const filename = cleanFilename(body.filename);
    const contentType = typeof body.contentType === "string" ? body.contentType.trim().toLowerCase() : "";
    const sizeBytes = Number(body.sizeBytes || 0);
    if (!contentType.startsWith("video/")) return Response.json({ error: "只允许直传视频文件。" }, { status: 400 });
    if (!Number.isFinite(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_VIDEO_BYTES) {
      return Response.json({ error: "视频大小无效或超过 500MB。" }, { status: 400 });
    }
    const uploadId = randomUUID().replaceAll("-", "");
    const objectKey = viralSourceObjectKey(member.id, uploadId, filename);
    const now = Math.floor(Date.now() / 1000);
    return Response.json({
      objectKey,
      uploadUrl: signedCosUploadUrl(objectKey, 30 * 60),
      sourceUrl: signedCosObjectUrl(objectKey, 24 * 60 * 60),
      uploadExpiresAt: (now + 30 * 60) * 1000,
      sourceExpiresAt: (now + 24 * 60 * 60) * 1000,
    });
  } catch (error) {
    console.error("Create COS direct upload failed", error);
    return Response.json({ error: "创建云端上传地址失败，请稍后重试。" }, { status: 500 });
  }
}
