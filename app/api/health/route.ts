import { getDatabase } from "../../../lib/server/db";
import { purgeExpiredMemberAssets } from "../../../lib/member-assets";
import { importEnvironmentWechatPayCredentials } from "../../../lib/server/wechat-pay-credentials";

export const runtime = "nodejs";

export async function GET() {
  try {
    getDatabase().prepare("SELECT 1 AS ok").get();
    importEnvironmentWechatPayCredentials();
    purgeExpiredMemberAssets();
    return Response.json({ status: "ok", service: "merchant-studio-web", time: new Date().toISOString() });
  } catch {
    return Response.json({ status: "error", service: "merchant-studio-web" }, { status: 503 });
  }
}
