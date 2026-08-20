import { getMemberSession } from "../../../member-session";
import {
  getProviderCredentialSummary,
  saveProviderCredentials,
  testProviderCredentials,
  type ProviderCredentialId,
} from "../../../../lib/server/ai-credentials";

export const runtime = "nodejs";
const noStoreHeaders = { "Cache-Control": "no-store" };

async function requirePlatformAdmin() {
  const member = await getMemberSession();
  if (!member || member.role !== "super_admin") return null;
  return member;
}

function providerIdFrom(value: unknown): ProviderCredentialId {
  if (value === "lk888" || value === "chanjing") return value;
  throw new Error("暂不支持这个服务的接口配置。");
}

function inputFrom(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("请求内容不完整。");
  const body = value as Record<string, unknown>;
  return {
    providerId: providerIdFrom(body.providerId),
    apiKey: typeof body.apiKey === "string" ? body.apiKey.slice(0, 500) : "",
    appId: typeof body.appId === "string" ? body.appId.slice(0, 500) : "",
    secretKey: typeof body.secretKey === "string" ? body.secretKey.slice(0, 500) : "",
    baseUrl: typeof body.baseUrl === "string" ? body.baseUrl.slice(0, 500) : "",
  };
}

export async function GET(request: Request) {
  const member = await requirePlatformAdmin();
  if (!member) return Response.json({ error: "仅平台管理员可以查看接口凭证状态。" }, { status: 403, headers: noStoreHeaders });
  try {
    const providerId = providerIdFrom(new URL(request.url).searchParams.get("provider"));
    return Response.json({ credential: getProviderCredentialSummary(providerId) }, { headers: noStoreHeaders });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "读取接口配置失败。" }, { status: 400, headers: noStoreHeaders });
  }
}

export async function POST(request: Request) {
  const member = await requirePlatformAdmin();
  if (!member) return Response.json({ error: "仅平台管理员可以测试接口凭证。" }, { status: 403, headers: noStoreHeaders });
  try {
    const input = inputFrom(await request.json().catch(() => null));
    return Response.json(await testProviderCredentials(input.providerId, input), { headers: noStoreHeaders });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "接口连接失败。" }, { status: 400, headers: noStoreHeaders });
  }
}

export async function PUT(request: Request) {
  const member = await requirePlatformAdmin();
  if (!member) return Response.json({ error: "仅平台管理员可以更换接口凭证。" }, { status: 403, headers: noStoreHeaders });
  try {
    const input = inputFrom(await request.json().catch(() => null));
    const credential = await saveProviderCredentials(input.providerId, member.id, input);
    return Response.json({ credential }, { headers: noStoreHeaders });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "接口凭证保存失败。" }, { status: 400, headers: noStoreHeaders });
  }
}
