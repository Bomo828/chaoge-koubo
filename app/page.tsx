import type { Metadata } from "next";
import { SiteClient } from "./site-client";
import { getMemberSession } from "./member-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "爆点实验室｜AI 新媒体创作平台",
  description: "面向新媒体创作者的 AI 图片、视频、声音与内容资产工作台。",
};

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const member = await getMemberSession();
  const params = await searchParams;
  const auth = Array.isArray(params.auth) ? params.auth[0] : params.auth;
  const returnToValue = Array.isArray(params.return_to) ? params.return_to[0] : params.return_to;
  const initialAuthMode = auth === "register" || auth === "login" ? auth : null;
  const initialReturnTo = returnToValue?.startsWith("/") && !returnToValue.startsWith("//")
    ? returnToValue
    : "/studio";

  return (
    <SiteClient
      member={member}
      initialAuthMode={initialAuthMode}
      initialReturnTo={initialReturnTo}
    />
  );
}
