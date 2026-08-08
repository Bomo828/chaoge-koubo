import { getMemberSession } from "../../../member-session";
import { isAdmin } from "../../../../lib/server/auth";
import { getPlatformSettings, savePlatformSettings, type PlatformSettings } from "../../../../lib/server/platform-settings";

export const runtime = "nodejs";

export async function GET() {
  const member = await getMemberSession();
  if (!isAdmin(member)) return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  return Response.json({ settings: getPlatformSettings() });
}

export async function PUT(request: Request) {
  const member = await getMemberSession();
  if (!isAdmin(member)) return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  const body = await request.json().catch(() => null) as { settings?: PlatformSettings } | null;
  if (!body?.settings) return Response.json({ error: "缺少平台设置。" }, { status: 400 });
  return Response.json({ settings: savePlatformSettings(member.id, body.settings) });
}
