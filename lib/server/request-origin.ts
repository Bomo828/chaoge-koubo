export function externalRequestUrl(request: Request, path: string) {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host")?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const requestUrl = new URL(request.url);
  const protocol = forwardedProto || requestUrl.protocol.replace(":", "") || "http";
  const origin = host ? `${protocol}://${host}` : requestUrl.origin;
  return new URL(path, origin);
}

export function isExternalHttps(request: Request) {
  return externalRequestUrl(request, "/").protocol === "https:";
}
