import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "爆点实验室｜AI 新媒体创作平台",
    template: "%s｜爆点实验室",
  },
  description: "图片设计、短视频制作、声音克隆与商家数字资产管理。",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
