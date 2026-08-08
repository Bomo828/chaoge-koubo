import { getMemberSession } from "../../../member-session";
import { isAdmin } from "../../../../lib/server/auth";
import { lk888Fetch } from "../../../../lib/lk888";
import { getPlatformSettings } from "../../../../lib/server/platform-settings";

export const runtime = "nodejs";

type Balance = { balance?: number; unit?: string; api_key_quota?: { limit?: number | null; used?: number } };

export async function GET() {
  const member = await getMemberSession();
  if (!isAdmin(member)) return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  const settings = getPlatformSettings();
  const lkSetting = settings.aiProviders.find((item) => item.id === "lk888");
  let balance: Balance | null = null;
  let lkError = "";
  try {
    balance = await lk888Fetch<Balance>("/v1/skills/balance", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    lkError = error instanceof Error ? error.message : "连接失败";
  }
  const available = Number(balance?.balance ?? 0);
  const workerUrl = process.env.NEXT_PUBLIC_VIDEO_WORKER_URL?.trim() || "";
  return Response.json({
    checkedAt: Date.now(),
    services: [
      {
        id: "lk888",
        name: "开放 AI 平台",
        configured: Boolean(process.env.LK888_API_KEY),
        connected: Boolean(balance),
        balance: Number.isFinite(available) ? available : null,
        unit: balance?.unit || "算力",
        sufficient: Boolean(balance) && available >= Number(lkSetting?.lowBalanceThreshold || 0),
        message: lkError || "已读取实时余额",
        secretHint: process.env.LK888_API_KEY ? "已通过服务器环境变量配置" : "尚未配置 LK888_API_KEY",
      },
      {
        id: "chanjing",
        name: "蝉镜数字人",
        configured: Boolean(process.env.CHANJING_APP_ID && process.env.CHANJING_SECRET_KEY),
        connected: Boolean(process.env.CHANJING_APP_ID && process.env.CHANJING_SECRET_KEY),
        balance: null,
        unit: "接口状态",
        sufficient: Boolean(process.env.CHANJING_APP_ID && process.env.CHANJING_SECRET_KEY),
        message: "当前接口未提供统一余额查询，按任务回执监控",
        secretHint: process.env.CHANJING_APP_ID ? "AppID 与密钥已安全配置" : "尚未配置蝉镜凭证",
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
