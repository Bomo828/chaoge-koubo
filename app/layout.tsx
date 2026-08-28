import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

const publicOrigin = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://studio.chaogeai.top";
const title = "爆点实验室｜AI 新媒体创作平台";
const description = "把灵感放大到屏幕之外：AI 图片、动态视频、声音与创作资产一站式完成。";

export const metadata: Metadata = {
  metadataBase: new URL(publicOrigin),
  title: { default: title, template: "%s｜爆点实验室" },
  description,
  openGraph: {
    type: "website",
    locale: "zh_CN",
    title,
    description,
    siteName: "爆点实验室",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "爆点实验室——把灵感放大到屏幕之外" }],
  },
  twitter: { card: "summary_large_image", title, description, images: ["/og.png"] },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
