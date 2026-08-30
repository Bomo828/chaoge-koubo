import { getMemberSession } from "../../../member-session";
import { isAdmin } from "../../../../lib/server/auth";
import { lk888Fetch } from "../../../../lib/lk888";
import { getPlatformSettings } from "../../../../lib/server/platform-settings";
import { getChanjingBalance } from "../../../../lib/chanjing";
import {
  getChanjingCredentialSummary,
  getDeepSeekConfig,
  getDeepSeekCredentialSummary,
  getLk888CredentialSummary,
  getTikHubConfig,
  getTikHubCredentialSummary,
} from "../../../../lib/server/ai-credentials";
import { videoWorkerPublicUrl, videoWorkerUpstreamUrl } from "../../../../lib/server/video-worker";

export const runtime = "nodejs";

type Balance = { balance?: number; unit?: string; api_key_quota?: { limit?: number | null; used?: number } };

export async function GET() {
  const member = await getMemberSession();
  if (!isAdmin(member)) return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  const settings = getPlatformSettings();
  const deepSeekSetting = settings.aiProviders.find((item) => item.id === "deepseek");
  const deepSeekCredential = getDeepSeekCredentialSummary();
  const deepSeek = getDeepSeekConfig();
  let deepSeekConnected = false;
  let deepSeekError = "";
  if (deepSeek.apiKey) {
    try {
      const response = await fetch(`${deepSeek.baseUrl}/models`, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${deepSeek.apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });
      const payload = await response.json().catch(() => ({})) as { data?: Array<{ id?: string }> };
      deepSeekConnected = response.ok && Boolean(payload.data?.some((item) => item.id === "deepseek-v4-flash"));
      if (!deepSeekConnected) deepSeekError = `模型状态读取失败（${response.status}）`;
    } catch (error) {
      deepSeekError = error instanceof Error ? error.message : "连接失败";
    }
  } else {
    deepSeekError = "尚未配置 DeepSeek API Key";
  }
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
  const workerUrl = videoWorkerPublicUrl();
  const workerUpstream = videoWorkerUpstreamUrl();
  const tikhubSetting = settings.aiProviders.find((item) => item.id === "tikhub");
  const tikhubCredential = getTikHubCredentialSummary();
  const tikhub = getTikHubConfig();
  let tikhubBalance: number | null = null;
  let tikhubError = "";
  if (tikhub.apiKey) {
    try {
      const response = await fetch(`${tikhub.baseUrl}/api/v1/tikhub/user/get_user_info`, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${tikhub.apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok || Number(payload.code ?? 0) !== 200) throw new Error(`接口连接失败（${response.status}）`);
      const userData = payload.user_data && typeof payload.user_data === "object"
        ? payload.user_data as Record<string, unknown>
        : {};
      const paid = Number(userData.balance);
      const free = Number(userData.free_credit);
      tikhubBalance = (Number.isFinite(paid) ? paid : 0) + (Number.isFinite(free) ? free : 0);
    } catch (error) {
      tikhubError = error instanceof Error ? error.message : "连接失败";
    }
  } else {
    tikhubError = "尚未配置 TikHub API Key";
  }
  return Response.json({
    checkedAt: Date.now(),
    services: [
      {
        id: "deepseek",
        name: "DeepSeek 字幕导演",
        configured: deepSeekCredential.configured,
        connected: deepSeekConnected,
        balance: null,
        unit: "服务状态",
        sufficient: deepSeekConnected && Boolean(deepSeekSetting?.enabled),
        message: deepSeekError || "deepseek-v4-flash 可用",
        secretHint: deepSeekCredential.configured
          ? `${deepSeekCredential.maskedKey} · ${deepSeekCredential.source === "admin" ? "后台配置" : "服务器配置"}`
          : "尚未配置 DeepSeek API Key",
        baseUrl: deepSeekCredential.baseUrl,
        credentialSource: deepSeekCredential.source,
        credentialUpdatedAt: deepSeekCredential.updatedAt,
      },
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
        id: "tikhub",
        name: "市场数据服务",
        configured: tikhubCredential.configured,
        connected: tikhubBalance !== null,
        balance: tikhubBalance,
        unit: "额度",
        sufficient: tikhubBalance !== null && tikhubBalance >= Number(tikhubSetting?.lowBalanceThreshold || 0),
        message: tikhubError || "公开账号与作品接口可用",
        secretHint: tikhubCredential.configured
          ? `${tikhubCredential.maskedKey} · ${tikhubCredential.source === "admin" ? "后台配置" : "服务器配置"}`
          : "尚未配置 TikHub API Key",
        baseUrl: tikhubCredential.baseUrl,
        credentialSource: tikhubCredential.source,
        credentialUpdatedAt: tikhubCredential.updatedAt,
      },
      {
        id: "video-worker",
        name: "视频处理服务",
        configured: Boolean(workerUrl),
        connected: Boolean(workerUrl),
        balance: null,
        unit: "服务状态",
        sufficient: Boolean(workerUrl),
        message: workerUpstream ? "已配置独立视频渲染节点" : "尚未配置视频工作节点",
        secretHint: workerUrl || "未配置视频工作节点入口",
      },
    ],
  });
}
