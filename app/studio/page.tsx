import type { Metadata } from "next";
import { StudioClient } from "./studio-client";
import "./studio.css";
import { requireMemberSession } from "../member-session";
import { getPlatformSettings } from "../../lib/server/platform-settings";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "创作工作台｜爆点实验室" };

export default async function StudioPage() {
  const member = await requireMemberSession("/studio");
  return <StudioClient member={member} initialFeatures={getPlatformSettings().features} />;
}
