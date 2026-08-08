import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim();
  const requestHost = (forwardedHost || requestHeaders.get("host") || "merchant-studio-chaoge.bomoliu.chatgpt.site")
    .replace(/[^a-zA-Z0-9.:-]/g, "");
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https"
    ? forwardedProtocol
    : requestHost.startsWith("localhost") || requestHost.startsWith("127.0.0.1")
      ? "http"
      : "https";
  const previewImage = `${protocol}://${requestHost}/og.png`;
  const title = "爆点实验室｜AI 新媒体创作平台";
  const description = "把灵感放大到屏幕之外：AI 图片、动态视频、声音与创作资产一站式完成。";

  return {
    title: { default: title, template: "%s｜爆点实验室" },
    description,
    openGraph: {
      type: "website",
      locale: "zh_CN",
      title,
      description,
      siteName: "爆点实验室",
      images: [{ url: previewImage, width: 1200, height: 630, alt: "爆点实验室——把灵感放大到屏幕之外" }],
    },
    twitter: { card: "summary_large_image", title, description, images: [previewImage] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
