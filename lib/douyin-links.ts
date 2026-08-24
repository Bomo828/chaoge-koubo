const DOUYIN_TRAILING_PUNCTUATION = /[\u200b-\u200d\ufeff，,。；;！!？?：:）)】\]}》〉」』”’'"`]+$/u;

export function isDouyinHostname(hostname: string) {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  return host === "douyin.com"
    || host.endsWith(".douyin.com")
    || host === "iesdouyin.com"
    || host.endsWith(".iesdouyin.com");
}

export function extractDouyinUrl(value: string) {
  const normalized = value.normalize("NFKC").replace(/[\u200b-\u200d\ufeff]/g, " ").trim();
  const candidates = normalized.match(/https?:\/\/[^\s<>]+/giu) || [];

  for (const candidate of candidates.length ? candidates : [normalized]) {
    const cleaned = candidate.replace(DOUYIN_TRAILING_PUNCTUATION, "");
    try {
      const parsed = new URL(cleaned);
      if (isDouyinHostname(parsed.hostname)) return parsed.toString();
    } catch {
      // Continue scanning the remaining text. A full share message can include
      // unrelated text before or after the actual Douyin URL.
    }
  }

  return "";
}

export function douyinSecUidFromUrl(sourceUrl: string) {
  const parsed = new URL(sourceUrl);
  const pathMatch = parsed.pathname.match(/\/(?:user|share\/user)\/([^/?]+)/i);
  return (pathMatch?.[1] || parsed.searchParams.get("sec_uid") || parsed.searchParams.get("sec_user_id") || "").slice(0, 180);
}
