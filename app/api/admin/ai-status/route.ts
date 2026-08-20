import { getMemberSession } from "../../../member-session";
import { isAdmin } from "../../../../lib/server/auth";
import { lk888Fetch } from "../../../../lib/lk888";
import { getPlatformSettings } from "../../../../lib/server/platform-settings";
import { getChanjingBalance } from "../../../../lib/chanjing";
import { getChanjingCredentialSummary, getLk888CredentialSummary } from "../../../../lib/server/ai-credentials";

export const runtime = "nodejs";

type Balance = { balance?: number; unit?: string; api_key_quota?: { limit?: number | null; used?: number } };

export async function GET() {
  const member = await getMemberSession();
  if (!isAdmin(member)) return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  const settings = getPlatformSettings();
  const lkCredential = getLk888CredentialSummary();
  const lkSetting = settings.aiProviders.find((item) => item.id === "lk888");
  let balance: Balance | null = null;
  let lkError = "";
  try {
    balance = await lk888Fetch<Balance>("/v1/skills/balance", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    lkError = error instanceof Error ? error.message : "连接失败";
  }
  const available = Number(balance?.balance ?? 0);
  const chanjingSetting = settings.aiProviders.find((item) => item.id === "chanjing");
  const chanjingCredential = getChanjingCredentialSummary();
  let chanjingBalance: number | null = null;
  let chanjingError = "";
  try {
    chanjingBalance = await getChanjingBalance();
  } catch (error) {
    chanjingError = error instanceof Error ? error.message : "连接失败";
  }
  const workerUrl = process.env.NEXT_PUBLIC_VIDEO_WORKER_URL?.trim() || "";
  return Response.json({
    checkedAt: Date.now(),
    services: [
      {
        id: "lk888",
        name: "开放 AI 平台",
        configured: lkCredential.configured,
        connected: Boolean(balance),
        balance: Number.isFinite(available) ? available : null,
        unit: balance?.unit || "算力",
        sufficient: Boolean(balance) && available >= Number(lkSetting?.lowBalanceThreshold || 0),
        message: lkError || "已读取实时余额",
        secretHint: lkCredential.configured
          ? `${lkCredential.maskedKey} · ${lkCredential.source === "admin" ? "后台配置" : "服务器配置"}`
          : "尚未配置大模型 API Key",
        baseUrl: lkCredential.baseUrl,
        credentialSource: lkCredential.source,
        credentialUpdatedAt: lkCredential.updatedAt,
      },
      {
        id: "chanjing",
        name: "蝉镜数字人",
        configured: chanjingCredential.configured,
        connected: chanjingBalance !== null,
        balance: chanjingBalance,
        unit: "蝉豆",
        sufficient: chanjingBalance !== null && chanjingBalance >= Number(chanjingSetting?.lowBalanceThreshold || 0),
        message: chanjingError || "已读取实时蝉豆余额",
        secretHint: chanjingCredential.configured
          ? `AppID ${chanjingCredential.maskedAppId} · 密钥 ${chanjingCredential.maskedSecretKey} · ${chanjingCredential.source === "admin" ? "后台配置" : "服务器配置"}`
          : "尚未配置蝉镜 AppID 与密钥",
        baseUrl: chanjingCredential.baseUrl,
        credentialSource: chanjingCredential.source,
        credentialUpdatedAt: chanjingCredential.updatedAt,
      },
      {
        id: "video-worker",
        name: "视频处理服务",
        configured: Boolean(workerUrl),
        connected: Boolean(workerUrl),
        balance: null,
        unit: "服务状态",
        sufficient: Boolean(workerUrl),
        message: workerUrl ? "已配置云端视频工作节点" : "尚未配置视频工作节点",
        secretHint: workerUrl || "未配置 NEXT_PUBLIC_VIDEO_WORKER_URL",
      },
    ],
  });
}
