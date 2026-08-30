import { AiProviderError, lk888Fetch } from "./lk888";
import { IMAGE_MODEL } from "./image-model";

type PriceOption = {
  param_name?: string;
  option_value?: string;
  price_multiplier?: number;
  price_addition?: number;
};

type ChannelGroup = {
  group_name?: string;
  is_active?: boolean;
  in_key_whitelist?: boolean;
  billing_method?: string;
  base_price?: number;
  success_rate_24h?: number;
  avg_response_seconds?: number;
  option_prices?: PriceOption[];
};

type PricingResponse = {
  available_for_this_key?: boolean;
  key_channel_strategy?: string;
  channel_groups?: ChannelGroup[];
};

type ProviderBalance = {
  balance?: number;
  unit?: string;
};

export type ImagePriceQuote = {
  model: string;
  size: string;
  quality: string;
  count: number;
  referenceCount: number;
  generationMode: "text-to-image" | "image-to-image";
  billingMethod: string;
  channelStrategy: string;
  channelGroup: string;
  unitProviderCost: number;
  estimatedProviderCost: number;
  pointsPerCredit: number;
  estimatedPoints: number;
  referenceImageSurcharge: number;
  note: string;
};

const DEFAULT_POINTS_PER_CREDIT = 100;
const CACHE_MS = 60_000;
let pricingCache: { expiresAt: number; data: PricingResponse } | null = null;

export function pointsPerCredit() {
  const configured = Number(process.env.AI_POINTS_PER_CREDIT);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_POINTS_PER_CREDIT;
}

export function providerCostToPoints(cost: number) {
  return Math.max(0, Math.ceil(Math.max(0, cost) * pointsPerCredit()));
}

export async function ensureProviderBalance(requiredProviderCost: number) {
  const balance = await lk888Fetch<ProviderBalance>("/v1/skills/balance", { cache: "no-store" });
  const available = Number(balance.balance ?? 0);
  if (!Number.isFinite(available) || available < requiredProviderCost) {
    throw new AiProviderError(`AI 平台算力不足，当前余额 ${Number.isFinite(available) ? available.toFixed(4) : "0"} 算力，本次预计需要 ${requiredProviderCost.toFixed(4)} 算力。`, 402);
  }
  return { balance: available, unit: balance.unit || "算力" };
}

async function currentPricing() {
  if (pricingCache && pricingCache.expiresAt > Date.now()) return pricingCache.data;
  const data = await lk888Fetch<PricingResponse>(`/v1/skills/models/${encodeURIComponent(IMAGE_MODEL)}/pricing?status=active`, { cache: "no-store" });
  pricingCache = { expiresAt: Date.now() + CACHE_MS, data };
  return data;
}

function optionAdjustedPrice(group: ChannelGroup, size: string, quality: string) {
  const base = Number(group.base_price ?? 0);
  const selected = (group.option_prices ?? []).filter((option) => (
    (option.param_name === "size" && option.option_value === size)
    || (option.param_name === "quality" && option.option_value === quality)
  ));
  const multiplier = selected.reduce((value, option) => value * Number(option.price_multiplier ?? 1), 1);
  const addition = selected.reduce((value, option) => value + Number(option.price_addition ?? 0), 0);
  return Math.max(0, base * multiplier + addition);
}

function chooseChannel(groups: ChannelGroup[], strategy: string, size: string, quality: string) {
  const candidates = groups
    .filter((group) => group.is_active && group.in_key_whitelist !== false)
    .map((group) => ({ group, price: optionAdjustedPrice(group, size, quality) }));
  if (!candidates.length) throw new Error(`当前 API Key 暂无可用的 ${IMAGE_MODEL} 渠道。`);

  if (strategy.includes("成功率")) {
    return candidates.sort((left, right) => Number(right.group.success_rate_24h ?? 0) - Number(left.group.success_rate_24h ?? 0))[0];
  }
  if (strategy.includes("速度")) {
    return candidates.sort((left, right) => Number(left.group.avg_response_seconds ?? Infinity) - Number(right.group.avg_response_seconds ?? Infinity))[0];
  }
  return candidates.sort((left, right) => left.price - right.price)[0];
}

export async function quoteImageModel(input: { size: string; quality?: string; count: number; referenceCount?: number }): Promise<ImagePriceQuote> {
  const size = input.size || "auto";
  const quality = input.quality || "auto";
  const count = Math.max(1, Math.min(4, Math.floor(input.count || 1)));
  const referenceCount = Math.max(0, Math.min(10, Math.floor(input.referenceCount || 0)));
  const pricing = await currentPricing();
  if (pricing.available_for_this_key === false) throw new Error(`当前 API Key 无权使用 ${IMAGE_MODEL}。`);
  const strategy = pricing.key_channel_strategy || "价格优先";
  const selected = chooseChannel(pricing.channel_groups ?? [], strategy, size, quality);
  const estimatedProviderCost = selected.price * count;
  const estimatedPoints = providerCostToPoints(estimatedProviderCost);

  return {
    model: IMAGE_MODEL,
    size,
    quality,
    count,
    referenceCount,
    generationMode: referenceCount > 0 ? "image-to-image" : "text-to-image",
    billingMethod: selected.group.billing_method || "按次",
    channelStrategy: strategy,
    channelGroup: selected.group.group_name || "自动选择",
    unitProviderCost: Number(selected.price.toFixed(6)),
    estimatedProviderCost: Number(estimatedProviderCost.toFixed(6)),
    pointsPerCredit: pointsPerCredit(),
    estimatedPoints,
    referenceImageSurcharge: 0,
    note: referenceCount > 0
      ? "当前价格表未设置参考图片附加价；最终按任务完成后的实际 cost 结算。"
      : "最终按任务完成后的实际 cost 结算。",
  };
}
