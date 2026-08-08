import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getUserBySessionToken, isAdmin, SESSION_COOKIE, type UserRole } from "../lib/server/auth";

export const MEMBER_COOKIE = SESSION_COOKIE;

export type MemberSession = {
  id: string;
  username: string;
  displayName: string;
  level: string;
  points: number;
  role: UserRole;
};

export async function getMemberSession(): Promise<MemberSession | null> {
  const cookieStore = await cookies();
  const user = getUserBySessionToken(cookieStore.get(MEMBER_COOKIE)?.value);
  return user ? {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    level: user.level,
    points: user.points,
    role: user.role,
  } : null;
}

export async function requireMemberSession(
  returnTo: string,
): Promise<MemberSession> {
  const member = await getMemberSession();
  if (member) return member;

  const safeReturnTo = returnTo.startsWith("/") && !returnTo.startsWith("//")
    ? returnTo
    : "/";
  redirect(`/login?return_to=${encodeURIComponent(safeReturnTo)}`);
}

export async function requireAdminSession(returnTo = "/admin") {
  const member = await getMemberSession();
  if (isAdmin(member)) return member;
  if (!member) redirect(`/login?return_to=${encodeURIComponent(returnTo)}`);
  redirect("/studio");
}
