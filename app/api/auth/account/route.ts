import { NextResponse } from "next/server";
import { MEMBER_COOKIE } from "../../../member-session";
import { authenticateUser, createSession, SESSION_MAX_AGE } from "../../../../lib/server/auth";
import { externalRequestUrl, isExternalHttps } from "../../../../lib/server/request-origin";

export const runtime = "nodejs";

function safePath(value: FormDataEntryValue | null) {
  const path = typeof value === "string" ? value : "/studio";
  return path.startsWith("/") && !path.startsWith("//") ? path : "/studio";
}

function errorResponse(request: Request, code: string, returnTo: string) {
  const url = externalRequestUrl(request, "/");
  url.searchParams.set("auth", "login");
  url.searchParams.set("error", code);
  url.searchParams.set("return_to", returnTo);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: Request) {
  const form = await request.formData();
  if (form.get("mode") === "register") {
    return errorResponse(request, "registration_closed", safePath(form.get("returnTo")));
  }
  const username = String(form.get("username") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const returnTo = safePath(form.get("returnTo"));

  if (username.length < 3) return errorResponse(request, "username", returnTo);
  if (password.length < 6) return errorResponse(request, "password", returnTo);

  const user = authenticateUser(username, password);
  if (!user) return errorResponse(request, "invalid", returnTo);

  const response = NextResponse.redirect(externalRequestUrl(request, returnTo), 303);
  response.cookies.set(MEMBER_COOKIE, createSession(user.id), {
    httpOnly: true,
    sameSite: "lax",
    secure: isExternalHttps(request),
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return response;
}
