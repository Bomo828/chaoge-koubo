import { AiProviderError, lk888Fetch } from "./lk888";
import { pointsPerCredit } from "./ai-pricing";

type PriceOption = {
  param_name?: string;
  option_value?: string;
  price_multiplier?: number;
};

type ChannelGroup = {
  group_name?: string;
  is_active?: boolean;
  in_key_whitelist?: boolean;
  billing_method?: string;
  output_token_price?: number;
  success_rate_24h?: number;
  avg_response_seconds?: number;
  option_prices?: PriceOption[];
};

type PricingResponse = {
  available_for_this_key?: boolean;
  key_channel_strategy?: string;
  channel_groups?: ChannelGroup[];
};

export type SeedanceVersion = "Mini" | "快速" | "标准";

export type VideoPriceQuote = {
  model: "kwvideo-v2-ref";
  displayName: "Seedance 2.0 参考生视频";
  duration: number;
  resolution: "480p" | "720p";
  version: SeedanceVersion;
  aspectRatio: "9:16";
  billingMethod: string;
  channelGroup: string;
  outputTokenPrice: number;
  reservedPoints: number;
  pointsPerCredit: number;
  note: string;
};

const CACHE_MS = 60_000;
let pricingCache: { expiresAt: number; data: PricingResponse } | null = null;

async function currentPricing() {
  if (pricingCache && pricingCache.expiresAt > Date.now()) return pricingCache.data;
  const data = await lk888Fetch<PricingResponse>("/v1/skills/models/kwvideo-v2-ref/pricing?status=active", { cache: "no-store" });
  pricingCache = { expiresAt: Date.now() + CACHE_MS, data };
  return data;
}

function versionMultiplier(group: ChannelGroup, version: SeedanceVersion) {
  const option = (group.option_prices ?? []).find((item) => item.param_name === "version" && item.option_value === version);
  return Number(option?.price_multiplier ?? 1);
}

function resolutionMultiplier(group: ChannelGroup, resolution: "480p" | "720p") {
  const option = (group.option_prices ?? []).find((item) => item.param_name === "resolution" && item.option_value === resolution);
  return Number(option?.price_multiplier ?? 1);
}

export async function quoteMerchantVideo(input: { duration?: number; resolution?: string; version?: string }): Promise<VideoPriceQuote> {
  const duration = Math.max(4, Math.min(15, Math.floor(Number(input.duration) || 15)));
  const version: SeedanceVersion = input.version === "Mini" || input.version === "标准" ? input.version : "快速";
  const resolution: "480p" | "720p" = input.resolution === "480p" ? "480p" : "720p";
  const pricing = await currentPricing();
  if (pricing.available_for_this_key === false) throw new AiProviderError("当前 API Key 无权使用 Seedance 2.0。", 403);
  const groups = (pricing.channel_groups ?? [])
    .filter((group) => group.is_active && group.in_key_whitelist !== false && Number(group.output_token_price ?? 0) > 0)
    .sort((left, right) => {
      const strategy = pricing.key_channel_strategy || "价格优先";
      if (strategy.includes("成功率")) return Number(right.success_rate_24h ?? 0) - Number(left.success_rate_24h ?? 0);
      if (strategy.includes("速度")) return Number(left.avg_response_seconds ?? Infinity) - Number(right.avg_response_seconds ?? Infinity);
      return Number(left.output_token_price ?? Infinity) - Number(right.output_token_price ?? Infinity);
    });
  if (!groups.length) throw new AiProviderError("当前没有可用的 Seedance 2.0 视频通道。", 503);
  const selected = groups[0];

  // 平台按最终输出 token 结算，但提交前不会公开本次任务的精确输出 token。
  // 这里仅用于会员积分预授权；任务完成后一定按 task-status.cost 结算并退回差额。
  const reservePerSecond = 140;
  const reservedPoints = Math.ceil(
    duration
    * reservePerSecond
    * versionMultiplier(selected, version)
    * resolutionMultiplier(selected, resolution),
  );

  return {
    model: "kwvideo-v2-ref",
    displayName: "Seedance 2.0 参考生视频",
    duration,
    resolution,
    version,
    aspectRatio: "9:16",
    billingMethod: selected.billing_method || "按token",
    channelGroup: selected.group_name || "自动选择",
    outputTokenPrice: Number(selected.output_token_price ?? 0),
    reservedPoints,
    pointsPerCredit: pointsPerCredit(),
    note: "Seedance 2.0 按最终输出 Token 结算。提交时只预授权积分上限，任务完成后按实际 cost 扣除，多余积分自动退回。",
  };
}
