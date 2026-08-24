import { NextResponse } from "next/server";
import { MEMBER_COOKIE } from "../../../member-session";
import { authenticateUser, createSession, SESSION_MAX_AGE } from "../../../../lib/server/auth";
import { InvitationError, registerWithInvitation } from "../../../../lib/server/invitations";
import { externalRequestUrl, isExternalHttps } from "../../../../lib/server/request-origin";

export const runtime = "nodejs";

function safePath(value: FormDataEntryValue | null) {
  const path = typeof value === "string" ? value : "/studio";
  return path.startsWith("/") && !path.startsWith("//") ? path : "/studio";
}

const registrationAttempts = new Map<string, number[]>();
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_REGISTRATION_FAILURES = 10;

function requestIp(request: Request) {
  return (request.headers.get("x-forwarded-for")?.split(",")[0] || request.headers.get("x-real-ip") || "local").trim();
}

function isRegistrationBlocked(ip: string) {
  const cutoff = Date.now() - ATTEMPT_WINDOW_MS;
  const attempts = (registrationAttempts.get(ip) || []).filter((value) => value > cutoff);
  registrationAttempts.set(ip, attempts);
  return attempts.length >= MAX_REGISTRATION_FAILURES;
}

function recordRegistrationFailure(ip: string) {
  registrationAttempts.set(ip, [...(registrationAttempts.get(ip) || []), Date.now()]);
}

function errorResponse(request: Request, code: string, returnTo: string, mode: "login" | "register" = "login") {
  const url = externalRequestUrl(request, "/");
  url.searchParams.set("auth", mode);
  url.searchParams.set("error", code);
  url.searchParams.set("return_to", returnTo);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: Request) {
  const form = await request.formData();
  if (form.get("mode") === "register") {
    const returnTo = safePath(form.get("returnTo"));
    const ip = requestIp(request);
    if (isRegistrationBlocked(ip)) return errorResponse(request, "rate_limited", returnTo, "register");
    const invitationCode = String(form.get("invitationCode") ?? "").trim();
    const username = String(form.get("username") ?? "").trim();
    const displayName = String(form.get("displayName") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const confirmPassword = String(form.get("confirmPassword") ?? "");
    if (!invitationCode) return errorResponse(request, "invite_required", returnTo, "register");
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) return errorResponse(request, "username", returnTo, "register");
    if (!displayName || displayName.length > 40) return errorResponse(request, "display_name", returnTo, "register");
    if (password.length < 8 || password.length > 72 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      return errorResponse(request, "password_strength", returnTo, "register");
    }
    if (password !== confirmPassword) return errorResponse(request, "password_mismatch", returnTo, "register");
    try {
      const user = registerWithInvitation({ invitationCode, username, displayName, password, registrationIp: ip });
      registrationAttempts.delete(ip);
      const response = NextResponse.redirect(externalRequestUrl(request, returnTo), 303);
      response.cookies.set(MEMBER_COOKIE, createSession(user.id), {
        httpOnly: true,
        sameSite: "lax",
        secure: isExternalHttps(request),
        path: "/",
        maxAge: SESSION_MAX_AGE,
      });
      return response;
    } catch (error) {
      recordRegistrationFailure(ip);
      const code = error instanceof InvitationError ? error.code : "registration_failed";
      return errorResponse(request, code, returnTo, "register");
    }
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
