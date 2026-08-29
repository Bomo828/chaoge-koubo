import { createHmac, timingSafeEqual } from "node:crypto";

export type MemberAssetAccessPurpose = "media" | "cover" | "download" | "import";

type MemberAssetAccessPayload = {
  memberId: string;
  assetId: string;
  purpose: MemberAssetAccessPurpose;
  expiresAt: number;
};

function signingSecret() {
  return process.env.MEMBER_ASSET_SIGNING_SECRET?.trim()
    || process.env.VIDEO_WORKER_ADMIN_TOKEN?.trim()
    || process.env.WECHAT_PAY_API_V3_KEY?.trim()
    || process.env.TENCENT_CLOUD_SECRET_KEY?.trim()
    || "";
}

function signature(encodedPayload: string, secret: string) {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export function createMemberAssetAccessToken(
  memberId: string,
  assetId: string,
  purpose: MemberAssetAccessPurpose,
  expiresInSeconds = 2 * 60 * 60,
) {
  const secret = signingSecret();
  if (!secret) return "";
  const payload: MemberAssetAccessPayload = {
    memberId,
    assetId,
    purpose,
    expiresAt: Math.floor(Date.now() / 1000) + Math.max(300, Math.min(expiresInSeconds, 24 * 60 * 60)),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${signature(encodedPayload, secret)}`;
}

export function verifyMemberAssetAccessToken(
  token: string,
  assetId: string,
  purpose: MemberAssetAccessPurpose,
) {
  const secret = signingSecret();
  if (!secret || !token) return null;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return null;
  const encodedPayload = token.slice(0, separator);
  const receivedSignature = token.slice(separator + 1);
  const expectedSignature = signature(encodedPayload, secret);
  const received = Buffer.from(receivedSignature);
  const expected = Buffer.from(expectedSignature);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<MemberAssetAccessPayload>;
    if (payload.assetId !== assetId || payload.purpose !== purpose || typeof payload.memberId !== "string") return null;
    if (!Number.isFinite(payload.expiresAt) || Number(payload.expiresAt) <= Math.floor(Date.now() / 1000)) return null;
    return payload as MemberAssetAccessPayload;
  } catch {
    return null;
  }
}
