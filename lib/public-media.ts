const publicMediaCdnBaseUrl = (process.env.NEXT_PUBLIC_MEDIA_CDN_BASE_URL || "")
  .trim()
  .replace(/\/+$/, "");

const publicMediaPrefixes = ["/media/", "/template-covers/"];

export const publicMediaCdnEnabled = Boolean(publicMediaCdnBaseUrl);

export function publicMediaUrl(value: string | undefined) {
  if (!value || !publicMediaCdnBaseUrl) return value || "";
  if (!publicMediaPrefixes.some((prefix) => value.startsWith(prefix))) return value;
  return `${publicMediaCdnBaseUrl}${value}`;
}
