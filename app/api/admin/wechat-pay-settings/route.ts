import { getMemberSession } from "../../../member-session";
import {
  getWechatPayCredentialSummary,
  saveWechatPayCredentials,
  type WechatPayCredentialInput,
} from "../../../../lib/server/wechat-pay-credentials";
import { testWechatPayConnection } from "../../../../lib/server/wechat-pay";

export const runtime = "nodejs";
const noStoreHeaders = { "Cache-Control": "no-store" };

async function requirePlatformAdmin() {
  const member = await getMemberSession();
  if (!member || member.role !== "super_admin") return null;
  return member;
}

function inputFrom(value: unknown): WechatPayCredentialInput {
  if (!value || typeof value !== "object") throw new Error("请求内容不完整。");
  const body = value as Record<string, unknown>;
  const text = (key: string, max: number) => typeof body[key] === "string" ? body[key].slice(0, max) : "";
  return {
    mchId: text("mchId", 64),
    appId: text("appId", 64),
    apiV3Key: text("apiV3Key", 128),
    certSerialNo: text("certSerialNo", 256),
    privateKey: text("privateKey", 16_000),
    platformPublicKey: text("platformPublicKey", 16_000),
    platformSerialNo: text("platformSerialNo", 256),
    notifyUrl: text("notifyUrl", 1_000),
  };
}

export async function GET() {
  const member = await requirePlatformAdmin();
  if (!member) return Response.json({ error: "仅平台管理员可以查看微信支付配置。" }, { status: 403, headers: noStoreHeaders });
  return Response.json({ credential: getWechatPayCredentialSummary() }, { headers: noStoreHeaders });
}

export async function PUT(request: Request) {
  const member = await requirePlatformAdmin();
  if (!member) return Response.json({ error: "仅平台管理员可以保存微信支付配置。" }, { status: 403, headers: noStoreHeaders });
  try {
    const credential = saveWechatPayCredentials(member.id, inputFrom(await request.json().catch(() => null)));
    return Response.json({ credential }, { headers: noStoreHeaders });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "微信支付配置保存失败。" }, { status: 400, headers: noStoreHeaders });
  }
}

export async function POST() {
  const member = await requirePlatformAdmin();
  if (!member) return Response.json({ error: "仅平台管理员可以测试微信支付连接。" }, { status: 403, headers: noStoreHeaders });
  try {
    return Response.json(await testWechatPayConnection(), { headers: noStoreHeaders });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "微信支付连接测试失败。" }, { status: 400, headers: noStoreHeaders });
  }
}
