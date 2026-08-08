import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { MEMBER_COOKIE } from "../../../member-session";
import { revokeSession } from "../../../../lib/server/auth";
import { externalRequestUrl, isExternalHttps } from "../../../../lib/server/request-origin";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const cookieStore = await cookies();
  revokeSession(cookieStore.get(MEMBER_COOKIE)?.value);
  const response = NextResponse.redirect(externalRequestUrl(request, "/"), 303);
  response.cookies.set(MEMBER_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: isExternalHttps(request),
    path: "/",
    maxAge: 0,
  });
  return response;
}
