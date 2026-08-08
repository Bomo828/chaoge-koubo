import { NextResponse } from "next/server";
import { MEMBER_COOKIE } from "../../../member-session";
import { authenticateUser, createSession, SESSION_MAX_AGE } from "../../../../lib/server/auth";
import { externalRequestUrl, isExternalHttps } from "../../../../lib/server/request-origin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("return_to") ?? "/";
  const safeReturnTo = returnTo.startsWith("/") && !returnTo.startsWith("//")
    ? returnTo
    : "/";
  const response = NextResponse.redirect(externalRequestUrl(request, safeReturnTo), 303);
  const user = authenticateUser(process.env.DEMO_USERNAME?.trim() || "demo", process.env.DEMO_PASSWORD || "123456");
  if (!user) return NextResponse.redirect(externalRequestUrl(request, "/?auth=login&error=invalid"), 303);

  response.cookies.set(MEMBER_COOKIE, createSession(user.id), {
    httpOnly: true,
    sameSite: "lax",
    secure: isExternalHttps(request),
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });

  return response;
}
