import { getDatabase } from "../../../lib/server/db";
import { purgeExpiredMemberAssets } from "../../../lib/member-assets";
import { importEnvironmentWechatPayCredentials } from "../../../lib/server/wechat-pay-credentials";
import { importDeepSeekBootstrapCredential } from "../../../lib/server/ai-credentials";

export const runtime = "nodejs";

export async function GET() {
  try {
    getDatabase().prepare("SELECT 1 AS ok").get();
    importDeepSeekBootstrapCredential();
    importEnvironmentWechatPayCredentials();
    purgeExpiredMemberAssets();
    return Response.json({ status: "ok", service: "merchant-studio-web", time: new Date().toISOString() });
  } catch {
    return Response.json({ status: "error", service: "merchant-studio-web" }, { status: 503 });
  }
}
