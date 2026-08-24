import { getDatabase, parseJson, unixNow } from "./db";

export type PlatformFeature = {
  id: string;
  name: string;
  icon: string;
  description: string;
  entry: "overview" | "design" | "video" | "cases" | "assets" | "member";
  enabled: boolean;
  sortOrder: number;
};

export type PointRule = {
  action: "prompt_optimize" | "chat_assistant" | "image_generate" | "video_generate" | "voice_clone" | "speech_generate" | "lip_sync_generate" | "market_account_add";
  name: string;
  points: number;
  enabled: boolean;
};

export type RechargePackage = {
  id: string;
  name: string;
  points: number;
  bonus: number;
  priceYuan: number;
  enabled: boolean;
};

export type AiProviderSetting = {
  id: "lk888" | "chanjing" | "tikhub" | "video-worker";
  name: string;
  purpose: string;
  enabled: boolean;
  lowBalanceThreshold: number;
};

export type PlatformSettings = {
  features: PlatformFeature[];
  pointRules: PointRule[];
  rechargePackages: RechargePackage[];
  rechargePointsPerYuan: number;
  aiProviders: AiProviderSetting[];
  paymentMode: "demo" | "wechat";
  newUserPoints: number;
};

export const defaultPlatformSettings: PlatformSettings = {
  features: [
    { id: "overview", name: "创作首页", icon: "⌂", description: "创作入口与最近作品", entry: "overview", enabled: true, sortOrder: 10 },
    { id: "design", name: "图片设计", icon: "图", description: "营销海报、朋友圈与门店物料", entry: "design", enabled: true, sortOrder: 30 },
    { id: "video", name: "短视频", icon: "视", description: "商家成片、对口型与一键网感", entry: "video", enabled: true, sortOrder: 40 },
    { id: "cases", name: "市场动态", icon: "动", description: "对标账号与短视频数据动态", entry: "cases", enabled: true, sortOrder: 50 },
    { id: "assets", name: "会员资产", icon: "资", description: "图片、视频和声音资产", entry: "assets", enabled: true, sortOrder: 60 },
    { id: "member", name: "会员中心", icon: "会", description: "积分、充值和商家资产", entry: "member", enabled: true, sortOrder: 70 },
  ],
  pointRules: [
    { action: "prompt_optimize", name: "AI 文案与方案分析", points: 2, enabled: true },
    { action: "chat_assistant", name: "AI 助手（按实际算力结算）", points: 1, enabled: true },
    { action: "image_generate", name: "AI 图片生成（基础单张）", points: 10, enabled: true },
    { action: "video_generate", name: "AI 视频与网感剪辑", points: 28, enabled: true },
    { action: "voice_clone", name: "克隆声音（成本 80 / 次）", points: 80, enabled: true },
    { action: "speech_generate", name: "口播音频（成本 0.15 / 秒）", points: 1, enabled: true },
    { action: "lip_sync_generate", name: "对口型（成本 80 + 2 / 秒）", points: 80, enabled: true },
    { action: "market_account_add", name: "添加对标账号", points: 10, enabled: true },
  ],
  rechargePackages: [
    { id: "starter", name: "体验包", points: 1000, bonus: 0, priceYuan: 99, enabled: true },
    { id: "growth", name: "成长包", points: 3000, bonus: 300, priceYuan: 299, enabled: true },
    { id: "business", name: "商家包", points: 10000, bonus: 1500, priceYuan: 999, enabled: true },
  ],
  rechargePointsPerYuan: 10,
  aiProviders: [
    { id: "lk888", name: "开放 AI 平台", purpose: "大模型分析、GPT Image 2、Seedance 2.0", enabled: true, lowBalanceThreshold: 20 },
    { id: "chanjing", name: "蝉镜数字人", purpose: "声音克隆、口播音频与对口型", enabled: true, lowBalanceThreshold: 20 },
    { id: "tikhub", name: "市场数据服务", purpose: "抖音公开账号资料、作品与互动数据", enabled: true, lowBalanceThreshold: 10 },
    { id: "video-worker", name: "视频处理服务", purpose: "字幕、模板、转场、音效与成片", enabled: true, lowBalanceThreshold: 0 },
  ],
  paymentMode: "demo",
  newUserPoints: 100,
};

const SETTING_KEY = "platform_control";

export function getPlatformSettings(): PlatformSettings {
  const row = getDatabase().prepare("SELECT value_json FROM system_settings WHERE key = ? LIMIT 1").get(SETTING_KEY) as { value_json?: string } | undefined;
  const saved = parseJson<Partial<PlatformSettings>>(row?.value_json, {});
  return {
    ...defaultPlatformSettings,
    ...saved,
    features: (Array.isArray(saved.features) ? saved.features : defaultPlatformSettings.features)
      .filter((item) => String(item.entry) !== "decorate") as PlatformFeature[],
    pointRules: defaultPlatformSettings.pointRules
      .map((fallback) => {
        const savedRule = Array.isArray(saved.pointRules)
          ? saved.pointRules.find((item) => item.action === fallback.action)
          : undefined;
        const item = savedRule ? { ...fallback, ...savedRule } : fallback;
        if (item.action === "voice_clone") {
          return { ...item, name: "克隆声音（成本 80 / 次）", points: Number(item.points) === 10 ? 80 : item.points };
        }
        if (item.action === "speech_generate") {
          return { ...item, name: "口播音频（成本 0.15 / 秒）", points: 1 };
        }
        if (item.action === "lip_sync_generate") {
          return { ...item, name: "对口型（成本 80 + 2 / 秒）", points: Number(item.points) === 200 ? 80 : item.points };
        }
        return item;
      }) as PointRule[],
    rechargePackages: Array.isArray(saved.rechargePackages) ? saved.rechargePackages : defaultPlatformSettings.rechargePackages,
    aiProviders: defaultPlatformSettings.aiProviders.map((fallback) => {
      const savedProvider = Array.isArray(saved.aiProviders)
        ? saved.aiProviders.find((item) => item.id === fallback.id)
        : undefined;
      return savedProvider ? { ...fallback, ...savedProvider } : fallback;
    }),
  };
}

export function savePlatformSettings(actorId: string, input: PlatformSettings) {
  const rechargePointsPerYuan = Math.min(100000, Math.max(1, Math.floor(Number(input.rechargePointsPerYuan) || 10)));
  const normalized: PlatformSettings = {
    features: input.features.filter((item) => String(item.entry) !== "decorate").slice(0, 30).map((item, index) => ({
      id: String(item.id || `feature-${index + 1}`).trim().slice(0, 40),
      name: String(item.name || "未命名功能").trim().slice(0, 30),
      icon: String(item.icon || "功").trim().slice(0, 2),
      description: String(item.description || "").trim().slice(0, 100),
      entry: item.entry,
      enabled: Boolean(item.enabled),
      sortOrder: Number.isFinite(Number(item.sortOrder)) ? Number(item.sortOrder) : (index + 1) * 10,
    })),
    pointRules: input.pointRules.filter((item) => String(item.action) !== "theme_analysis").map((item) => ({ ...item, points: Math.max(0, Math.floor(Number(item.points) || 0)), enabled: Boolean(item.enabled) })),
    rechargePackages: input.rechargePackages.slice(0, 12).map((item, index) => {
      const priceYuan = Math.max(0.01, Number(Number(item.priceYuan || 0.01).toFixed(2)));
      return {
        id: String(item.id || `package-${index + 1}`).trim().slice(0, 40),
        name: String(item.name || "积分包").trim().slice(0, 30),
        points: Math.max(1, Math.floor(priceYuan * rechargePointsPerYuan)),
        bonus: Math.max(0, Math.floor(Number(item.bonus) || 0)),
        priceYuan,
        enabled: Boolean(item.enabled),
      };
    }),
    rechargePointsPerYuan,
    aiProviders: input.aiProviders.map((item) => ({ ...item, enabled: Boolean(item.enabled), lowBalanceThreshold: Math.max(0, Number(item.lowBalanceThreshold) || 0) })),
    paymentMode: input.paymentMode === "wechat" ? "wechat" : "demo",
    newUserPoints: Math.max(0, Math.floor(Number(input.newUserPoints) || 0)),
  };
  getDatabase().prepare(`
    INSERT INTO system_settings (key, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(SETTING_KEY, JSON.stringify(normalized), actorId, unixNow());
  return normalized;
}

export function rechargeBasePoints(settings: Pick<PlatformSettings, "rechargePointsPerYuan">, item: Pick<RechargePackage, "priceYuan">) {
  return Math.max(1, Math.floor(Number(item.priceYuan) * Number(settings.rechargePointsPerYuan || 10)));
}

export function rechargeTotalPoints(settings: Pick<PlatformSettings, "rechargePointsPerYuan">, item: Pick<RechargePackage, "priceYuan" | "bonus">) {
  return rechargeBasePoints(settings, item) + Math.max(0, Math.floor(Number(item.bonus) || 0));
}

export function pointCost(action: PointRule["action"], fallback: number) {
  const rule = getPlatformSettings().pointRules.find((item) => item.action === action);
  return rule?.enabled === false ? 0 : Math.max(0, Number(rule?.points ?? fallback));
}
