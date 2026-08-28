import type { Metadata } from "next";
import { SiteClient } from "./site-client";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "爆点实验室｜AI 新媒体创作平台",
  description: "面向新媒体创作者的 AI 图片、视频、声音与内容资产工作台。",
};

export default function Home() {
  return <SiteClient member={null} />;
}
