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
  action: "prompt_optimize" | "image_generate" | "video_generate" | "voice_clone" | "speech_generate" | "lip_sync_generate";
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
  id: "lk888" | "chanjing" | "video-worker";
  name: string;
  purpose: string;
  enabled: boolean;
  lowBalanceThreshold: number;
};

export type PlatformSettings = {
  features: PlatformFeature[];
  pointRules: PointRule[];
  rechargePackages: RechargePackage[];
  aiProviders: AiProviderSetting[];
  paymentMode: "demo" | "wechat";
  newUserPoints: number;
};

export const defaultPlatformSettings: PlatformSettings = {
  features: [
    { id: "overview", name: "创作首页", icon: "⌂", description: "创作入口与最近作品", entry: "overview", enabled: true, sortOrder: 10 },
    { id: "design", name: "图片设计", icon: "图", description: "营销海报、朋友圈与门店物料", entry: "design", enabled: true, sortOrder: 30 },
    { id: "video", name: "短视频", icon: "视", description: "商家成片、对口型与一键网感", entry: "video", enabled: true, sortOrder: 40 },
    { id: "cases", name: "行业案例", icon: "案", description: "图片与短视频案例库", entry: "cases", enabled: true, sortOrder: 50 },
    { id: "assets", name: "会员资产", icon: "资", description: "图片、视频和声音资产", entry: "assets", enabled: true, sortOrder: 60 },
    { id: "member", name: "会员中心", icon: "会", description: "积分、充值和商家资产", entry: "member", enabled: true, sortOrder: 70 },
  ],
  pointRules: [
    { action: "prompt_optimize", name: "AI 文案与方案分析", points: 2, enabled: true },
    { action: "image_generate", name: "AI 图片生成（基础单张）", points: 10, enabled: true },
    { action: "video_generate", name: "AI 视频与网感剪辑", points: 28, enabled: true },
    { action: "voice_clone", name: "克隆声音", points: 10, enabled: true },
    { action: "speech_generate", name: "生成口播音频", points: 1, enabled: true },
    { action: "lip_sync_generate", name: "生成对口型视频", points: 200, enabled: true },
  ],
  rechargePackages: [
    { id: "starter", name: "体验包", points: 1000, bonus: 0, priceYuan: 99, enabled: true },
    { id: "growth", name: "成长包", points: 3000, bonus: 300, priceYuan: 299, enabled: true },
    { id: "business", name: "商家包", points: 10000, bonus: 1500, priceYuan: 999, enabled: true },
  ],
  aiProviders: [
    { id: "lk888", name: "开放 AI 平台", purpose: "大模型分析、GPT Image 2、Seedance 2.0", enabled: true, lowBalanceThreshold: 20 },
    { id: "chanjing", name: "蝉镜数字人", purpose: "声音克隆、口播音频与对口型", enabled: true, lowBalanceThreshold: 20 },
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
    pointRules: (Array.isArray(saved.pointRules) ? saved.pointRules : defaultPlatformSettings.pointRules)
      .filter((item) => String(item.action) !== "theme_analysis") as PointRule[],
    rechargePackages: Array.isArray(saved.rechargePackages) ? saved.rechargePackages : defaultPlatformSettings.rechargePackages,
    aiProviders: Array.isArray(saved.aiProviders) ? saved.aiProviders : defaultPlatformSettings.aiProviders,
  };
}

export function savePlatformSettings(actorId: string, input: PlatformSettings) {
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
    rechargePackages: input.rechargePackages.slice(0, 12).map((item, index) => ({
      id: String(item.id || `package-${index + 1}`).trim().slice(0, 40),
      name: String(item.name || "积分包").trim().slice(0, 30),
      points: Math.max(1, Math.floor(Number(item.points) || 1)),
      bonus: Math.max(0, Math.floor(Number(item.bonus) || 0)),
      priceYuan: Math.max(0.01, Number(Number(item.priceYuan || 0.01).toFixed(2))),
      enabled: Boolean(item.enabled),
    })),
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

export function pointCost(action: PointRule["action"], fallback: number) {
  const rule = getPlatformSettings().pointRules.find((item) => item.action === action);
  return rule?.enabled === false ? 0 : Math.max(0, Number(rule?.points ?? fallback));
}
