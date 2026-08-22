"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { CaretRight, ChartLineUp, FolderOpen, House, ImageSquare, Plus, UserCircle, VideoCamera } from "@phosphor-icons/react";
import type { MemberSession } from "../member-session";
import type { PlatformFeature } from "../../lib/server/platform-settings";
import { CHANJING_VOICE_CLONE_POINTS, lipSyncPoints } from "../../lib/chanjing-pricing";
import { segmentViralCaptions, viralSpeechLanguage } from "../../lib/viral-caption-segmentation";
import { IndustryImageLab } from "./image-lab";
import { MarketDynamics } from "./market-dynamics";
import { browserFfmpegLoadConfig } from "../../lib/browser-ffmpeg";
import { AiDirectorStudio } from "./ai-director-studio";
import { AiAssistant } from "./ai-assistant";

type ImagePriceQuote = {
  estimatedPoints: number;
  estimatedProviderCost: number;
  unitProviderCost: number;
  generationMode: "text-to-image" | "image-to-image";
  referenceImageSurcharge: number;
  note: string;
};

function useImagePriceQuote(size: string, quality: string, count: number, referenceCount: number) {
  const [quote, setQuote] = useState<ImagePriceQuote | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ size, quality, count: String(count), references: String(referenceCount) });
    fetch(`/api/ai/pricing?${params}`, { cache: "no-store", signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("price unavailable")))
      .then((data: { quote?: ImagePriceQuote }) => setQuote(data.quote ?? null))
      .catch((error: unknown) => { if (!(error instanceof DOMException && error.name === "AbortError")) setQuote(null); });
    return () => controller.abort();
  }, [count, quality, referenceCount, size]);
  return quote;
}

type MemberAssetItem = {
  id: string;
  projectName: string;
  kind: "image" | "video" | "audio" | "voice";
  name: string;
  contentType: string;
  sizeBytes: number;
  sourceTaskId: string | null;
  createdAt: number;
  expiresAt: number | null;
  retentionDays: number | null;
  mediaUrl: string;
  coverUrl?: string;
};

type WalletHistoryEntry = {
  id: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  taskId: string | null;
  createdAt: number;
};

type WalletHistory = {
  consumption: WalletHistoryEntry[];
  recharge: WalletHistoryEntry[];
};

type AssetFilter = "all" | "image" | "video" | "audio";

type ClonedVoice = {
  voiceId: string;
  name: string;
  language: "cn" | "en";
  demoAudio: string;
  createdAt?: number;
};

type CommonVoice = {
  voiceId: string;
  name: string;
  auditionUrl: string;
  gender: string;
  language: string;
};

const VOICE_AUDITION_TEXT = "我是您的克隆声音，我可以说很多的话。";
const VOICE_AUDITION_TEXT_EN = "Hello, this is my cloned voice. I can speak English naturally.";

type ViralCaption = {
  start: number;
  end: number;
  text: string;
};

function viralTimestamp(value: number) {
  const seconds = Math.max(0, Number.isFinite(value) ? value : 0);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(2).padStart(5, "0")}`;
}

function normalizeViralCaptionsForReview(captions: ViralCaption[]) {
  // The transcription worker already returns AI-corrected short phrases with
  // precise Tencent ASR timestamps. Keep that detailed timeline intact for
  // review instead of merging several phrases into long paragraphs.
  return segmentViralCaptions(captions
    .map((caption) => ({
      start: Math.max(0, caption.start),
      end: Math.max(caption.start + 0.04, caption.end),
      text: caption.text.trim().replace(/[。！？!?…]+$/g, ""),
    }))
    .filter((caption) => caption.text));
}

function viralTitleFromKnownScript(value: string) {
  const firstSentence = value.trim().split(/[。！？!?\n]/, 1)[0]?.replace(/\s+/g, "") || "";
  return firstSentence.slice(0, 16) || "口播重点";
}

type ViralWorkerJob = {
  id: string;
  state: "queued" | "running" | "success" | "failed";
  stage: string;
  progress: number;
  message: string;
  title?: string;
  title_source?: string;
  transcript?: string;
  captions?: ViralCaption[];
  analysis_mode?: string;
  analysis_summary?: string;
  result_url?: string;
  cover_url?: string;
  error?: string;
  benchmark_title?: string;
  benchmark_author?: string;
  benchmark_source_url?: string;
  word_count?: number;
  scene_changes?: number[];
  transition_points?: number[];
  output_width?: number;
  output_height?: number;
  metadata?: {
    duration?: number;
    width?: number;
    height?: number;
  };
  renderer?: string;
  timeline_version?: number;
  template_profile?: {
    name?: string;
    version?: number;
  };
};

type ViralTemplateSpec = {
  id: string;
  name: string;
  previewUrl: string;
  coverUrl?: string;
  accent: string;
  titleColor: string;
  panel: string;
  align: CanvasTextAlign;
  titleEffect: string;
  subtitleEffect: string;
  transition: "fade" | "flash" | "zoom" | "slide" | "hard-cut-punch";
  transitionLabel: string;
  sfx: "soft" | "click" | "bright" | "impact" | "wood";
  sfxLabel: string;
  overlay?: "outline" | "panel";
  titleTiming?: "persistent" | "opening";
  effectCadence?: "opening" | "periodic" | "rhythm";
  version?: number;
  updatedAt?: number;
  source?: string;
  description?: string;
};

const TEMPLATE_LIBRARY_UPDATE_KEY = "merchant-studio:template-library-updated";

function revisionedTemplateMediaUrl(value: string | undefined, updatedAt?: number) {
  if (!value) return "";
  if (!updatedAt || !value.startsWith("/")) return value;
  const separator = value.includes("?") ? "&" : "?";
  return `${value}${separator}template_updated_at=${encodeURIComponent(String(updatedAt))}`;
}

const VIRAL_TEMPLATES: ViralTemplateSpec[] = [
  { id: "template-9", name: "红白双语", previewUrl: "", coverUrl: "/template-covers/template-9.jpg", accent: "#9f2538", titleColor: "#fffdf9", panel: "transparent", align: "center", titleEffect: "红白双排常驻标题", subtitleEffect: "红白双语字幕 · 关键词语义强调", transition: "fade", transitionLabel: "语义节点触发编辑式切换", sfx: "soft", sfxLabel: "模板9独占语义音效池", overlay: "outline", titleTiming: "persistent", effectCadence: "rhythm", version: 22 },
  { id: "template-10", name: "黄白大字双语", previewUrl: "", coverUrl: "/template-covers/template-10.jpg", accent: "#fff300", titleColor: "#fffdf8", panel: "transparent", align: "center", titleEffect: "黄白大字双排手书标题", subtitleEffect: "黄白双语字幕 · 语义大字强调", transition: "slide", transitionLabel: "语义停顿触发轻切与景别变化", sfx: "impact", sfxLabel: "模板10独占语义音效池", overlay: "outline", titleTiming: "opening", effectCadence: "rhythm", version: 11 },
  { id: "template-11", name: "青白高亮双语", previewUrl: "", coverUrl: "/template-covers/template-11.jpg", accent: "#79f4e4", titleColor: "#ffffff", panel: "transparent", align: "left", titleEffect: "青白高亮常驻标题", subtitleEffect: "逐字双语字幕 · 青色关键词放大", transition: "zoom", transitionLabel: "语义节点触发克制景别切换", sfx: "click", sfxLabel: "模板11独占语义音效池", overlay: "outline", titleTiming: "persistent", effectCadence: "rhythm", version: 13 },
  { id: "template-12", name: "黑黄聚焦双语", previewUrl: "", coverUrl: "/template-covers/template-12.jpg", accent: "#fff000", titleColor: "#ffffff", panel: "rgba(5,5,5,.82)", align: "center", titleEffect: "黑底黄白双排常驻标题", subtitleEffect: "黑黄双语字幕 · 单次语义聚焦", transition: "zoom", transitionLabel: "语义节点景别切换与柔边聚焦", sfx: "bright", sfxLabel: "模板12独占语义音效池", overlay: "panel", titleTiming: "persistent", effectCadence: "rhythm", version: 12 },
];

function viralTemplateById(id: string, templates: ViralTemplateSpec[] = VIRAL_TEMPLATES) {
  return templates.find((template) => template.id === id) ?? templates[0] ?? VIRAL_TEMPLATES[0];
}

function videoWorkerBaseUrl() {
  if (typeof window === "undefined") return "";
  // Always use the same-origin relay. The cloud worker intentionally does not
  // expose browser CORS headers, so a localhost page cannot call it directly.
  // Production nginx can still intercept /video-worker before it reaches Next.
  return `${window.location.origin}/video-worker`;
}

function resolveVideoWorkerUrl(path: string) {
  if (/^https?:\/\//i.test(path)) return path;
  const baseUrl = videoWorkerBaseUrl();
  return path.startsWith("/") ? `${baseUrl}${path}` : new URL(path, `${baseUrl}/`).toString();
}

function stableAssetId(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `asset_${(hash >>> 0).toString(36)}_${value.length.toString(36)}`;
}

async function archiveGeneratedAssets(input: { projectName: string; kind: "image" | "video" | "audio"; urls: string[]; taskIds?: string[]; createdAt?: number; namePrefix?: string }) {
  const createdAt = input.createdAt || Date.now();
  const saved = await Promise.allSettled(input.urls.map((sourceUrl, index) => fetch("/api/member/assets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: stableAssetId(`${input.projectName}|${input.taskIds?.[index] || sourceUrl}`),
      projectName: input.projectName,
      kind: input.kind,
      name: `${input.namePrefix || (input.kind === "video" ? "生成短视频" : "生成图片")} ${index + 1}`,
      sourceUrl,
      sourceTaskId: input.taskIds?.[index] || null,
      createdAt,
    }),
  })));
  if (saved.some((result) => result.status === "fulfilled" && result.value.ok)) window.dispatchEvent(new CustomEvent("member-assets-updated"));
}

function triggerDownload(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

async function blobToAiReferenceDataUrl(source: Blob) {
  try {
    const bitmap = await createImageBitmap(source);
    const maxEdge = 1280;
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("图片压缩失败");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL("image/jpeg", 0.78);
  } catch {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("图片读取失败"));
      reader.onerror = () => reject(new Error("图片读取失败"));
      reader.readAsDataURL(source);
    });
  }
}

async function optimizeAiReferenceUrl(url: string) {
  if (!/^data:image\//i.test(url) || url.length < 500_000) return url;
  try {
    const response = await fetch(url);
    if (!response.ok) return url;
    return blobToAiReferenceDataUrl(await response.blob());
  } catch {
    return url;
  }
}

async function downloadImageUrl(url: string, filename: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error("download failed");
    triggerDownload(await response.blob(), filename);
  } catch {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.target = "_blank";
    link.rel = "noreferrer";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
}

function designDimensions(spec: string) {
  if (spec === "grid-9") return { width: 3240, height: 3240, tiles: 9 };
  if (spec === "grid-4") return { width: 2160, height: 2160, tiles: 4 };
  if (spec.includes("9-16")) return { width: 1080, height: 1920, tiles: 1 };
  if (spec.includes("16-9")) return { width: 1080, height: 608, tiles: 1 };
  if (spec.includes("3-4")) return { width: 1080, height: 1440, tiles: 1 };
  if (spec === "material-a4") return { width: 2480, height: 3508, tiles: 1 };
  if (spec === "material-a3") return { width: 3508, height: 4961, tiles: 1 };
  return { width: 1080, height: 1080, tiles: 1 };
}

type DesignModeId = "marketing" | "moments" | "material" | "custom";

function drawDownloadArtwork(mode: DesignModeId, candidate: number, spec: string, industry: string) {
  const { width, height } = designDimensions(spec);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器无法生成下载图片。");

  const palettes = [
    ["#071a11", "#173d2f", "#a77435", "#f7e5b7"],
    ["#2a130d", "#75442d", "#d58c51", "#fff0d0"],
    ["#0d252d", "#244a54", "#8ba089", "#f1e3ae"],
  ];
  const palette = palettes[(candidate - 1) % palettes.length];
  const background = context.createLinearGradient(0, 0, width, height);
  if (mode === "moments") {
    background.addColorStop(0, candidate === 2 ? "#f8e7d8" : "#f6eee2");
    background.addColorStop(.55, candidate === 3 ? "#d6dfd3" : "#edbd94");
    background.addColorStop(1, candidate === 2 ? "#b46d45" : "#1d513d");
  } else if (mode === "material") {
    background.addColorStop(0, "#f4ead4");
    background.addColorStop(.65, "#f9f8f2");
    background.addColorStop(1, "#dce8df");
  } else {
    background.addColorStop(0, palette[0]);
    background.addColorStop(.6, palette[1]);
    background.addColorStop(1, palette[2]);
  }
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  const glow = context.createRadialGradient(width * .68, height * .3, 0, width * .68, height * .3, Math.max(width, height) * .55);
  glow.addColorStop(0, mode === "moments" ? "rgba(255,235,201,.78)" : "rgba(239,193,112,.72)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);

  const margin = Math.round(width * .08);
  const lightText = mode !== "moments" && mode !== "material";
  context.fillStyle = lightText ? palette[3] : "#3f3428";
  context.font = `600 ${Math.max(28, Math.round(width * .028))}px sans-serif`;
  context.fillText(industry, margin, margin * 1.1);
  context.font = `900 ${Math.max(68, Math.round(width * .09))}px "Songti SC", serif`;
  const title = mode === "material" ? ["夏日上新", "到店有礼"] : mode === "moments" ? ["这一口新鲜", "值得分享"] : ["夏日新味", "鲜香上市"];
  context.fillText(title[0], margin, height * .43);
  context.fillText(title[1], margin, height * .43 + Math.round(width * .12));
  context.font = `500 ${Math.max(24, Math.round(width * .025))}px sans-serif`;
  context.globalAlpha = .8;
  context.fillText(mode === "material" ? "扫码了解活动" : mode === "moments" ? "到店体验 · 分享美好" : "品牌门店 · 限时推荐", margin, height - margin);
  context.globalAlpha = 1;

  if (mode === "material") {
    const qrSize = Math.round(width * .18);
    context.fillStyle = "#fff";
    context.fillRect(width - margin - qrSize, height - margin - qrSize, qrSize, qrSize);
    context.strokeStyle = "#173d2f";
    context.lineWidth = Math.max(8, Math.round(width * .006));
    context.setLineDash([context.lineWidth, context.lineWidth]);
    context.strokeRect(width - margin - qrSize, height - margin - qrSize, qrSize, qrSize);
    context.setLineDash([]);
  }
  return canvas;
}

function canvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片导出失败。")), "image/png", 1));
}

async function generatedImageCanvas(url: string, width: number, height: number) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("生成图片读取失败，请稍后重试。");
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("当前浏览器无法处理生成图片。");
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas;
}

async function overlayQrCode(canvas: HTMLCanvasElement, qrUrl: string) {
  const response = await fetch(qrUrl);
  if (!response.ok) throw new Error("门店二维码读取失败，请重新上传。");
  const qrBitmap = await createImageBitmap(await response.blob());
  const context = canvas.getContext("2d");
  if (!context) {
    qrBitmap.close();
    throw new Error("当前浏览器无法合成门店二维码。");
  }
  const qrSize = Math.round(canvas.width * .2);
  const quietZone = Math.max(18, Math.round(qrSize * .1));
  const edge = Math.max(32, Math.round(canvas.width * .055));
  const cardX = canvas.width - edge - qrSize - quietZone * 2;
  const cardY = canvas.height - edge - qrSize - quietZone * 2;
  context.save();
  context.fillStyle = "#fff";
  context.shadowColor = "rgba(18, 35, 27, .18)";
  context.shadowBlur = Math.max(12, Math.round(canvas.width * .012));
  context.fillRect(cardX, cardY, qrSize + quietZone * 2, qrSize + quietZone * 2);
  context.shadowColor = "transparent";
  context.imageSmoothingEnabled = false;
  context.drawImage(qrBitmap, cardX + quietZone, cardY + quietZone, qrSize, qrSize);
  context.restore();
  qrBitmap.close();
  return canvas;
}

function writeUint16(target: Uint8Array, offset: number, value: number) {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint16(offset, value, true);
}

function writeUint32(target: Uint8Array, offset: number, value: number) {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(offset, value >>> 0, true);
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function createZip(files: Array<{ name: string; blob: Blob }>) {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = new Uint8Array(await file.blob.arrayBuffer());
    const checksum = crc32(data);
    const local = new Uint8Array(30 + name.length + data.length);
    writeUint32(local, 0, 0x04034b50);
    writeUint16(local, 4, 20);
    writeUint32(local, 14, checksum);
    writeUint32(local, 18, data.length);
    writeUint32(local, 22, data.length);
    writeUint16(local, 26, name.length);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + name.length);
    writeUint32(central, 0, 0x02014b50);
    writeUint16(central, 4, 20);
    writeUint16(central, 6, 20);
    writeUint32(central, 16, checksum);
    writeUint32(central, 20, data.length);
    writeUint32(central, 24, data.length);
    writeUint16(central, 28, name.length);
    writeUint32(central, 42, localOffset);
    central.set(name, 46);
    centralParts.push(central);
    localOffset += local.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  writeUint32(end, 0, 0x06054b50);
  writeUint16(end, 8, files.length);
  writeUint16(end, 10, files.length);
  writeUint32(end, 12, centralSize);
  writeUint32(end, 16, localOffset);
  const blobParts = [...localParts, ...centralParts, end].map((part) => part.slice().buffer as ArrayBuffer);
  return new Blob(blobParts, { type: "application/zip" });
}

const menu = [
  { id: "overview", icon: "⌂", label: "创作首页" },
  { id: "design", icon: "图", label: "图片创作" },
  { id: "video", icon: "视", label: "视频创作" },
  { id: "cases", icon: "动", label: "市场动态" },
  { id: "assets", icon: "资", label: "创作资产" },
  { id: "member", icon: "会", label: "账号中心" },
];

const menuIcons = {
  overview: House,
  design: ImageSquare,
  video: VideoCamera,
  cases: ChartLineUp,
  assets: FolderOpen,
  member: UserCircle,
};

const studioLabels: Record<string, string> = {
  overview: "创作首页",
  design: "图片创作",
  video: "视频创作",
  cases: "市场动态",
  assets: "创作资产",
  member: "账号中心",
};

const STUDIO_ACTIVE_SESSION_KEY = "merchant-studio-active-section";
const VIDEO_WORKSPACE_SESSION_KEY = "merchant-studio-video-workspace";

export function StudioClient({ member, initialFeatures }: { member: MemberSession; initialFeatures: PlatformFeature[] }) {
  const isAdminAccount = member.role === "admin" || member.role === "super_admin";
  const [active, setActive] = useState("overview");
  const [assetInitialFilter, setAssetInitialFilter] = useState<AssetFilter>("all");
  const [viralImportAsset, setViralImportAsset] = useState<{ id: string; name: string; mediaUrl: string; contentType?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [memberMenuOpen, setMemberMenuOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [accountDialog, setAccountDialog] = useState<"password" | null>(null);
  const [dialogMessage, setDialogMessage] = useState("");
  const [walletPoints, setWalletPoints] = useState(member.points);
  const memberMenuRef = useRef<HTMLDivElement>(null);
  const visibleMenu = initialFeatures.length
    ? [...initialFeatures].filter((item) => item.enabled).sort((left, right) => left.sortOrder - right.sortOrder).map((item) => ({ id: item.entry, icon: item.icon, label: item.name || studioLabels[item.entry] }))
    : menu;
  const configuredLabels = Object.fromEntries(
    initialFeatures.map((item) => [item.entry, item.name || studioLabels[item.entry]]),
  ) as Partial<Record<PlatformFeature["entry"], string>>;

  function openStudioSection(section: string) {
    try {
      window.sessionStorage.setItem(STUDIO_ACTIVE_SESSION_KEY, section);
    } catch {
      // The workspace still works when browser storage is unavailable.
    }
    setActive(section);
  }

  useEffect(() => {
    const requestedTool = new URLSearchParams(window.location.search).get("tool");
    if (requestedTool && Object.hasOwn(studioLabels, requestedTool)) {
      queueMicrotask(() => openStudioSection(requestedTool));
      return;
    }
    try {
      const savedSection = window.sessionStorage.getItem(STUDIO_ACTIVE_SESSION_KEY);
      if (savedSection && Object.hasOwn(studioLabels, savedSection)) {
        queueMicrotask(() => setActive(savedSection));
      }
    } catch {
      // Keep the default overview when browser storage is unavailable.
    }
  }, []);

  useEffect(() => {
    function closeMemberMenu(event: MouseEvent) {
      if (memberMenuRef.current && !memberMenuRef.current.contains(event.target as Node)) {
        setMemberMenuOpen(false);
      }
    }

    function closeWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMemberMenuOpen(false);
        setAccountDialog(null);
        setDialogMessage("");
      }
    }

    document.addEventListener("pointerdown", closeMemberMenu);
    document.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMemberMenu);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/member/wallet", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: { wallet?: { points?: number } }) => {
        if (active && typeof data.wallet?.points === "number") setWalletPoints(data.wallet.points);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  function demoAction() {
    setBusy(true);
    window.setTimeout(() => setBusy(false), 1100);
  }

  return (
    <main className={`studio-shell ${active === "design" ? "is-image-lab" : ""}`}>
      <aside className="studio-sidebar">
        <Link className="studio-brand" href="/" aria-label="爆点实验室首页"><span><img src="/media/flash-lab-logo.png" alt="" /></span><div><b>爆点实验室</b></div></Link>
        <nav>
          {visibleMenu.map((item, index) => {
            const MenuIcon = menuIcons[item.id as keyof typeof menuIcons] ?? House;
            return (
              <button className={active === item.id ? "active" : ""} key={`${item.id}-${index}`} onClick={() => {
                if (item.id === "assets") setAssetInitialFilter("all");
                openStudioSection(item.id);
              }}>
                <MenuIcon size={19} weight={active === item.id ? "fill" : "regular"} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-utility">
          <button type="button" className="sidebar-assistant" onClick={() => setAssistantOpen(true)}>
            <img src="/media/ai-assistant-avatar.svg" alt="" />
            <span><b>AI 助手</b><small>随时帮您创作</small></span>
            <CaretRight size={16} weight="bold" />
          </button>
          <div className="sidebar-wallet-row">
            <button type="button" className="sidebar-wallet-balance" onClick={() => openStudioSection("member")}>
              <span>创作积分</span><b>{walletPoints.toLocaleString()} <small>PTS</small></b>
            </button>
            <button type="button" className="sidebar-wallet-recharge" onClick={() => openStudioSection("member")}>
              <Plus size={14} weight="bold" /><span>充值</span>
            </button>
          </div>
        </div>
      </aside>

      <section className="studio-main">
        <header className="studio-topbar">
          <div className="member-menu" ref={memberMenuRef}>
            <button
              type="button"
              className="member-menu-trigger"
              aria-haspopup="menu"
              aria-expanded={memberMenuOpen}
              onClick={() => setMemberMenuOpen((open) => !open)}
            >
              <span className="member-menu-copy"><b>{member.displayName}</b></span>
              <i className={`member-chevron ${memberMenuOpen ? "is-open" : ""}`}>菜单</i>
            </button>
            {memberMenuOpen ? (
              <div className="member-dropdown" role="menu" aria-label="会员菜单">
                <div className="member-dropdown-head">
                  <b>{member.displayName}</b>
                  <span>{walletPoints.toLocaleString()} 积分可用</span>
                </div>
                <div className="member-dropdown-actions">
                  {isAdminAccount ? <a role="menuitem" href="/admin"><span><b>后台管理</b></span><i>›</i></a> : null}
                  <button type="button" role="menuitem" onClick={() => { setAccountDialog("password"); setDialogMessage(""); setMemberMenuOpen(false); }}><span><b>修改密码</b></span><i>›</i></button>
                </div>
                <a className="member-logout" role="menuitem" href="/api/auth/logout"><span>退出登录</span><i>↗</i></a>
              </div>
            ) : null}
          </div>
        </header>
        <div className="studio-content">
          {active === "overview" && <Overview onOpen={openStudioSection} />}
          {active === "design" && <IndustryImageLab onPointsChange={setWalletPoints} />}
          {active === "video" && <Video busy={busy} action={demoAction} onPointsChange={setWalletPoints} viralImportAsset={viralImportAsset} />}
          {active === "cases" && <MarketDynamics title={configuredLabels.cases || studioLabels.cases} />}
          {active === "assets" && <Assets initialFilter={assetInitialFilter} onUseViral={(asset) => {
            setViralImportAsset({ id: asset.id, name: asset.name, mediaUrl: asset.mediaUrl, contentType: asset.contentType });
            openStudioSection("video");
          }} />}
          {active === "member" && <Member
            points={walletPoints}
            onPointsChange={setWalletPoints}
            onOpenAssets={(filter) => {
              setAssetInitialFilter(filter);
              openStudioSection("assets");
            }}
          />}
        </div>
      </section>

      {accountDialog ? (
        <AccountDialog
          message={dialogMessage}
          onMessage={setDialogMessage}
          onClose={() => { setAccountDialog(null); setDialogMessage(""); }}
        />
      ) : null}
      <AiAssistant
        open={assistantOpen}
        memberName={member.displayName}
        onClose={() => setAssistantOpen(false)}
        onPointsChange={setWalletPoints}
      />
    </main>
  );
}

function AccountDialog({ message, onMessage, onClose }: { message: string; onMessage: (message: string) => void; onClose: () => void }) {
  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const currentPassword = String(form.get("currentPassword") ?? "");
    const nextPassword = String(form.get("nextPassword") ?? "");
    const confirmPassword = String(form.get("confirmPassword") ?? "");
    if (nextPassword.length < 8) return onMessage("新密码至少需要 8 个字符。");
    if (nextPassword !== confirmPassword) return onMessage("两次输入的新密码不一致。");
    onMessage("正在更新密码…");
    try {
      const response = await fetch("/api/member/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, nextPassword }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "密码修改失败。");
      onMessage("密码已更新，下次登录请使用新密码。");
      event.currentTarget.reset();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "密码修改失败，请稍后重试。");
    }
  }

  return (
    <div className="account-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="account-dialog" role="dialog" aria-modal="true" aria-labelledby="account-dialog-title">
        <button className="account-dialog-close" type="button" aria-label="关闭" onClick={onClose}>×</button>
        <form onSubmit={submitPassword}>
          <header className="account-dialog-header"><h2 id="account-dialog-title">修改密码</h2></header>
          <div className="account-form-grid is-single">
            <label><span>当前密码</span><input name="currentPassword" type="password" autoComplete="current-password" placeholder="输入当前密码" required /></label>
            <label><span>新密码</span><input name="nextPassword" type="password" autoComplete="new-password" placeholder="不少于 8 个字符" minLength={8} required /></label>
            <label><span>确认新密码</span><input name="confirmPassword" type="password" autoComplete="new-password" placeholder="再次输入新密码" minLength={8} required /></label>
          </div>
          {message ? <div className="account-dialog-message" role="status">{message}</div> : null}
          <footer className="account-dialog-footer"><button type="button" onClick={onClose}>取消</button><button className="account-dialog-submit" type="submit">确认修改</button></footer>
        </form>
      </section>
    </div>
  );
}

function Overview({ onOpen }: { onOpen: (id: string) => void }) {
  const [assets, setAssets] = useState<MemberAssetItem[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(true);
  const [assetsError, setAssetsError] = useState("");

  async function loadOverviewAssets() {
    setAssetsLoading(true);
    setAssetsError("");
    try {
      const response = await fetch("/api/member/assets", { cache: "no-store" });
      const data = await response.json() as { error?: string; items?: MemberAssetItem[] };
      if (!response.ok) throw new Error(data.error || "作品同步失败");
      setAssets(Array.isArray(data.items) ? data.items : []);
    } catch (error) {
      setAssetsError(error instanceof Error ? error.message : "作品同步失败");
    } finally {
      setAssetsLoading(false);
    }
  }

  useEffect(() => {
    queueMicrotask(() => void loadOverviewAssets());
    const refresh = () => void loadOverviewAssets();
    window.addEventListener("member-assets-updated", refresh);
    return () => window.removeEventListener("member-assets-updated", refresh);
  }, []);

  const recentProjects = Array.from(assets.reduce((projects, item) => {
    if (!projects.has(item.projectName)) projects.set(item.projectName, item);
    return projects;
  }, new Map<string, MemberAssetItem>()).values()).slice(0, 5);

  function kindLabel(kind: MemberAssetItem["kind"]) {
    return kind === "image" ? "生成图片" : kind === "video" ? "生成短视频" : kind === "voice" ? "克隆声音" : "口播音频";
  }

  const quickEntries = [
    { label: "社交海报", tone: "yellow", action: "design" },
    { label: "小绿书", tone: "cyan", action: "design" },
    { label: "对口型", tone: "pink", action: "video" },
    { label: "一键网感", tone: "yellow", action: "video" },
  ];

  return <div className="hyper-home">
    <section className="hyper-hero">
      <video
        className="hyper-hero-art"
        src="/media/flash-lab-hero-20260808.mp4"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        disablePictureInPicture
        aria-hidden="true"
      />
      <div className="hyper-hero-copy">
        <h1>把灵感<br /><span>放大</span></h1>
        <p>图片、视频、声音，一站式完成。</p>
      </div>
      <div className="hyper-main-actions">
        <button className="is-image" onClick={() => onOpen("design")}><span>图片创作</span></button>
        <button className="is-video" onClick={() => onOpen("video")}><span>视频创作</span></button>
      </div>
    </section>

    <section className="hyper-shortcuts" aria-label="快速创作">
      {quickEntries.map((entry) => <button className={`is-${entry.tone}`} key={entry.label} onClick={() => onOpen(entry.action)}><span>{entry.label}</span></button>)}
    </section>

    <section className="hyper-recent">
      <header><h2>最近项目</h2><button disabled={assetsLoading} onClick={() => void loadOverviewAssets()}>{assetsLoading ? "同步中" : "同步作品"}</button></header>
      <div className="hyper-project-grid">
        {recentProjects.length ? recentProjects.map((item, index) => <button className={`hyper-project-card tone-${index + 1}`} key={item.id} onClick={() => onOpen("assets")}>
          <span className="hyper-project-media">{item.kind === "image" ? <img src={item.mediaUrl} alt={item.projectName} /> : item.kind === "video" ? <video src={item.mediaUrl} preload="metadata" muted /> : <b>{item.kind === "voice" ? "VOICE" : "AUDIO"}</b>}</span>
          <strong>{item.projectName}</strong><em>{kindLabel(item.kind)} · {formatAssetTime(item.createdAt)}</em>
        </button>) : ["赛博广告", "潮流视频", "视觉海报", "网感短片", "内容实验"].map((name, index) => <button className={`hyper-project-card is-placeholder tone-${index + 1}`} key={name} onClick={() => onOpen(index % 2 ? "video" : "design")}><span className="hyper-project-media"><b>{String(index + 1).padStart(2,"0")}</b></span><strong>{name}</strong><em>{assetsError ? "等待同步" : "新建项目"}</em></button>)}
      </div>
    </section>
  </div>;
}

const designModes = [
  { id: "marketing", icon: "营", title: "营销海报", desc: "线上活动与团购推广", template: "餐饮美食", spec: "3:4", prompt: "突出夏季上新套餐，整体有老字号的品牌感，画面适合活动推广。", optimizedPrompt: "以夏季上新套餐为视觉主体，突出菜品的新鲜质感与老字号品牌底蕴；采用深绿色与鎏金色作为主色，画面简洁高级、主体清晰，并预留活动标题区域，适合线上活动与团购推广。" },
  { id: "moments", icon: "圈", title: "朋友圈海报", desc: "适合社交传播的竖版内容", template: "社交传播", spec: "3:4", prompt: "制作夏季新品朋友圈海报，突出新品卖点和到店理由，画面自然、有分享感。", optimizedPrompt: "制作一张适合朋友圈传播的夏季新品竖版海报，以真实菜品为视觉主体，突出新品卖点、门店特色和到店理由；文案简短醒目，画面自然有温度，保留品牌标识与活动信息区域。" },
  { id: "material", icon: "印", title: "门店物料", desc: "带二维码的线下打印海报", template: "线下物料", spec: "A4 竖版", prompt: "制作可供门店打印张贴的宣传海报，保留二维码位置，信息清晰醒目。", optimizedPrompt: "制作一张适合门店打印张贴的 A4 竖版宣传海报，突出核心活动、优惠信息与主推商品；强化远距离可读性，使用高对比层级，并在底部预留清晰的二维码与扫码提示区域。" },
  { id: "custom", icon: "书", title: "小绿书制作", desc: "3:4 笔记首图与发布文案", template: "内容种草", spec: "3:4", prompt: "围绕商家的真实商品、服务或门店体验，设计小绿书笔记发布时展示的第一张3:4竖版封面图。画面自然、有生活感，主体清晰，在信息流缩略图中也有吸引力，保留品牌识别与标题安全区，不虚构商家未提供的信息。", optimizedPrompt: "围绕商家的真实商品、服务或门店体验，设计小绿书笔记发布时展示的第一张3:4竖版封面图。画面自然、有生活感，主体清晰，在信息流缩略图中也有吸引力，保留品牌识别与标题安全区，不虚构商家未提供的信息。" },
] as const;

const designSpecOptions = {
  marketing: [
    { id: "poster-3-4", label: "1080×1440px · 3:4" },
    { id: "poster-1-1", label: "1080×1080px · 1:1" },
    { id: "poster-9-16", label: "1080×1920px · 9:16" },
  ],
  moments: [
    { id: "single-1-1", label: "单张 · 1080×1080px · 1:1" },
    { id: "single-3-4", label: "单张 · 1080×1440px · 3:4" },
    { id: "single-9-16", label: "单张 · 1080×1920px · 9:16" },
    { id: "single-16-9", label: "单张 · 1080×608px · 16:9" },
    { id: "grid-4", label: "4 张 · 2160×2160px 整图切割" },
    { id: "grid-9", label: "9 张 · 3240×3240px 无缝切割" },
  ],
  material: [
    { id: "material-a4", label: "A4 竖版 · 2480×3508px" },
    { id: "material-a3", label: "A3 竖版 · 3508×4961px" },
  ],
  custom: [
    { id: "single-3-4", label: "固定规格 · 1080×1440px · 3:4" },
  ],
} as const;

const materialTypes = [
  { id: "entrance-poster", label: "门店迎宾海报", scene: "放置在门店入口，突出品牌、核心服务与到店理由，引导顾客进店了解。" },
  { id: "table-card", label: "桌面立牌", scene: "放置在收银台或服务桌面，信息短而醒目，突出一个核心行动与扫码入口。" },
  { id: "xhs-checkin", label: "小绿书打卡卡", scene: "引导顾客拍照、打卡并分享真实体验，突出自然的参与方式与分享提示。" },
  { id: "review-card", label: "评价引导卡", scene: "服务完成后表达感谢并引导顾客进行真实评价，不诱导虚假好评。" },
  { id: "service-booking", label: "服务预约卡", scene: "展示可预约服务、预约方式与扫码入口，方便顾客再次预约或咨询。" },
] as const;

type MarketingChatMessage = { role: "assistant" | "user"; content: string };

function designAgentGreeting(mode: (typeof designModes)[number]) {
  return mode.id === "material"
    ? "我是你的门店物料设计策划师。我会结合本次填写的需求、参考图片和物料摆放场景，整理适合线下打印的方案。你可以选择迎宾海报、桌面立牌、小绿书打卡卡、评价引导卡或服务预约卡。先告诉我：最希望顾客看完后完成什么行动？二维码准备链接到哪里？"
    : mode.id === "custom"
    ? "我是你的小绿书内容策划师。我会结合本次填写的需求和参考图片，从选题、标题、正文、互动句到3:4笔记首图大纲，整理3套不同角度的种草图文。你可以继续让我重写或调整其中一套。先告诉我：这次最想分享哪项商品、服务或体验？希望读者看完后做什么？"
    : mode.id === "moments"
    ? "我是你的朋友圈海报策划师。我会结合本次填写的需求和参考图片整理传播方案，并同步写出3份不同角度的朋友圈文案。你也可以随时让我重写、调整语气或修改其中的卖点。先告诉我：这次想在朋友圈推广什么？最希望顾客看到后产生什么行动？"
    : "我是你的营销海报策划师。我会根据本次填写的需求整理海报方案。先告诉我：这次主要推广什么商品、服务或活动？最希望顾客记住什么？";
}

function MomentsFeedPreview({ merchantName, avatarUrl, caption, imageUrl, imageUrls = [], spec, onEnlarge }: { merchantName: string; avatarUrl: string; caption: string; imageUrl: string; imageUrls?: string[]; spec: string; onEnlarge: () => void }) {
  const tiles = spec === "grid-9" ? 9 : spec === "grid-4" ? 4 : 1;
  const columns = tiles === 9 ? 3 : tiles === 4 ? 2 : 1;
  const singleClass = spec === "single-9-16" ? "is-full" : spec === "single-16-9" ? "is-landscape" : spec === "single-3-4" ? "is-portrait" : "is-square";
  const primaryImage = imageUrl || imageUrls[0] || "";
  const useDirectGridImages = !imageUrl && imageUrls.length > 1;
  return <div className="moments-feed-card">
    <div className="moments-feed-head">
      {avatarUrl ? <img src={avatarUrl} alt={`${merchantName}头像`} /> : <i>{merchantName.slice(0, 1) || "商"}</i>}
      <div><b>{merchantName || "演示商家"}</b><p>{caption || "把喜欢的生活分享给你，欢迎到店体验。"}</p></div>
    </div>
    {tiles === 1
      ? <div className={`moments-feed-media is-single ${singleClass} ${primaryImage ? "" : "is-empty"}`} onDoubleClick={(event) => { event.stopPropagation(); if (primaryImage) onEnlarge(); }}>{primaryImage ? <img src={primaryImage} alt={`${merchantName}朋友圈图片`} /> : <span>上传参考图片后实时显示</span>}</div>
      : <div className={`moments-feed-media is-grid grid-${tiles}`} role="img" aria-label={`${merchantName}朋友圈${tiles}宫格图片`} onDoubleClick={(event) => { event.stopPropagation(); onEnlarge(); }}>{Array.from({ length: tiles }, (_, index) => {
        const directImage = useDirectGridImages ? imageUrls[index] : "";
        const column = index % columns;
        const row = Math.floor(index / columns);
        const positionX = columns === 1 ? 0 : column / (columns - 1) * 100;
        const positionY = columns === 1 ? 0 : row / (columns - 1) * 100;
        const tileImage = directImage || (!useDirectGridImages ? primaryImage : "");
        const tileStyle = tileImage ? directImage
          ? { backgroundImage: `url(${directImage})`, backgroundSize: "cover", backgroundPosition: "center" }
          : { backgroundImage: `url(${tileImage})`, backgroundSize: `${columns * 100}% ${columns * 100}%`, backgroundPosition: `${positionX}% ${positionY}%` }
          : undefined;
        return <i className={tileImage ? "" : "is-empty"} key={index} style={tileStyle}>{tileImage ? null : <span>＋</span>}</i>;
      })}</div>}
    <div className="moments-feed-meta"><span>刚刚</span><em>··</em></div>
  </div>;
}

function LittleGreenBookPhonePreview({ merchantName, caption, imageUrl, fallbackImageUrl, onEnlarge }: { merchantName: string; caption: string; imageUrl: string; fallbackImageUrl: string; onEnlarge: () => void }) {
  const previewImage = imageUrl || fallbackImageUrl;
  const [titleLine, ...bodyLines] = caption.split("\n").map((item) => item.trim()).filter(Boolean);
  const hasStructuredTitle = Boolean(titleLine && bodyLines.length);
  const title = hasStructuredTitle ? titleLine.replace(/^标题[：:]\s*/, "").slice(0, 28) : "把喜欢的门店体验，认真分享给你";
  const body = hasStructuredTitle ? bodyLines.join("\n") : caption;

  return <div className="little-green-phone">
    <div className={`little-green-cover ${previewImage ? "" : "is-empty"}`} onDoubleClick={(event) => { event.stopPropagation(); if (previewImage) onEnlarge(); }}>
      {previewImage ? <img src={previewImage} alt={`${merchantName}小绿书3比4笔记首图`} /> : <div><b>3:4</b><span>生成后显示笔记首图</span></div>}
    </div>
    <article className="little-green-copy">
      <h4>{title}</h4>
      <p>{body || "通过右侧 AI 对话确定选题与文案，确认后即可生成对应的3:4小绿书笔记首图。"}</p>
    </article>
  </div>;
}

function Design({ busy, action, onPointsChange }: { busy: boolean; action: () => void; onPointsChange: (points: number) => void }) {
  const [activeDesign, setActiveDesign] = useState<(typeof designModes)[number]["id"]>("marketing");
  const activeMode = designModes.find((mode) => mode.id === activeDesign) ?? designModes[0];
  const isLittleGreenBook = activeMode.id === "custom";
  const isMomentsDesign = activeMode.id === "moments";
  const isSocialDesign = activeMode.id === "moments" || activeMode.id === "custom";
  const isAgentDesign = activeMode.id === "marketing" || isSocialDesign || activeMode.id === "material";
  const [prompt, setPrompt] = useState<string>(activeMode.prompt);
  const [referenceNames, setReferenceNames] = useState<string[]>([]);
  const [referenceImageUrls, setReferenceImageUrls] = useState<string[]>([]);
  const [materialQrName, setMaterialQrName] = useState("");
  const [materialQrUrl, setMaterialQrUrl] = useState("");
  const [selectedSpec, setSelectedSpec] = useState("poster-3-4");
  const [selectedMaterialType, setSelectedMaterialType] = useState<(typeof materialTypes)[number]["id"]>("entrance-poster");
  const [generating, setGenerating] = useState(false);
  const [generatedDesign, setGeneratedDesign] = useState<(typeof designModes)[number]["id"] | null>(null);
  const [generatedDesignUrls, setGeneratedDesignUrls] = useState<string[]>([]);
  const [generatedDesignError, setGeneratedDesignError] = useState("");
  const [enlargedDesignImage, setEnlargedDesignImage] = useState<{ url: string; alt: string } | null>(null);
  const [selectedPreview, setSelectedPreview] = useState(1);
  const [downloadStatus, setDownloadStatus] = useState("");
  const [marketingMessages, setMarketingMessages] = useState<MarketingChatMessage[]>([
    { role: "assistant", content: designAgentGreeting(designModes[0]) },
  ]);
  const [marketingInput, setMarketingInput] = useState("");
  const [marketingAgentBusy, setMarketingAgentBusy] = useState(false);
  const [marketingAgentError, setMarketingAgentError] = useState("");
  const [marketingPromptReady, setMarketingPromptReady] = useState(false);
  const [marketingLastCost, setMarketingLastCost] = useState<number | null>(null);
  const [marketingReferenceSummary, setMarketingReferenceSummary] = useState("");
  const [analyzedReferenceSignature, setAnalyzedReferenceSignature] = useState("");
  const [momentsCaptions, setMomentsCaptions] = useState([
    "最近很多顾客都在问自然感眉型✨ 我们会结合脸型和日常习惯做专属设计，让眉眼更有精神、妆感更轻松。想找到适合自己的眉型，欢迎来店沟通体验。",
    "好看的眉形，不是千篇一律，而是刚好适合你。我们更重视自然线条、整体协调和细节质感，希望每一次设计都能让你更从容地面对日常。欢迎提前预约咨询。",
    "把专业做进细节，把自然留在眉眼之间🌿 从沟通、设计到服务体验，我们认真对待每一步。如果你也喜欢自然、耐看的风格，欢迎到店看看适合自己的方案。",
  ]);
  const creatorPanelRef = useRef<HTMLDivElement>(null);
  const previewPanelRef = useRef<HTMLElement>(null);
  const marketingChatRef = useRef<HTMLDivElement>(null);
  const activeSpecOptions = designSpecOptions[activeMode.id];
  const activeMaterialType = materialTypes.find((item) => item.id === selectedMaterialType) ?? materialTypes[0];
  const currentReferenceSignature = `${activeMode.id}:${referenceNames.join("|")}`;
  const referencesAnalyzed = Boolean(marketingReferenceSummary) && analyzedReferenceSignature === currentReferenceSignature;
  const referenceImagesForAgent = referencesAnalyzed ? [] : referenceImageUrls;
  const marketingProviderSize = selectedSpec === "poster-1-1" || selectedSpec === "single-1-1"
    ? "1024x1024"
    : selectedSpec === "poster-9-16" || selectedSpec === "single-9-16"
      ? "1088x1920"
      : selectedSpec === "single-16-9"
        ? "1920x1088"
        : selectedSpec === "grid-4"
          ? "2048x2048"
          : selectedSpec === "grid-9"
            ? "2880x2880"
            : "960x1280";
  const marketingImageQuote = useImagePriceQuote(marketingProviderSize, "high", 3, referenceImageUrls.length);
  const marketingConversationCharacters = marketingInput.length + prompt.length + marketingMessages.reduce((total, item) => total + item.content.length, 0);
  const estimatedMarketingChatPoints = Math.max(2, Math.ceil((2400 + Math.ceil(marketingConversationCharacters / 2) + referenceImagesForAgent.length * 650) / 1000) * 2);

  useEffect(() => {
    if (referencesAnalyzed || !referenceNames.length) return;
    const assistantReplies = marketingMessages.filter((item) => item.role === "assistant");
    if (assistantReplies.length <= 1) return;
    queueMicrotask(() => {
      setMarketingReferenceSummary(assistantReplies[assistantReplies.length - 1]?.content ?? "");
      setAnalyzedReferenceSignature(currentReferenceSignature);
    });
  }, [currentReferenceSignature, marketingMessages, referenceNames.length, referencesAnalyzed]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("material-qr:current-task");
      if (!stored) return;
      const parsed = JSON.parse(stored) as { name?: string; url?: string };
      if (typeof parsed.url === "string" && /^data:image\//i.test(parsed.url)) {
        queueMicrotask(() => {
          setMaterialQrName(typeof parsed.name === "string" ? parsed.name : "门店二维码");
          setMaterialQrUrl(parsed.url as string);
        });
      }
    } catch {
      window.localStorage.removeItem("material-qr:current-task");
    }
  }, []);

  useEffect(() => {
    if (!isAgentDesign) return;
    const controller = new AbortController();
    const projectName = activeMode.title;
    fetch("/api/member/assets", { cache: "no-store", signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("assets unavailable")))
      .then((data: { items?: MemberAssetItem[] }) => {
        const latestBatch = (Array.isArray(data.items) ? data.items : [])
          .filter((item) => item.kind === "image" && item.projectName === projectName)
          .slice(0, 3)
          .sort((left, right) => {
            const leftIndex = Number(left.name.match(/(\d+)\s*$/)?.[1] || 0);
            const rightIndex = Number(right.name.match(/(\d+)\s*$/)?.[1] || 0);
            return leftIndex - rightIndex;
          });
        if (latestBatch.length !== 3) return;
        const restoredUrls = latestBatch.map((item) => item.mediaUrl);
        setGeneratedDesignUrls((current) => current.length ? current : restoredUrls);
        setGeneratedDesign((current) => current ?? activeMode.id);
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) return;
      });
    return () => controller.abort();
  }, [activeMode.id, activeMode.title, isAgentDesign]);

  function openDesign(mode: (typeof designModes)[number]) {
    setActiveDesign(mode.id);
    setPrompt(mode.prompt);
    setSelectedSpec(designSpecOptions[mode.id][0].id);
    if (mode.id === "material") setSelectedMaterialType("entrance-poster");
    setGenerating(false);
    setGeneratedDesign(null);
    setGeneratedDesignUrls([]);
    setGeneratedDesignError("");
    setSelectedPreview(1);
    setDownloadStatus("");
    setMarketingMessages([{ role: "assistant", content: designAgentGreeting(mode) }]);
    setMarketingInput("");
    setMarketingAgentError("");
    setMarketingPromptReady(false);
    setMarketingLastCost(null);
    setMarketingReferenceSummary("");
    setAnalyzedReferenceSignature("");
    window.requestAnimationFrame(() => creatorPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  async function addDesignReferences(event: ChangeEvent<HTMLInputElement>) {
    const remaining = Math.max(0, 8 - referenceImageUrls.length);
    const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/")).slice(0, remaining);
    if (!files.length) {
      event.target.value = "";
      return;
    }
    const urls = await Promise.all(files.map(blobToAiReferenceDataUrl));
    setReferenceNames((current) => [...current, ...files.map((file) => file.name)].slice(0, 8));
    setReferenceImageUrls((current) => [...current, ...urls].slice(0, 8));
    event.target.value = "";
  }

  async function addMaterialQr(event: ChangeEvent<HTMLInputElement>) {
    const file = Array.from(event.target.files ?? []).find((item) => item.type.startsWith("image/"));
    event.target.value = "";
    if (!file) return;
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("二维码读取失败"));
      reader.onerror = () => reject(new Error("二维码读取失败"));
      reader.readAsDataURL(file);
    });
    setMaterialQrName(file.name);
    setMaterialQrUrl(url);
    try {
      window.localStorage.setItem("material-qr:current-task", JSON.stringify({ name: file.name, url }));
    } catch {
      // The QR remains available for the current session when browser storage is full.
    }
  }

  async function generateDesignPlans(promptOverride?: string) {
    const generationPrompt = promptOverride?.trim() || prompt.trim();
    if (generating || busy || !generationPrompt) return;
    if (activeMode.id === "material" && !materialQrUrl) {
      setGeneratedDesignError("请先上传门店二维码，再生成可直接扫码使用的门店物料。");
      return;
    }
    if (promptOverride) setPrompt(generationPrompt);
    setGenerating(true);
    setGeneratedDesign(null);
    setGeneratedDesignUrls([]);
    setGeneratedDesignError("");
    setSelectedPreview(1);
    window.requestAnimationFrame(() => previewPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    try {
      const specLabel = activeSpecOptions.find((option) => option.id === selectedSpec)?.label ?? selectedSpec;
      const modeLayoutInstruction = isLittleGreenBook
        ? "生成一张小绿书笔记发布时展示的第一张3:4竖版封面图（笔记首图）。首图需要在信息流缩略图中吸引点击，并准确表达笔记主题；完整文案将在图片下方独立展示，因此画面不要塞入长段正文；最多保留一句不超过12个汉字的封面钩子，中文必须准确清晰。主体放在移动端安全区域，画面自然真实、有生活感，并与商家品牌及参考图片保持一致。"
        : isMomentsDesign
        ? selectedSpec === "grid-9"
          ? "生成一张完整连续的正方形朋友圈九宫格母图，画面跨越3×3切割线自然衔接，重要文字和人物五官避开切割线；不得生成九张彼此独立、有白边或有间距的卡片。母图后续将均匀切为9张1080×1080图片。"
          : selectedSpec === "grid-4"
            ? "生成一张完整连续的正方形朋友圈四宫格母图，画面跨越2×2切割线自然衔接，重要文字和人物五官避开切割线；不得生成四张彼此独立、有白边或有间距的卡片。母图后续将均匀切为4张1080×1080图片。"
            : "生成适合朋友圈单张发布的海报，信息层级简洁，缩略图状态下主体和核心信息仍清晰。"
        : activeMode.id === "material"
          ? `当前物料类型为“${activeMaterialType.label}”。${activeMaterialType.scene} 设计必须适合线下打印和近距离阅读，信息层级清晰、文字不贴边，并在画面右下角预留独立、干净、无遮挡的正方形二维码安全区域；真实门店二维码将由系统精确合成到此处，不要生成无法扫描的伪二维码。`
          : "生成用于线上活动和团购推广的专业营销海报，移动端展示时主体和关键信息必须清晰。";
      const fullPrompt = `${generationPrompt}\n输出规格：${specLabel}。${modeLayoutInstruction} 不虚构价格、荣誉、活动或本次需求未提供的信息。`;
      const requestId = crypto.randomUUID();
      const response = await fetch("/api/ai/images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: fullPrompt, section: activeMode.title, count: 3, size: marketingProviderSize, quality: "high", images: referenceImageUrls, copies: isLittleGreenBook ? momentsCaptions : [], requestId }),
      });
      let data = await response.json() as { error?: string; taskIds?: string[]; urls?: string[]; isFinal?: boolean; state?: string; requestId?: string; actualPoints?: number | null; wallet?: { points?: number } };
      if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);
      if (!response.ok) throw new Error(data.error || `${activeMode.title}任务创建失败，请稍后重试。`);
      const taskIds = Array.isArray(data.taskIds) ? data.taskIds.filter(Boolean) : [];
      if (!data.isFinal && taskIds.length) {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 3000));
          const statusResponse = await fetch(`/api/ai/images?task_ids=${encodeURIComponent(taskIds.join(","))}&request_id=${encodeURIComponent(data.requestId || requestId)}`, { cache: "no-store" });
          data = await statusResponse.json() as typeof data;
          if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);
          if (!statusResponse.ok) throw new Error(data.error || `查询${activeMode.title}生成进度失败。`);
          if (data.isFinal) break;
        }
      }
      if (data.state === "failed") throw new Error(data.error || `${activeMode.title}生成失败，请重新生成。`);
      const urls = Array.isArray(data.urls) ? data.urls.filter(Boolean).slice(0, 3) : [];
      if (urls.length !== 3) throw new Error(`本次只取得 ${urls.length} 张图片，请重新生成以获得完整的 3 套方案。`);
      setGeneratedDesignUrls(urls);
      setGeneratedDesign(activeMode.id);
      void archiveGeneratedAssets({ projectName: activeMode.title, kind: "image", urls, taskIds, namePrefix: activeMode.title });
    } catch (error) {
      setGeneratedDesignError(error instanceof Error ? error.message : `${activeMode.title}生成失败，请稍后重试。`);
    } finally {
      setGenerating(false);
    }
  }

  async function sendMarketingMessage() {
    const message = marketingInput.trim();
    if (marketingAgentBusy || message.length < 2) return;
    setMarketingInput("");
    setMarketingAgentError("");
    setMarketingPromptReady(false);
    setMarketingMessages((items) => [...items, { role: "user", content: message }]);
    setMarketingAgentBusy(true);
    window.requestAnimationFrame(() => marketingChatRef.current?.scrollTo({ top: marketingChatRef.current.scrollHeight, behavior: "smooth" }));
    try {
      const optimizedReferenceImages = await Promise.all(referenceImagesForAgent.map(optimizeAiReferenceUrl));
      const response = await fetch("/api/ai/marketing-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          messages: marketingMessages,
          currentPrompt: prompt,
          referenceCount: referenceNames.length,
          referenceImages: optimizedReferenceImages,
          referenceSummary: referencesAnalyzed ? marketingReferenceSummary : "",
          creativeType: activeMode.title,
          materialType: activeMode.id === "material" ? activeMaterialType : null,
          qrProvided: activeMode.id === "material" && Boolean(materialQrUrl),
          momentsCopies: isSocialDesign ? momentsCaptions : [],
          requestId: `marketing-agent-${crypto.randomUUID()}`,
        }),
      });
      const data = await response.json() as { error?: string; reply?: string; finalPrompt?: string; visualSummary?: string; ready?: boolean; copies?: string[]; costPoints?: number; degraded?: boolean; usage?: { totalTokens?: number }; wallet?: { points?: number } };
      if (!response.ok || !data.reply) throw new Error(data.error || "AI 暂时没有回复，请稍后再试。");
      setMarketingMessages((items) => [...items, { role: "assistant", content: data.reply ?? "方案已更新。" }]);
      if (data.finalPrompt?.trim()) setPrompt(data.finalPrompt.trim());
      if (data.visualSummary?.trim()) {
        setMarketingReferenceSummary(data.visualSummary.trim());
        setAnalyzedReferenceSignature(currentReferenceSignature);
      }
      const updatedCopies = Array.isArray(data.copies) ? data.copies.map((item) => item.trim()).filter(Boolean).slice(0, 3) : [];
      if (isSocialDesign && updatedCopies.length === 3) setMomentsCaptions(updatedCopies);
      setMarketingPromptReady(Boolean(data.ready));
      setMarketingLastCost(typeof data.costPoints === "number" ? data.costPoints : null);
      if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);
    } catch (error) {
      setMarketingAgentError(error instanceof Error ? error.message : "AI 暂时没有回复，请稍后再试。");
    } finally {
      setMarketingAgentBusy(false);
      window.setTimeout(() => marketingChatRef.current?.scrollTo({ top: marketingChatRef.current.scrollHeight, behavior: "smooth" }), 40);
    }
  }

  async function downloadSelectedDesign() {
    if (downloadStatus) return;
    const selectedGeneratedUrl = isAgentDesign ? generatedDesignUrls[selectedPreview - 1] : "";
    if (selectedGeneratedUrl) {
      setDownloadStatus("正在下载图片…");
      try {
        const { width, height } = designDimensions(selectedSpec);
        const canvas = await generatedImageCanvas(selectedGeneratedUrl, width, height);
        if (activeMode.id === "material" && materialQrUrl) await overlayQrCode(canvas, materialQrUrl);
        triggerDownload(await canvasBlob(canvas), `${activeMode.title}-方案${selectedPreview}-${width}×${height}.png`);
        setDownloadStatus("图片已按所选规格下载");
      } catch {
        await downloadImageUrl(selectedGeneratedUrl, `${activeMode.title}-方案${selectedPreview}.png`);
        setDownloadStatus("图片已下载");
      }
      window.setTimeout(() => setDownloadStatus(""), 1800);
      return;
    }
    setDownloadStatus("正在准备图片…");
    try {
      const canvas = drawDownloadArtwork(activeMode.id, selectedPreview, selectedSpec, "营销");
      if (activeMode.id === "material" && materialQrUrl) await overlayQrCode(canvas, materialQrUrl);
      const specName = activeSpecOptions.find((option) => option.id === selectedSpec)?.label ?? selectedSpec;
      await canvasBlob(canvas).then((blob) => triggerDownload(blob, `${activeMode.title}-方案${selectedPreview}-${specName.replace(/[^0-9A-Za-z\u4e00-\u9fa5×-]+/g, "-")}.png`));
      setDownloadStatus("图片已下载");
    } catch (error) {
      setDownloadStatus(error instanceof Error ? error.message : "下载失败，请重试");
    } finally {
      window.setTimeout(() => setDownloadStatus(""), 1800);
    }
  }

  async function downloadDesignTiles() {
    const { width, height, tiles } = designDimensions(selectedSpec);
    if (downloadStatus || tiles === 1) return;
    setDownloadStatus(`正在切割并打包 ${tiles} 张图片…`);
    try {
      const generatedUrl = isAgentDesign ? generatedDesignUrls[selectedPreview - 1] : "";
      const source = generatedUrl
        ? await generatedImageCanvas(generatedUrl, width, height)
        : drawDownloadArtwork(activeMode.id, selectedPreview, selectedSpec, "营销");
      const columns = tiles === 9 ? 3 : 2;
      const tileWidth = width / columns;
      const tileHeight = height / columns;
      const files: Array<{ name: string; blob: Blob }> = [];
      for (let index = 0; index < tiles; index += 1) {
        const tile = document.createElement("canvas");
        tile.width = 1080;
        tile.height = 1080;
        const context = tile.getContext("2d");
        if (!context) throw new Error("当前浏览器无法切割图片。");
        const sourceX = (index % columns) * tileWidth;
        const sourceY = Math.floor(index / columns) * tileHeight;
        context.drawImage(source, sourceX, sourceY, tileWidth, tileHeight, 0, 0, 1080, 1080);
        files.push({ name: `${String(index + 1).padStart(2, "0")}.png`, blob: await canvasBlob(tile) });
      }
      triggerDownload(await createZip(files), `${activeMode.id === "custom" ? "小绿书" : "朋友圈"}${tiles}宫格-方案${selectedPreview}-${tiles}张1080方图.zip`);
      setDownloadStatus(`${tiles} 张切片已打包下载`);
    } catch (error) {
      setDownloadStatus(error instanceof Error ? error.message : "切片下载失败，请重试");
    } finally {
      window.setTimeout(() => setDownloadStatus(""), 2200);
    }
  }

  const tileCount = designDimensions(selectedSpec).tiles;
  const avatarReferenceIndex = referenceNames.findIndex((name) => /logo|门头|头像|品牌/i.test(name));
  const momentsAvatarUrl = referenceImageUrls[avatarReferenceIndex >= 0 ? avatarReferenceIndex : 0] ?? "";

  return <>
    <ToolHeading title="图片设计" />
    <div className="design-types">{designModes.map((mode) => <button type="button" className={activeDesign === mode.id ? "active" : ""} aria-pressed={activeDesign === mode.id} onClick={() => openDesign(mode)} key={mode.id}><i>{mode.icon}</i><b>{mode.title}</b><span>{mode.desc}</span><small>{activeDesign === mode.id ? "当前已打开" : "点击打开 →"}</small></button>)}</div>
    <div className={`creator-panel ${isAgentDesign ? "marketing-creator-panel" : ""} ${activeMode.id === "marketing" ? "is-marketing" : ""} ${activeMode.id === "material" ? "is-material" : ""} ${isLittleGreenBook ? "is-little-green" : ""}`} ref={creatorPanelRef}>
      {isAgentDesign ? <>
        <div className="marketing-left-column">
          {activeMode.id === "material" ? <div className="material-upload-grid">
            <label className={`upload-zone marketing-upload-zone material-reference-upload ${referenceNames.length ? "has-files" : ""}`}>
              <input type="file" accept="image/*" multiple onChange={addDesignReferences} />
              <em className="marketing-reference-count">{referenceImageUrls.length} / 8</em>
              {referenceImageUrls.length ? <div className="marketing-reference-thumbs">{referenceImageUrls.map((imageUrl, index) => <img src={imageUrl} alt={`门店物料参考图片 ${index + 1}`} key={`${referenceNames[index]}-${index}`} />)}</div> : <b>＋</b>}
              <span>{referenceNames.length ? `已添加 ${referenceNames.length} 张参考图片` : "添加参考图片"}</span>
              <small>{referenceNames.length ? referenceImageUrls.length >= 8 ? "已达到 8 张上限" : `${referenceNames.join("、")} · 点击可继续添加` : "门店、商品、服务或喜欢的物料设计"}</small>
            </label>
            <label className={`upload-zone marketing-upload-zone material-qr-upload ${materialQrUrl ? "has-files" : ""}`}>
              <input type="file" accept="image/*" onChange={addMaterialQr} />
              {materialQrUrl ? <img src={materialQrUrl} alt="门店二维码" /> : <b>＋</b>}
              <span>{materialQrUrl ? "门店二维码" : "添加门店二维码"}</span>
              <small>{materialQrName || "生成结果将保留真实可扫码二维码"}</small>
            </label>
          </div> : <label className={`upload-zone marketing-upload-zone ${referenceNames.length ? "has-files" : ""}`}>
            <input type="file" accept="image/*" multiple onChange={addDesignReferences} />
            <em className="marketing-reference-count">{referenceImageUrls.length} / 8</em>
            {referenceImageUrls.length ? <div className="marketing-reference-thumbs">{referenceImageUrls.map((imageUrl, index) => <img src={imageUrl} alt={`${activeMode.title}参考图片 ${index + 1}`} key={`${referenceNames[index]}-${index}`} />)}</div> : <b>＋</b>}
            <span>{referenceNames.length ? `已添加 ${referenceNames.length} 张参考图片` : `为${activeMode.title}添加参考图片`}</span>
            <small>{referenceNames.length ? referenceImageUrls.length >= 8 ? "已达到 8 张上限" : `${referenceNames.join("、")} · 点击可继续添加` : "支持单张或多选上传，最多 8 张"}</small>
          </label>}
          <section className={`marketing-plan-controls ${isSocialDesign ? "is-moments" : ""}`}>
            {!isLittleGreenBook ? <label className="marketing-final-prompt"><span>生成提示词</span><small>{activeMode.id === "material" ? "AI 会结合物料用途、摆放位置和二维码去向整理提示词" : "只使用本次填写内容与参考图片；规格由下方选择"}</small><textarea aria-label={`${activeMode.title}最终生成提示词`} value={prompt} onChange={(event) => { setPrompt(event.target.value); setMarketingPromptReady(false); }} /></label> : null}
            {isSocialDesign ? <div className={`moments-copy-control ${isLittleGreenBook ? "is-little-green-copy" : ""}`}><div><span>{isLittleGreenBook ? "小绿书文案" : "朋友圈文案"}</span>{isLittleGreenBook ? <small>标题、正文、互动句与话题</small> : null}</div><nav aria-label={`选择要编辑的${isLittleGreenBook ? "小绿书" : "朋友圈"}文案`}>{[1, 2, 3].map((candidate) => <button type="button" className={selectedPreview === candidate ? "active" : ""} aria-pressed={selectedPreview === candidate} onClick={() => setSelectedPreview(candidate)} key={candidate}>文案 {candidate}</button>)}</nav><textarea aria-label={`${isLittleGreenBook ? "小绿书" : "朋友圈"}发布文案${selectedPreview}`} value={momentsCaptions[selectedPreview - 1] ?? ""} placeholder="通过右侧AI对话生成，也可以在这里手动修改" onChange={(event) => setMomentsCaptions((current) => current.map((item, index) => index === selectedPreview - 1 ? event.target.value : item))} /><em>{isLittleGreenBook ? "AI 会生成3种不同传播角度，文案1、2、3分别对应下方的3:4笔记首图方案。" : "通过右侧AI对话生成、重写或调整3份文案；文案1、2、3分别对应下方的图片方案。"}</em></div> : null}
            {isMomentsDesign ? <p className="moments-spec-note">朋友圈规则：单张按所选比例生成；4张先生成一张完整方形母图，再无缝切成4张1080方图；9张先生成一张完整方形母图，再无缝切成9张1080方图。</p> : null}
            <div className={`marketing-bottom-row ${activeMode.id === "material" ? "has-material-type" : ""}`}>
              {activeMode.id === "material" ? <label><span>物料类型</span><select value={selectedMaterialType} onChange={(event) => { setSelectedMaterialType(event.target.value as (typeof materialTypes)[number]["id"]); setGeneratedDesign(null); setGeneratedDesignUrls([]); setMarketingPromptReady(false); }}>{materialTypes.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label> : null}
              {isLittleGreenBook ? <div className="little-green-fixed-spec"><span>笔记首图规格</span><b>1080×1440px · 3:4</b></div> : <label><span>选择规格</span><select value={selectedSpec} onChange={(event) => { setSelectedSpec(event.target.value); setGeneratedDesign(null); setGeneratedDesignUrls([]); setMarketingPromptReady(false); }}>{activeSpecOptions.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label>}
              <button type="button" className="studio-primary" title={activeMode.id === "material" && !materialQrUrl ? "请先上传门店二维码" : marketingImageQuote?.note} disabled={generating || busy || marketingAgentBusy || !prompt.trim() || (activeMode.id === "material" && !materialQrUrl)} onClick={() => void generateDesignPlans()}>{generating || busy ? "正在生成 3 套方案…" : activeMode.id === "material" && !materialQrUrl ? "请先上传门店二维码" : `✦ 生成 3 套${isLittleGreenBook ? "小绿书图文" : activeMode.id === "material" ? "物料" : "海报"} · ${marketingImageQuote?.estimatedPoints ?? "…"}积分`}</button>
            </div>
          </section>
        </div>
        <section className="prompt-zone marketing-agent-zone">
          <div className="marketing-agent-heading"><div><b>{isLittleGreenBook ? "和 AI 一起策划小绿书" : `和 AI 一起确定${activeMode.title}`}</b><span>{isLittleGreenBook ? "AI 会读取本次需求和参考图片，完成选题、标题、正文、互动句与3:4笔记首图大纲" : `AI 会读取本次需求和参考图片，逐步整理${activeMode.id === "moments" ? "朋友圈传播" : activeMode.id === "material" ? "线下物料" : "海报"}方案`}</span></div><em className={referencesAnalyzed ? "ready" : ""}>{referencesAnalyzed ? `已分析 ${referenceImageUrls.length} 张图` : referenceImageUrls.length ? `待分析 ${referenceImageUrls.length} 张图` : "等待参考图"}</em></div>
          <div className="marketing-chat" ref={marketingChatRef} aria-live="polite">
            {marketingMessages.map((item, index) => <div className={`marketing-message is-${item.role}`} key={`${item.role}-${index}`}><small>{item.role === "assistant" ? "AI 策划师" : "我"}</small><p>{item.content}</p></div>)}
            {marketingAgentBusy ? <div className="marketing-message is-assistant is-thinking"><small>AI 策划师</small><p><i /><i /><i /></p></div> : null}
          </div>
          <div className="marketing-chat-composer">
            <textarea aria-label={`向${activeMode.title}AI描述需求`} placeholder={activeMode.id === "custom" ? "继续补充种草主题、真实体验、目标读者或内容表达方式…" : activeMode.id === "moments" ? "继续补充发布内容、卖点、目标顾客或朋友圈表达方式…" : activeMode.id === "material" ? "继续补充摆放位置、顾客行动、二维码去向或视觉感觉…" : "继续补充推广内容、卖点、目标顾客或视觉感觉…"} value={marketingInput} onChange={(event) => setMarketingInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMarketingMessage(); } }} />
            <button type="button" aria-label={`发送消息，预计消耗${estimatedMarketingChatPoints}积分`} title={`发送 · 预计 ${estimatedMarketingChatPoints} 积分，按实际 Token 结算`} disabled={marketingAgentBusy || marketingInput.trim().length < 2} onClick={() => void sendMarketingMessage()}>{marketingAgentBusy ? "…" : "↑"}</button>
          </div>
          <div className={`marketing-agent-note ${marketingAgentError ? "has-error" : ""}`}><span>{marketingAgentError || (marketingPromptReady ? "方案与提示词已经确认。" : "按 Enter 发送，Shift + Enter 换行。")}</span><small>{marketingLastCost !== null ? `上次实际消耗 ${marketingLastCost} 积分；本次预计 ${estimatedMarketingChatPoints} 积分。` : referencesAnalyzed ? `参考图已完成分析，本次仅发送文字上下文，预计 ${estimatedMarketingChatPoints} 积分。` : referenceImageUrls.length ? `将分析 ${referenceImageUrls.length} 张图，本次预计 ${estimatedMarketingChatPoints} 积分，按实际 Token 结算。` : `本次预计 ${estimatedMarketingChatPoints} 积分，按实际 Token 结算。`}</small></div>
        </section>
      </> : null}
    </div>
    <section className="design-results-panel" ref={previewPanelRef}>
      <div className="design-result-head"><div><small>{isSocialDesign ? activeMode.id === "custom" ? "LITTLE GREEN BOOK PREVIEW" : "MOMENTS PREVIEW" : "GENERATED PREVIEW"}</small><h3>{isSocialDesign ? generatedDesignUrls.length === 3 ? `${activeMode.id === "custom" ? "小绿书" : "朋友圈海报"}方案预览` : `${activeMode.id === "custom" ? "小绿书" : "朋友圈"}实时预览` : `${activeMode.title}方案预览`}</h3></div><span>{isSocialDesign ? generatedDesignUrls.length === 3 ? "3 / 3 已生成" : generating ? "AI 生成中" : "实时同步" : generatedDesign === activeMode.id ? "3 / 3 已生成" : generating ? "AI 生成中" : "等待生成"}</span></div>
      {isLittleGreenBook ? <>
        <div className="design-preview-grid little-green-preview-grid">{[1, 2, 3].map((candidate) => { const generatedUrl = generatedDesignUrls[candidate - 1] ?? ""; const imageAlt = `小绿书方案 ${candidate}`; return <button type="button" className={selectedPreview === candidate ? "selected" : ""} aria-pressed={selectedPreview === candidate} onClick={() => setSelectedPreview(candidate)} key={candidate}><LittleGreenBookPhonePreview merchantName="创作者" caption={momentsCaptions[candidate - 1] ?? ""} imageUrl={generatedUrl} fallbackImageUrl={referenceImageUrls[candidate - 1] || referenceImageUrls[0] || ""} onEnlarge={() => { const url = generatedUrl || referenceImageUrls[candidate - 1] || referenceImageUrls[0]; if (url) setEnlargedDesignImage({ url, alt: imageAlt }); }} /><span><b>{generatedUrl ? `图文方案 ${candidate}` : `实时预览 ${candidate}`}</b><i>{selectedPreview === candidate ? "✓ 已选择" : "选择"}</i></span></button>; })}</div>
        {generating ? <div className="moments-generation-status"><i /><b>正在生成3套小绿书3:4笔记首图</b><span>3份文案仍可继续编辑，生成完成后会自动进入对应手机预览。</span></div> : generatedDesignUrls.length === 3 ? <div className="design-download-bar"><div><b>已选择小绿书图文方案 {selectedPreview}</b><span>下载的笔记首图将保持 1080×1440px · 3:4；文案可直接从手机预览上方的编辑区复制。</span></div><div><button type="button" disabled={Boolean(downloadStatus)} onClick={() => void downloadSelectedDesign()}>↓ 下载笔记首图</button></div>{downloadStatus ? <small role="status">{downloadStatus}</small> : null}</div> : <div className="moments-live-preview-foot moments-preview-note"><b>当前为小绿书实时预览</b><span>上传参考图片或与右侧AI对话后，笔记首图和文案会同步显示在三台手机中。</span></div>}
      </> : isSocialDesign ? <>
        <div className="design-preview-grid moments-feed-preview-grid">{[1, 2, 3].map((candidate) => { const generatedUrl = generatedDesignUrls[candidate - 1] ?? ""; const imageAlt = `朋友圈方案 ${candidate}`; return <button type="button" className={selectedPreview === candidate ? "selected" : ""} aria-pressed={selectedPreview === candidate} onClick={() => setSelectedPreview(candidate)} key={candidate}><MomentsFeedPreview merchantName="创作者" avatarUrl={momentsAvatarUrl} caption={momentsCaptions[candidate - 1] ?? ""} imageUrl={generatedUrl} imageUrls={generatedUrl ? [] : referenceImageUrls} spec={selectedSpec} onEnlarge={() => { const url = generatedUrl || referenceImageUrls[0]; if (url) setEnlargedDesignImage({ url, alt: imageAlt }); }} /><span><b>{generatedUrl ? `方案 ${candidate}` : `实时预览 ${candidate}`}</b><i>{selectedPreview === candidate ? "✓ 已选择" : "选择"}</i></span></button>; })}</div>
        {generating ? <div className="moments-generation-status"><i /><b>正在生成3套朋友圈图片</b><span>当前可继续查看和修改3份朋友圈文案。</span></div> : generatedDesignUrls.length === 3 ? <div className="design-download-bar"><div><b>已选择方案 {selectedPreview}</b><span>{tileCount > 1 ? `可下载完整原图，或下载 ${tileCount} 张 1080×1080px 无缝切片。` : "下载文件将保持当前选择的图片规格。"}</span></div><div><button type="button" disabled={Boolean(downloadStatus)} onClick={() => void downloadSelectedDesign()}>↓ {tileCount > 1 ? "下载完整原图" : "下载图片"}</button>{tileCount > 1 ? <button type="button" className="primary" disabled={Boolean(downloadStatus)} onClick={() => void downloadDesignTiles()}>▦ 下载{tileCount}张切片包</button> : null}</div>{downloadStatus ? <small role="status">{downloadStatus}</small> : null}</div> : <div className="moments-live-preview-foot moments-preview-note"><b>当前使用参考图片实时预览</b><span>生成完成后，3套图片会分别替换到对应的朋友圈预览中。</span></div>}
      </> : generating ? <div className="design-preview-loading"><i /><b>正在生成 3 套{activeMode.title}</b><span>真实图片生成通常需要 20 秒到 2 分钟，完成后会自动显示。</span></div> : generatedDesign === activeMode.id ? <>
        <div className="design-preview-grid">{[1, 2, 3].map((candidate) => { const generatedUrl = generatedDesignUrls[candidate - 1] ?? ""; const imageAlt = `${activeMode.title}方案 ${candidate}`; return <button type="button" className={selectedPreview === candidate ? "selected" : ""} aria-pressed={selectedPreview === candidate} onClick={() => setSelectedPreview(candidate)} key={candidate}>{generatedUrl ? <div className={`design-generated-media ${activeMode.id === "material" && materialQrUrl ? "has-material-qr" : ""}`}><img className="design-generated-image" src={generatedUrl} alt={imageAlt} title="双击放大查看" onDoubleClick={(event) => { event.stopPropagation(); setEnlargedDesignImage({ url: generatedUrl, alt: imageAlt }); }} />{activeMode.id === "material" && materialQrUrl ? <span className="material-preview-qr"><img src={materialQrUrl} alt="门店二维码" /><small>扫码参与</small></span> : null}</div> : <DesignPreviewArtwork mode={activeMode.id} candidate={candidate} spec={selectedSpec} />}<span><b>方案 {candidate}</b><i>{selectedPreview === candidate ? "✓ 已选择" : "选择"}</i></span></button>; })}</div>
        <div className="design-download-bar">
          <div><b>已选择方案 {selectedPreview}</b><span>{tileCount > 1 ? `可下载完整原图，或下载 ${tileCount} 张 1080×1080px 无缝切片。` : "下载文件将保持当前选择的图片规格。"}</span></div>
          <div><button type="button" disabled={Boolean(downloadStatus)} onClick={() => void downloadSelectedDesign()}>↓ {tileCount > 1 ? "下载完整原图" : "下载图片"}</button>{tileCount > 1 ? <button type="button" className="primary" disabled={Boolean(downloadStatus)} onClick={() => void downloadDesignTiles()}>▦ 下载{tileCount}张切片包</button> : null}</div>
          {downloadStatus ? <small role="status">{downloadStatus}</small> : null}
        </div>
      </> : <div className={`design-preview-empty ${generatedDesignError ? "has-error" : ""}`}><i>{generatedDesignError ? "!" : "图"}</i><b>{generatedDesignError || "生成结果将在这里预览"}</b><span>{generatedDesignError ? "本次未扣除失败任务的积分，可修改方案后重新生成。" : "完善参考图片和需求后，点击上方生成按钮。"}</span></div>}
    </section>
    {enlargedDesignImage ? <div className="generated-image-lightbox" role="dialog" aria-modal="true" aria-label={`放大查看${activeMode.title}`} onMouseDown={(event) => { if (event.currentTarget === event.target) setEnlargedDesignImage(null); }}><div className="generated-image-lightbox-card" onMouseDown={(event) => event.stopPropagation()}><button type="button" aria-label="关闭放大图片" onClick={() => setEnlargedDesignImage(null)}>×</button><img src={enlargedDesignImage.url} alt={enlargedDesignImage.alt} /><span>{activeMode.title}预览 · 点击外部区域关闭</span></div></div> : null}
  </>;
}

function DesignPreviewArtwork({ mode, candidate, spec }: { mode: (typeof designModes)[number]["id"]; candidate: number; spec: string }) {
  if (mode === "material") return <div className={`design-preview-art is-material plan-${candidate}`}><small>门店活动</small><b>夏日上新<br />到店有礼</b><span>扫码了解活动</span><i /></div>;
  if (mode === "custom") return <div className={`design-preview-art is-custom plan-${candidate}`}><i /><i /><i /><b>自由创作</b><span>REFERENCE DESIGN</span></div>;
  if (mode === "moments" && ["grid-4", "grid-9"].includes(spec)) {
    const imageCount = spec === "grid-4" ? 4 : 9;
    return <div className={`design-preview-art is-moments is-multi format-${spec} plan-${candidate}`}><div>{Array.from({ length: imageCount }, (_, index) => <i key={index} />)}</div><b>夏日新味<br />值得分享</b><span>{imageCount} 张 · 每张 1080×1080px · 无白边切割</span></div>;
  }
  const formatClass = spec.includes("1-1") ? "format-square" : spec.includes("9-16") ? "format-full" : spec.includes("16-9") ? "format-landscape" : "format-portrait";
  return <div className={`design-preview-art is-${mode} ${formatClass} plan-${candidate}`}><small>{mode === "moments" ? "今日分享" : "季节限定"}</small><b>{mode === "moments" ? <>这一口新鲜<br />值得分享</> : <>夏日新味<br />鲜香上市</>}</b><span>{mode === "moments" ? "到店体验 · 分享美好" : "品牌门店 · 限时推荐"}</span></div>;
}

type VideoMaterialItem = {
  id: string;
  name: string;
  type: "image" | "video";
  previewUrl: string;
  aiImage: string;
};

type VideoDirection = {
  id: string;
  title: string;
  tag: string;
  hook: string;
  story: string;
  reason: string;
  risk: string;
};

type VideoShot = {
  time: string;
  title: string;
  visual: string;
  caption: string;
  source: string;
};

type VideoStoryboard = {
  title: string;
  script: string;
  generationPrompt: string;
  shots: VideoShot[];
  modelPlan: Array<{ step: string; model: string; reason: string }>;
};

type VideoQuote = {
  reservedPoints: number;
  duration: number;
  resolution: string;
  version: "Mini" | "快速" | "标准";
  outputTokenPrice: number;
  note: string;
};

type PhotoVideoTemplateId = string;
type PhotoVideoRatio = "9:16" | "1:1" | "16:9";
type PhotoVideoCategory = "business" | "atmosphere" | "energy" | "commerce" | "story" | "cases";
type PhotoVideoLayout = "quiet" | "showcase" | "split" | "grid" | "case-grid" | "proof" | "rhythm" | "spotlight" | "polaroid" | "timeline" | "letterbox" | "before-after" | "carousel";
type PhotoVideoMotion = "zoom-in" | "zoom-out" | "pan-left" | "pan-right" | "pan-up" | "float";
type PhotoVideoTransition = "fade" | "fade-black" | "fade-white" | "wipe-left" | "wipe-right" | "wipe-up" | "wipe-down" | "slide-left" | "slide-right" | "slide-up" | "slide-down" | "circle-open" | "diagonal" | "split-open" | "checker" | "zoom-in" | "zoom-out" | "blur" | "film-burn" | "glitch";

type PhotoVideoTemplate = {
  id: PhotoVideoTemplateId;
  name: string;
  detail: string;
  tag: string;
  category: PhotoVideoCategory;
  layout: PhotoVideoLayout;
  motion: PhotoVideoMotion;
  transitions: PhotoVideoTransition[];
  effectLabel: string;
  background: string;
  accent: string;
};

const PHOTO_VIDEO_CATEGORIES: Array<{ id: "all" | PhotoVideoCategory; name: string }> = [
  { id: "all", name: "全部 24" },
  { id: "business", name: "商务简洁" },
  { id: "atmosphere", name: "情绪氛围" },
  { id: "energy", name: "活力网感" },
  { id: "commerce", name: "产品电商" },
  { id: "story", name: "故事相册" },
  { id: "cases", name: "门店案例" },
];

const PHOTO_VIDEO_TEMPLATES: PhotoVideoTemplate[] = [
  { id: "quiet-album", name: "极简相册", detail: "原图完整呈现，轻微推拉与柔和淡切", tag: "通用", category: "business", layout: "quiet", motion: "zoom-in", transitions: ["fade", "blur", "wipe-left"], effectLabel: "柔推 · 淡切", background: "#0d0f13", accent: "#59d9e8" },
  { id: "clean-proof", name: "留白画册", detail: "纸张留白与克制进度线，适合专业作品", tag: "质感", category: "business", layout: "proof", motion: "zoom-in", transitions: ["fade-white", "wipe-right", "slide-left"], effectLabel: "留白 · 轻移", background: "#f4f1ea", accent: "#17191e" },
  { id: "brand-window", name: "品牌橱窗", detail: "完整边框与品牌色点缀，突出统一视觉", tag: "品牌", category: "business", layout: "showcase", motion: "pan-right", transitions: ["wipe-left", "fade-black", "slide-up"], effectLabel: "框景 · 平移", background: "#17191e", accent: "#f4c95d" },
  { id: "data-board", name: "数据简报", detail: "主画面配合进度节点，适合成果与项目汇报", tag: "汇报", category: "business", layout: "timeline", motion: "pan-left", transitions: ["slide-left", "wipe-up", "fade"], effectLabel: "节点 · 推进", background: "#101738", accent: "#59d9e8" },

  { id: "film-memory", name: "胶片回忆", detail: "暖色胶片燃烧与缓慢漂移，适合回顾内容", tag: "复古", category: "atmosphere", layout: "letterbox", motion: "pan-right", transitions: ["film-burn", "fade-black", "blur"], effectLabel: "胶片 · 暖闪", background: "#130f0b", accent: "#e89b58" },
  { id: "dreamy-glow", name: "梦境柔光", detail: "柔焦背景与梦幻缩放，适合情绪写真", tag: "柔光", category: "atmosphere", layout: "quiet", motion: "zoom-out", transitions: ["blur", "zoom-in", "fade-white"], effectLabel: "柔焦 · 梦幻缩放", background: "#17132a", accent: "#d6b7ff" },
  { id: "soft-focus", name: "静谧呼吸", detail: "低速悬浮与暗部叠化，画面更安静", tag: "沉静", category: "atmosphere", layout: "spotlight", motion: "float", transitions: ["fade-black", "circle-open", "fade"], effectLabel: "呼吸 · 暗切", background: "#0a1018", accent: "#8fc7d8" },
  { id: "cinematic-letterbox", name: "电影宽幕", detail: "上下遮幅与横向运镜，建立电影叙事感", tag: "电影", category: "atmosphere", layout: "letterbox", motion: "pan-left", transitions: ["fade-black", "diagonal", "zoom-out"], effectLabel: "宽幕 · 横移", background: "#050607", accent: "#f4f1ea" },

  { id: "rhythm-cut", name: "节奏切片", detail: "快速切换与方向滑动，适合种草内容", tag: "节奏", category: "energy", layout: "rhythm", motion: "pan-right", transitions: ["slide-left", "wipe-right", "glitch"], effectLabel: "切片 · 滑动", background: "#0d0f13", accent: "#ff4d8d" },
  { id: "glitch-pulse", name: "故障脉冲", detail: "横向错位与电子色差，适合科技和潮流", tag: "故障", category: "energy", layout: "rhythm", motion: "zoom-in", transitions: ["glitch", "checker", "fade-black"], effectLabel: "错位 · 脉冲", background: "#080a14", accent: "#59d9e8" },
  { id: "mosaic-beat", name: "马赛克卡点", detail: "方格揭幕和多图同屏，适合活动节奏", tag: "卡点", category: "energy", layout: "grid", motion: "zoom-in", transitions: ["checker", "split-open", "wipe-down"], effectLabel: "方格 · 卡点", background: "#101114", accent: "#f4c95d" },
  { id: "zoom-rush", name: "冲击变焦", detail: "快速推进与缩放切换，强化视觉冲击", tag: "冲击", category: "energy", layout: "spotlight", motion: "zoom-in", transitions: ["zoom-in", "zoom-out", "fade-white"], effectLabel: "推进 · 闪切", background: "#100b13", accent: "#ff4d8d" },

  { id: "merchant-showcase", name: "商家展示", detail: "环境铺底，主体居中，适合门店与服务", tag: "商家", category: "commerce", layout: "showcase", motion: "zoom-in", transitions: ["wipe-left", "fade", "slide-up"], effectLabel: "框景 · 推拉", background: "#28242b", accent: "#f4c95d" },
  { id: "product-spotlight", name: "产品聚焦", detail: "暗场聚光与中心陈列，让商品成为唯一焦点", tag: "产品", category: "commerce", layout: "spotlight", motion: "zoom-in", transitions: ["circle-open", "zoom-in", "fade-black"], effectLabel: "聚光 · 聚焦", background: "#090b0f", accent: "#f4c95d" },
  { id: "feature-carousel", name: "卖点轮播", detail: "主卡居中、两侧预告，适合连续展示卖点", tag: "卖点", category: "commerce", layout: "carousel", motion: "pan-left", transitions: ["slide-left", "slide-right", "wipe-left"], effectLabel: "轮播 · 推进", background: "#101738", accent: "#59d9e8" },
  { id: "before-after", name: "前后对比", detail: "左右分屏对照，适合改造、服务与案例变化", tag: "对比", category: "commerce", layout: "before-after", motion: "zoom-in", transitions: ["split-open", "wipe-right", "fade-white"], effectLabel: "分屏 · 对照", background: "#111318", accent: "#ff4d8d" },

  { id: "split-story", name: "双画面叙事", detail: "主画面配合下一张预告，信息更连贯", tag: "故事", category: "story", layout: "split", motion: "zoom-in", transitions: ["wipe-up", "slide-left", "fade"], effectLabel: "双景 · 预告", background: "#101114", accent: "#59d9e8" },
  { id: "polaroid-story", name: "拍立得故事", detail: "照片卡片轻微旋转，适合生活记录与人物故事", tag: "生活", category: "story", layout: "polaroid", motion: "float", transitions: ["slide-up", "fade-white", "diagonal"], effectLabel: "卡片 · 漂浮", background: "#d8d0c3", accent: "#17191e" },
  { id: "story-timeline", name: "时间轴回顾", detail: "节点随画面推进，适合成长与过程记录", tag: "时间轴", category: "story", layout: "timeline", motion: "pan-right", transitions: ["wipe-left", "slide-left", "fade"], effectLabel: "时间轴 · 推进", background: "#121419", accent: "#f4c95d" },
  { id: "book-page", name: "书页章节", detail: "纸张构图与对角揭幕，适合课程和知识内容", tag: "章节", category: "story", layout: "proof", motion: "pan-up", transitions: ["diagonal", "wipe-right", "fade-white"], effectLabel: "书页 · 揭幕", background: "#eee8dd", accent: "#5b4935" },

  { id: "photo-wall", name: "多图拼贴", detail: "四张图片同屏轮换，适合活动与案例", tag: "拼贴", category: "cases", layout: "grid", motion: "pan-left", transitions: ["checker", "fade", "wipe-down"], effectLabel: "拼贴 · 轮换", background: "#101114", accent: "#59d9e8" },
  { id: "case-grid", name: "案例看板", detail: "一张主图搭配两张细节，快速展示完整案例", tag: "案例", category: "cases", layout: "case-grid", motion: "zoom-in", transitions: ["split-open", "slide-up", "wipe-left"], effectLabel: "主次 · 展开", background: "#111943", accent: "#f4c95d" },
  { id: "testimonial", name: "口碑印象", detail: "留白照片与稳定进度，适合评价和服务成果", tag: "口碑", category: "cases", layout: "proof", motion: "zoom-out", transitions: ["fade-white", "blur", "slide-right"], effectLabel: "留白 · 稳切", background: "#f0ece5", accent: "#ff4d8d" },
  { id: "venue-tour", name: "空间巡游", detail: "连续横移与前后画面预告，适合门店环境", tag: "空间", category: "cases", layout: "carousel", motion: "pan-right", transitions: ["slide-left", "slide-down", "wipe-left", "zoom-out"], effectLabel: "巡游 · 连续横移", background: "#0c1334", accent: "#59d9e8" },
];

function photoVideoCanvasSize(ratio: PhotoVideoRatio, resolution: "480p" | "720p") {
  const shortSide = resolution === "720p" ? 720 : 480;
  if (ratio === "1:1") return { width: shortSide, height: shortSide };
  if (ratio === "16:9") return { width: resolution === "720p" ? 1280 : 854, height: shortSide };
  return { width: shortSide, height: resolution === "720p" ? 1280 : 854 };
}

function photoRect(image: HTMLImageElement, width: number, height: number, mode: "cover" | "contain", zoom = 1) {
  const scale = (mode === "cover" ? Math.max(width / image.naturalWidth, height / image.naturalHeight) : Math.min(width / image.naturalWidth, height / image.naturalHeight)) * zoom;
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  return { x: (width - drawWidth) / 2, y: (height - drawHeight) / 2, width: drawWidth, height: drawHeight };
}

function drawPhotoImage(context: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, width: number, height: number, mode: "cover" | "contain", zoom = 1, offsetX = 0, offsetY = 0) {
  const rect = photoRect(image, width, height, mode, zoom);
  context.drawImage(image, x + rect.x + offsetX, y + rect.y + offsetY, rect.width, rect.height);
}

function photoMotionValues(motion: PhotoVideoMotion, progress: number, width: number, height: number) {
  const centered = progress - .5;
  if (motion === "zoom-out") return { zoom: 1.045 - progress * .035, x: 0, y: 0 };
  if (motion === "pan-left") return { zoom: 1.045, x: -centered * width * .05, y: 0 };
  if (motion === "pan-right") return { zoom: 1.045, x: centered * width * .05, y: 0 };
  if (motion === "pan-up") return { zoom: 1.035, x: 0, y: -centered * height * .04 };
  if (motion === "float") return { zoom: 1.025, x: Math.sin(progress * Math.PI * 2) * width * .008, y: Math.sin(progress * Math.PI) * -height * .012 };
  return { zoom: 1.01 + progress * .035, x: 0, y: 0 };
}

function drawPhotoTemplateFrame(
  context: CanvasRenderingContext2D,
  images: HTMLImageElement[],
  index: number,
  progress: number,
  width: number,
  height: number,
  templateId: PhotoVideoTemplateId,
  alpha = 1,
) {
  if (!images.length) return;
  const safeIndex = Math.max(0, index) % images.length;
  const image = images[safeIndex] || images[0];
  const next = images[(safeIndex + 1) % images.length] || image;
  const previous = images[(safeIndex - 1 + images.length) % images.length] || image;
  const template = PHOTO_VIDEO_TEMPLATES.find((item) => item.id === templateId) || PHOTO_VIDEO_TEMPLATES[0];
  const motion = photoMotionValues(template.motion, progress, width, height);
  const shortSide = Math.min(width, height);
  const previousAlpha = context.globalAlpha;
  context.globalAlpha = alpha;
  context.save();

  if (template.layout === "proof") {
    context.fillStyle = template.background;
    context.fillRect(0, 0, width, height);
    const margin = Math.round(shortSide * .08);
    context.shadowColor = "rgba(18,20,25,.22)";
    context.shadowBlur = Math.round(shortSide * .035);
    context.shadowOffsetY = Math.round(shortSide * .018);
    context.fillStyle = "#ffffff";
    context.fillRect(margin, margin, width - margin * 2, height - margin * 2);
    context.shadowColor = "transparent";
    context.save();
    context.beginPath();
    context.rect(margin, margin, width - margin * 2, height - margin * 2);
    context.clip();
    drawPhotoImage(context, image, margin, margin, width - margin * 2, height - margin * 2, "contain", motion.zoom, motion.x, motion.y);
    context.restore();
    context.fillStyle = template.accent;
    context.fillRect(margin, height - margin - 5, Math.max(28, (width - margin * 2) * (.22 + progress * .62)), 5);
  } else if (template.layout === "grid") {
    context.fillStyle = template.background;
    context.fillRect(0, 0, width, height);
    const gap = Math.max(8, Math.round(shortSide * .018));
    const cellWidth = (width - gap * 3) / 2;
    const cellHeight = (height - gap * 3) / 2;
    for (let cell = 0; cell < 4; cell += 1) {
      const cellImage = images[(safeIndex + cell) % images.length] || image;
      const column = cell % 2;
      const row = Math.floor(cell / 2);
      const x = gap + column * (cellWidth + gap);
      const y = gap + row * (cellHeight + gap);
      context.save();
      context.beginPath();
      context.rect(x, y, cellWidth, cellHeight);
      context.clip();
      drawPhotoImage(context, cellImage, x, y, cellWidth, cellHeight, "cover", 1.015 + progress * .025, (column ? -1 : 1) * progress * gap * .45);
      context.restore();
    }
  } else if (template.layout === "case-grid") {
    context.fillStyle = template.background;
    context.fillRect(0, 0, width, height);
    const gap = Math.max(8, Math.round(shortSide * .018));
    const inset = gap;
    const leftWidth = (width - inset * 2 - gap) * .64;
    const rightWidth = width - inset * 2 - gap - leftWidth;
    context.save();
    context.beginPath();
    context.rect(inset, inset, leftWidth, height - inset * 2);
    context.clip();
    drawPhotoImage(context, image, inset, inset, leftWidth, height - inset * 2, "cover", motion.zoom, motion.x, motion.y);
    context.restore();
    for (let row = 0; row < 2; row += 1) {
      const y = inset + row * ((height - inset * 2 - gap) / 2 + gap);
      const cellHeight = (height - inset * 2 - gap) / 2;
      const cellImage = row === 0 ? next : images[(safeIndex + 2) % images.length] || previous;
      context.save();
      context.beginPath();
      context.rect(inset + leftWidth + gap, y, rightWidth, cellHeight);
      context.clip();
      drawPhotoImage(context, cellImage, inset + leftWidth + gap, y, rightWidth, cellHeight, "cover", 1.025);
      context.restore();
    }
  } else if (template.layout === "split") {
    context.fillStyle = template.background;
    context.fillRect(0, 0, width, height);
    const gap = Math.max(10, Math.round(shortSide * .025));
    const inset = Math.round(shortSide * .055);
    const portrait = height >= width;
    const mainWidth = portrait ? width - inset * 2 : (width - inset * 2 - gap) * .64;
    const mainHeight = portrait ? (height - inset * 2 - gap) * .64 : height - inset * 2;
    context.save();
    context.beginPath();
    context.rect(inset, inset, mainWidth, mainHeight);
    context.clip();
    drawPhotoImage(context, image, inset, inset, mainWidth, mainHeight, "cover", motion.zoom, motion.x, motion.y);
    context.restore();
    const nextX = portrait ? inset : inset + mainWidth + gap;
    const nextY = portrait ? inset + mainHeight + gap : inset;
    const nextWidth = portrait ? width - inset * 2 : width - inset * 2 - mainWidth - gap;
    const nextHeight = portrait ? height - inset * 2 - mainHeight - gap : height - inset * 2;
    context.save();
    context.beginPath();
    context.rect(nextX, nextY, nextWidth, nextHeight);
    context.clip();
    drawPhotoImage(context, next, nextX, nextY, nextWidth, nextHeight, "cover", 1.03, -progress * gap * .6);
    context.restore();
  } else if (template.layout === "before-after") {
    context.fillStyle = template.background;
    context.fillRect(0, 0, width, height);
    const divider = width * (.38 + progress * .24);
    context.save();
    context.beginPath();
    context.rect(0, 0, divider, height);
    context.clip();
    drawPhotoImage(context, image, 0, 0, width, height, "cover", motion.zoom, motion.x, motion.y);
    context.restore();
    context.save();
    context.beginPath();
    context.rect(divider, 0, width - divider, height);
    context.clip();
    drawPhotoImage(context, next, 0, 0, width, height, "cover", 1.035, -motion.x, motion.y);
    context.restore();
    context.fillStyle = "#ffffff";
    context.fillRect(divider - 2, 0, 4, height);
    context.fillStyle = template.accent;
    context.beginPath();
    context.arc(divider, height * .5, Math.max(13, shortSide * .026), 0, Math.PI * 2);
    context.fill();
  } else if (template.layout === "polaroid") {
    context.fillStyle = template.background;
    context.fillRect(0, 0, width, height);
    const cardWidth = width * .78;
    const cardHeight = height * .72;
    const angle = (progress - .5) * .035;
    context.translate(width / 2 + motion.x, height / 2 + motion.y);
    context.rotate(angle);
    context.shadowColor = "rgba(18,20,25,.28)";
    context.shadowBlur = shortSide * .04;
    context.shadowOffsetY = shortSide * .02;
    context.fillStyle = "#fffdf8";
    context.fillRect(-cardWidth / 2, -cardHeight / 2, cardWidth, cardHeight);
    context.shadowColor = "transparent";
    const photoInset = shortSide * .035;
    context.save();
    context.beginPath();
    context.rect(-cardWidth / 2 + photoInset, -cardHeight / 2 + photoInset, cardWidth - photoInset * 2, cardHeight - photoInset * 3.2);
    context.clip();
    drawPhotoImage(context, image, -cardWidth / 2 + photoInset, -cardHeight / 2 + photoInset, cardWidth - photoInset * 2, cardHeight - photoInset * 3.2, "cover", motion.zoom);
    context.restore();
    context.fillStyle = template.accent;
    context.fillRect(-cardWidth * .32, cardHeight * .35, cardWidth * .28, Math.max(3, shortSide * .007));
  } else if (template.layout === "timeline") {
    context.fillStyle = template.background;
    context.fillRect(0, 0, width, height);
    const inset = shortSide * .055;
    const mediaHeight = height * .78;
    context.save();
    context.beginPath();
    context.rect(inset, inset, width - inset * 2, mediaHeight - inset);
    context.clip();
    drawPhotoImage(context, image, inset, inset, width - inset * 2, mediaHeight - inset, "cover", motion.zoom, motion.x, motion.y);
    context.restore();
    const lineY = height * .88;
    context.fillStyle = "rgba(255,255,255,.18)";
    context.fillRect(inset, lineY, width - inset * 2, 3);
    context.fillStyle = template.accent;
    context.fillRect(inset, lineY, (width - inset * 2) * (.12 + progress * .88), 3);
    for (let node = 0; node < 4; node += 1) {
      const nodeX = inset + (width - inset * 2) * (node / 3);
      context.beginPath();
      context.arc(nodeX, lineY + 1.5, Math.max(4, shortSide * .009), 0, Math.PI * 2);
      context.fillStyle = node / 3 <= progress ? template.accent : "rgba(255,255,255,.32)";
      context.fill();
    }
  } else if (template.layout === "letterbox") {
    context.fillStyle = template.background;
    context.fillRect(0, 0, width, height);
    const mediaY = height * .11;
    const mediaHeight = height * .78;
    context.save();
    context.beginPath();
    context.rect(0, mediaY, width, mediaHeight);
    context.clip();
    drawPhotoImage(context, image, 0, mediaY, width, mediaHeight, "cover", motion.zoom, motion.x, motion.y);
    context.restore();
    context.fillStyle = template.accent;
    context.globalAlpha = alpha * .72;
    context.fillRect(width * .08, height * .925, width * (.16 + progress * .52), Math.max(3, shortSide * .006));
    context.globalAlpha = alpha;
  } else if (template.layout === "carousel") {
    context.fillStyle = template.background;
    context.fillRect(0, 0, width, height);
    const cardWidth = width * .72;
    const cardHeight = height * .78;
    const cardY = (height - cardHeight) / 2;
    const sideWidth = width * .2;
    context.globalAlpha = alpha * .42;
    drawPhotoImage(context, previous, -sideWidth * .46, cardY + cardHeight * .08, sideWidth, cardHeight * .84, "cover", 1.04);
    drawPhotoImage(context, next, width - sideWidth * .54, cardY + cardHeight * .08, sideWidth, cardHeight * .84, "cover", 1.04);
    context.globalAlpha = alpha;
    context.shadowColor = "rgba(0,0,0,.38)";
    context.shadowBlur = shortSide * .035;
    context.shadowOffsetY = shortSide * .018;
    context.save();
    context.beginPath();
    context.rect((width - cardWidth) / 2, cardY, cardWidth, cardHeight);
    context.clip();
    drawPhotoImage(context, image, (width - cardWidth) / 2, cardY, cardWidth, cardHeight, "cover", motion.zoom, motion.x, motion.y);
    context.restore();
    context.shadowColor = "transparent";
  } else if (template.layout === "spotlight") {
    context.fillStyle = template.background;
    context.fillRect(0, 0, width, height);
    const glow = context.createRadialGradient(width * .5, height * .46, shortSide * .04, width * .5, height * .46, shortSide * .6);
    glow.addColorStop(0, `${template.accent}55`);
    glow.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = glow;
    context.fillRect(0, 0, width, height);
    const insetX = width * .09;
    const insetY = height * .08;
    context.save();
    context.beginPath();
    context.rect(insetX, insetY, width - insetX * 2, height - insetY * 2);
    context.clip();
    drawPhotoImage(context, image, insetX, insetY, width - insetX * 2, height - insetY * 2, "contain", motion.zoom, motion.x, motion.y);
    context.restore();
    const vignette = context.createRadialGradient(width * .5, height * .5, shortSide * .22, width * .5, height * .5, shortSide * .82);
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(1, "rgba(0,0,0,.72)");
    context.fillStyle = vignette;
    context.fillRect(0, 0, width, height);
  } else {
    context.fillStyle = template.background;
    context.fillRect(0, 0, width, height);
    context.save();
    context.filter = template.layout === "showcase" ? "blur(28px) brightness(.58)" : "blur(34px) brightness(.4)";
    drawPhotoImage(context, image, 0, 0, width, height, "cover", 1.1 + progress * .018, motion.x, motion.y);
    context.restore();

    if (template.layout === "rhythm") {
      context.save();
      context.beginPath();
      context.rect(0, 0, width, height);
      context.clip();
      drawPhotoImage(context, image, 0, 0, width, height, "cover", motion.zoom, motion.x, motion.y);
      context.restore();
      context.fillStyle = template.accent;
      context.fillRect(0, 0, Math.max(8, width * .018), height);
      context.fillStyle = "rgba(89,217,232,.88)";
      context.fillRect(width - Math.max(8, width * .012), 0, Math.max(8, width * .012), height);
    } else {
      const inset = template.layout === "showcase" ? Math.round(shortSide * .055) : 0;
      context.save();
      if (inset) {
        context.beginPath();
        context.rect(inset, inset, width - inset * 2, height - inset * 2);
        context.clip();
      }
      drawPhotoImage(context, image, inset, inset, width - inset * 2, height - inset * 2, "contain", motion.zoom, motion.x, motion.y);
      context.restore();
      if (template.layout === "showcase") {
        context.strokeStyle = "rgba(255,255,255,.72)";
        context.lineWidth = Math.max(2, Math.round(shortSide * .004));
        context.strokeRect(inset, inset, width - inset * 2, height - inset * 2);
        const gradient = context.createLinearGradient(0, height * .65, 0, height);
        gradient.addColorStop(0, "rgba(8,10,14,0)");
        gradient.addColorStop(1, "rgba(8,10,14,.72)");
        context.fillStyle = gradient;
        context.fillRect(0, height * .65, width, height * .35);
      }
    }
  }

  context.restore();
  context.globalAlpha = previousAlpha;
}

function drawPhotoTemplateTransition(
  context: CanvasRenderingContext2D,
  images: HTMLImageElement[],
  index: number,
  progress: number,
  width: number,
  height: number,
  templateId: PhotoVideoTemplateId,
) {
  if (progress <= 0) return;
  const template = PHOTO_VIDEO_TEMPLATES.find((item) => item.id === templateId) || PHOTO_VIDEO_TEMPLATES[0];
  const transition = template.transitions[index % template.transitions.length] || "fade";
  const p = Math.max(0, Math.min(1, progress));
  const drawNext = (opacity = 1) => drawPhotoTemplateFrame(context, images, index + 1, p * .16, width, height, templateId, opacity);

  context.save();
  if (transition === "fade-black" || transition === "fade-white") {
    const color = transition === "fade-white" ? "#ffffff" : "#000000";
    context.fillStyle = color;
    if (p < .5) {
      context.globalAlpha = p * 2;
      context.fillRect(0, 0, width, height);
    } else {
      context.fillRect(0, 0, width, height);
      drawNext((p - .5) * 2);
    }
  } else if (transition.startsWith("wipe-")) {
    context.beginPath();
    if (transition === "wipe-left") context.rect(0, 0, width * p, height);
    if (transition === "wipe-right") context.rect(width * (1 - p), 0, width * p, height);
    if (transition === "wipe-up") context.rect(0, 0, width, height * p);
    if (transition === "wipe-down") context.rect(0, height * (1 - p), width, height * p);
    context.clip();
    drawNext();
  } else if (transition.startsWith("slide-")) {
    if (transition === "slide-left") context.translate(width * (1 - p), 0);
    if (transition === "slide-right") context.translate(-width * (1 - p), 0);
    if (transition === "slide-up") context.translate(0, height * (1 - p));
    if (transition === "slide-down") context.translate(0, -height * (1 - p));
    drawNext();
  } else if (transition === "circle-open") {
    const radius = Math.hypot(width, height) * .52 * p;
    context.beginPath();
    context.arc(width / 2, height / 2, radius, 0, Math.PI * 2);
    context.clip();
    drawNext();
  } else if (transition === "diagonal") {
    context.beginPath();
    context.moveTo(0, 0);
    context.lineTo(Math.min(width, width * p * 1.7), 0);
    context.lineTo(Math.min(width, width * p * 1.7 - height * .35), height);
    context.lineTo(0, height);
    context.closePath();
    context.clip();
    drawNext();
  } else if (transition === "split-open") {
    context.beginPath();
    context.rect(width * .5 * (1 - p), 0, width * .5 * p, height);
    context.rect(width * .5, 0, width * .5 * p, height);
    context.clip();
    drawNext();
  } else if (transition === "checker") {
    const columns = 8;
    const rows = 12;
    const cellWidth = width / columns;
    const cellHeight = height / rows;
    context.beginPath();
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const threshold = ((row + column) % columns) / columns;
        if (p >= threshold) context.rect(column * cellWidth, row * cellHeight, cellWidth + 1, cellHeight + 1);
      }
    }
    context.clip();
    drawNext();
  } else if (transition === "zoom-in" || transition === "zoom-out") {
    const scale = transition === "zoom-in" ? .72 + p * .28 : 1.28 - p * .28;
    context.translate(width / 2, height / 2);
    context.scale(scale, scale);
    context.translate(-width / 2, -height / 2);
    drawNext(Math.min(1, p * 1.35));
  } else if (transition === "blur") {
    context.filter = `blur(${Math.round((1 - p) * 22)}px)`;
    drawNext(Math.min(1, p * 1.5));
  } else if (transition === "film-burn") {
    drawNext(Math.min(1, p * 1.4));
    const burn = context.createLinearGradient(0, height, width, 0);
    burn.addColorStop(0, "rgba(255,58,12,0)");
    burn.addColorStop(.48, "rgba(255,98,24,.86)");
    burn.addColorStop(.62, "rgba(255,239,184,.94)");
    burn.addColorStop(1, "rgba(255,190,58,0)");
    context.globalAlpha = Math.sin(p * Math.PI) * .82;
    context.fillStyle = burn;
    context.fillRect(0, 0, width, height);
  } else if (transition === "glitch") {
    const slices = 8;
    for (let slice = 0; slice < slices; slice += 1) {
      const sliceHeight = height / slices;
      context.save();
      context.beginPath();
      context.rect(0, slice * sliceHeight, width, sliceHeight + 1);
      context.clip();
      context.translate((slice % 2 ? 1 : -1) * (1 - p) * width * .08, 0);
      drawNext(Math.min(1, p * 1.5));
      context.restore();
    }
  } else {
    drawNext(p);
  }
  context.restore();
}

function drawPhotoCaption(
  context: CanvasRenderingContext2D,
  captions: ViralCaption[],
  elapsed: number,
  width: number,
  height: number,
) {
  const caption = captions.find((item) => elapsed >= item.start && elapsed < item.end);
  if (!caption?.text) return;
  const text = caption.text.replace(/\s+/g, "").trim();
  if (!text) return;
  const maxCharacters = width > height ? 22 : 14;
  const lines = Array.from({ length: Math.ceil(text.length / maxCharacters) }, (_, index) => text.slice(index * maxCharacters, (index + 1) * maxCharacters)).slice(0, 2);
  const fontSize = Math.round(Math.max(28, Math.min(width * .056, height * .042)));
  const lineHeight = Math.round(fontSize * 1.25);
  const bottom = Math.round(height * .17);
  context.save();
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.lineJoin = "round";
  context.font = `900 ${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
  context.strokeStyle = "rgba(0,0,0,.86)";
  context.lineWidth = Math.max(6, Math.round(fontSize * .16));
  context.fillStyle = "#ffffff";
  lines.forEach((line, index) => {
    const y = height - bottom - (lines.length - 1 - index) * lineHeight;
    context.strokeText(line, width / 2, y, width * .86);
    context.fillText(line, width / 2, y, width * .86);
  });
  context.restore();
}

type VideoWorkspace = "chooser" | "material" | "lip-sync" | "ai-benchmark" | "viral-edit" | "ai-director";

const VIDEO_WORKSPACES = new Set<VideoWorkspace>(["chooser", "material", "lip-sync", "ai-benchmark", "viral-edit", "ai-director"]);

function Video({ busy, action, onPointsChange, viralImportAsset }: { busy: boolean; action: () => void; onPointsChange: (points: number) => void; viralImportAsset?: { id: string; name: string; mediaUrl: string; contentType?: string } | null }) {
  const [workspace, setWorkspace] = useState<VideoWorkspace>("chooser");
  const [materialFiles, setMaterialFiles] = useState<VideoMaterialItem[]>([]);
  const [videoBrief, setVideoBrief] = useState("突出门店环境、专业服务和真实体验，制作一条自然、有节奏的门店介绍短视频。");
  const [videoPlatforms, setVideoPlatforms] = useState<string[]>(["视频号"]);
  const [videoDuration, setVideoDuration] = useState(15);
  const [videoResolution, setVideoResolution] = useState<"480p" | "720p">("720p");
  const [videoVersion, setVideoVersion] = useState<"Mini" | "快速" | "标准">("快速");
  const [savedMaterialFiles, setSavedMaterialFiles] = useState<VideoMaterialItem[]>([]);
  const [savedMaterialsLoading, setSavedMaterialsLoading] = useState(false);
  const [videoAnalysis, setVideoAnalysis] = useState<{ summary: string; platformInsight: string; missing: string[] } | null>(null);
  const [videoDirections, setVideoDirections] = useState<VideoDirection[]>([]);
  const [selectedDirection, setSelectedDirection] = useState("");
  const [campaignInfo, setCampaignInfo] = useState("");
  const [targetAudience, setTargetAudience] = useState("");
  const [storyboard, setStoryboard] = useState<VideoStoryboard | null>(null);
  const [videoAgentBusy, setVideoAgentBusy] = useState<"analyze" | "storyboard" | "generate" | "">("");
  const [videoAgentError, setVideoAgentError] = useState("");
  const [videoQuote, setVideoQuote] = useState<VideoQuote | null>(null);
  const [generatedVideoUrl, setGeneratedVideoUrl] = useState("");
  const [videoProgress, setVideoProgress] = useState("");
  const [photoTemplate, setPhotoTemplate] = useState<PhotoVideoTemplateId>("quiet-album");
  const [photoTemplateCategory, setPhotoTemplateCategory] = useState<"all" | PhotoVideoCategory>("business");
  const [photoRatio, setPhotoRatio] = useState<PhotoVideoRatio>("9:16");
  const [excludedPhotoMaterialIds, setExcludedPhotoMaterialIds] = useState<string[]>([]);
  const [photoRenderProgress, setPhotoRenderProgress] = useState(0);
  const [photoResultDuration, setPhotoResultDuration] = useState(0);
  const [commonVoices, setCommonVoices] = useState<CommonVoice[]>([]);
  const [commonVoicesLoading, setCommonVoicesLoading] = useState(false);
  const [photoVoiceId, setPhotoVoiceId] = useState("");
  const [photoScript, setPhotoScript] = useState("大家好，今天带大家看看我们的真实环境和特色服务。每一张图片，都是一次认真服务的记录。");
  const [photoSpeechSpeed, setPhotoSpeechSpeed] = useState(1);
  const [photoIncludeSpeech, setPhotoIncludeSpeech] = useState(true);
  const [photoIncludeSubtitles, setPhotoIncludeSubtitles] = useState(true);
  const [voiceSource, setVoiceSource] = useState<"saved" | "upload">("saved");
  const [selectedVoice, setSelectedVoice] = useState("");
  const [savedVoices, setSavedVoices] = useState<ClonedVoice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceAuditionBusy, setVoiceAuditionBusy] = useState(false);
  const [voiceAuditionUrls, setVoiceAuditionUrls] = useState<Record<string, string>>({});
  const [voiceError, setVoiceError] = useState("");
  const [voiceNotice, setVoiceNotice] = useState("");
  const voiceRecoveryStarted = useRef(false);
  const voiceRecoveryPending = useRef(false);
  const voicePreviewRequest = useRef(0);
  const voicePreviewConversionStarted = useRef(false);
  const voicePreviewConverted = useRef(false);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioFileName, setAudioFileName] = useState("");
  const [voiceUploadPreviewUrl, setVoiceUploadPreviewUrl] = useState("");
  const [voiceUploadPreviewError, setVoiceUploadPreviewError] = useState("");
  const [voiceUploadPreviewConverting, setVoiceUploadPreviewConverting] = useState(false);
  const [voiceName, setVoiceName] = useState("");
  const [voiceLanguage, setVoiceLanguage] = useState<"cn" | "en">("cn");
  const [uploadedVoiceReady, setUploadedVoiceReady] = useState(false);
  const [speechAudioReady, setSpeechAudioReady] = useState(false);
  const [speechAudioUrl, setSpeechAudioUrl] = useState("");
  const [speechAudioDuration, setSpeechAudioDuration] = useState(0);
  const [speechCaptions, setSpeechCaptions] = useState<ViralCaption[]>([]);
  const [scriptRewriteBusy, setScriptRewriteBusy] = useState(false);
  const [speechBusy, setSpeechBusy] = useState(false);
  const [speechError, setSpeechError] = useState("");
  const [script, setScript] = useState("大家好，今天带大家看看我们的门店环境和特色服务。");
  const [speechSpeed, setSpeechSpeed] = useState(1);
  const [benchmarkUrl, setBenchmarkUrl] = useState("");
  const [benchmarkTranscript, setBenchmarkTranscript] = useState("");
  const [benchmarkTitle, setBenchmarkTitle] = useState("");
  const [benchmarkAuthor, setBenchmarkAuthor] = useState("");
  const [benchmarkProfile, setBenchmarkProfile] = useState("");
  const [benchmarkDraft, setBenchmarkDraft] = useState("");
  const [benchmarkBusy, setBenchmarkBusy] = useState<"extract" | "rewrite" | "">("");
  const [benchmarkProgress, setBenchmarkProgress] = useState(0);
  const [benchmarkMessage, setBenchmarkMessage] = useState("");
  const [benchmarkError, setBenchmarkError] = useState("");
  const [lipVideoFile, setLipVideoFile] = useState<File | null>(null);
  const [lipVideoName, setLipVideoName] = useState("");
  const [lipVideoPreviewUrl, setLipVideoPreviewUrl] = useState("");
  const [lipVideoSize, setLipVideoSize] = useState({ width: 1080, height: 1920 });
  const [lipSyncBusy, setLipSyncBusy] = useState(false);
  const [lipSyncProgress, setLipSyncProgress] = useState(0);
  const [lipSyncError, setLipSyncError] = useState("");
  const [lipSyncResultUrl, setLipSyncResultUrl] = useState("");
  const [viralFiles, setViralFiles] = useState<string[]>([]);
  const [viralSourceFile, setViralSourceFile] = useState<File | null>(null);
  const [viralVideoPreviewUrl, setViralVideoPreviewUrl] = useState("");
  const [viralAnalyzed, setViralAnalyzed] = useState(false);
  const [viralTemplate, setViralTemplate] = useState("template-9");
  const [viralTemplates, setViralTemplates] = useState<ViralTemplateSpec[]>([]);
  const [viralTemplatesLoading, setViralTemplatesLoading] = useState(true);
  const [viralTemplatesError, setViralTemplatesError] = useState("");
  const [, setViralSourceResolution] = useState("1080 × 1920");
  const [viralTitle, setViralTitle] = useState("");
  const [, setViralSubtitle] = useState("");
  const [viralCaptions, setViralCaptions] = useState<ViralCaption[]>([]);
  const [viralCaptionsConfirmed, setViralCaptionsConfirmed] = useState(false);
  const [viralTranscriptDialogOpen, setViralTranscriptDialogOpen] = useState(false);
  const [viralReviewTitle, setViralReviewTitle] = useState("");
  const [viralReviewCaptions, setViralReviewCaptions] = useState<ViralCaption[]>([]);
  const [viralImportPreparing, setViralImportPreparing] = useState(false);
  const [viralTranscriptBusy, setViralTranscriptBusy] = useState(false);
  const [viralTranscriptProgress, setViralTranscriptProgress] = useState(0);
  const [viralTranscriptError, setViralTranscriptError] = useState("");
  const [viralProcessStarted, setViralProcessStarted] = useState(false);
  const [viralIncludeSfx, setViralIncludeSfx] = useState(true);
  const [viralIncludeBgm, setViralIncludeBgm] = useState(true);
  const [, setViralAnalysisSummary] = useState("");
  const [, setViralAnalysisMode] = useState<"ai" | "local" | "">("");
  const [, setViralProcessingEngine] = useState<"server" | "browser" | "">("");
  const [, setViralRenderer] = useState("");
  const [viralCoverUrl, setViralCoverUrl] = useState("");
  const [viralProcessBusy, setViralProcessBusy] = useState(false);
  const [viralFailed, setViralFailed] = useState(false);
  const [viralProgress, setViralProgress] = useState(0);
  const [viralStage, setViralStage] = useState("");
  const [viralError, setViralError] = useState("");
  const [viralResultUrl, setViralResultUrl] = useState("");
  const [, setViralResultBlob] = useState<Blob | null>(null);
  const [viralDownloadUrl, setViralDownloadUrl] = useState("");
  const [, setViralSaved] = useState(false);

  useEffect(() => {
    if (!viralTranscriptDialogOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setViralTranscriptDialogOpen(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [viralTranscriptDialogOpen]);

  function openViralTranscriptReview() {
    setViralReviewTitle(viralTitle);
    setViralReviewCaptions(viralCaptions.map((caption) => ({ ...caption })));
    setViralTranscriptDialogOpen(true);
  }

  function confirmViralTranscriptReview() {
    const title = viralReviewTitle.trim();
    const captions = viralReviewCaptions.map((caption) => ({ ...caption, text: caption.text.trim() }));
    if (!title || !captions.length || captions.some((caption) => !caption.text)) return;
    setViralTitle(title);
    setViralCaptions(captions);
    setViralSubtitle(captions.map((caption) => caption.text).join(" / ").slice(0, 120));
    setViralCaptionsConfirmed(true);
    setViralTranscriptError("");
    setViralTranscriptDialogOpen(false);
  }

  function openVideoWorkspace(nextWorkspace: VideoWorkspace) {
    try {
      window.sessionStorage.setItem(VIDEO_WORKSPACE_SESSION_KEY, nextWorkspace);
    } catch {
      // The workspace still works when browser storage is unavailable.
    }
    setWorkspace(nextWorkspace);
  }

  useEffect(() => {
    try {
      const savedWorkspace = window.sessionStorage.getItem(VIDEO_WORKSPACE_SESSION_KEY);
      if (savedWorkspace && VIDEO_WORKSPACES.has(savedWorkspace as VideoWorkspace)) {
        queueMicrotask(() => setWorkspace(savedWorkspace as VideoWorkspace));
      }
    } catch {
      // Keep the chooser when browser storage is unavailable.
    }
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [workspace]);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;

    const loadTemplates = async () => {
      try {
        const response = await fetch(`/api/catalog/templates?category=viral_video&_=${Date.now()}`, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache" },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("template registry unavailable");
        const data = await response.json() as { items?: Array<Record<string, unknown>> };
        const items = Array.isArray(data.items) ? data.items : [];
        const remoteTemplates = items.flatMap((item) => {
          const config = item.config && typeof item.config === "object" ? item.config as Record<string, unknown> : {};
          const id = typeof item.slug === "string" ? item.slug : typeof item.id === "string" ? item.id : "";
          if (!id) return [];
          const fallback = VIRAL_TEMPLATES.find((template) => template.id === id) ?? VIRAL_TEMPLATES[0];
          const transitionKey = typeof config.transitionKey === "string" ? config.transitionKey : typeof item.transition_key === "string" ? item.transition_key : fallback.transition;
          const allowedTransitions = new Set<ViralTemplateSpec["transition"]>(["fade", "flash", "zoom", "slide", "hard-cut-punch"]);
          const sfxKey = typeof config.sfxKey === "string" ? config.sfxKey : typeof item.sfx_key === "string" ? item.sfx_key : fallback.sfx;
          const allowedSfx = new Set<ViralTemplateSpec["sfx"]>(["soft", "click", "bright", "impact", "wood"]);
          const updatedAt = typeof item.updatedAt === "number" ? item.updatedAt : typeof item.updated_at === "number" ? item.updated_at : undefined;
          const previewUrl = typeof item.previewUrl === "string" && item.previewUrl ? item.previewUrl : typeof item.preview_url === "string" && item.preview_url ? item.preview_url : fallback.previewUrl;
          const coverUrl = typeof item.coverUrl === "string" && item.coverUrl ? item.coverUrl : typeof item.cover_url === "string" && item.cover_url ? item.cover_url : fallback.coverUrl;
          return [{
            ...fallback,
            id,
            name: typeof item.name === "string" && item.name.trim() ? item.name : fallback.name,
            previewUrl: revisionedTemplateMediaUrl(previewUrl, updatedAt),
            coverUrl: revisionedTemplateMediaUrl(coverUrl, updatedAt),
            accent: typeof config.accent === "string" ? config.accent : typeof item.accent === "string" ? item.accent : fallback.accent,
            titleColor: typeof config.titleColor === "string" ? config.titleColor : typeof item.title_color === "string" ? item.title_color : fallback.titleColor,
            panel: typeof config.panel === "string" ? config.panel : typeof item.panel === "string" ? item.panel : fallback.panel,
            titleEffect: typeof config.titleEffect === "string" ? config.titleEffect : typeof item.title_effect === "string" ? item.title_effect : fallback.titleEffect,
            subtitleEffect: typeof config.subtitleEffect === "string" ? config.subtitleEffect : typeof item.subtitle_effect === "string" ? item.subtitle_effect : fallback.subtitleEffect,
            transition: allowedTransitions.has(transitionKey as ViralTemplateSpec["transition"]) ? transitionKey as ViralTemplateSpec["transition"] : fallback.transition,
            transitionLabel: typeof config.transitionLabel === "string" ? config.transitionLabel : typeof item.transition_label === "string" ? item.transition_label : fallback.transitionLabel,
            sfx: allowedSfx.has(sfxKey as ViralTemplateSpec["sfx"]) ? sfxKey as ViralTemplateSpec["sfx"] : fallback.sfx,
            sfxLabel: typeof config.sfxLabel === "string" ? config.sfxLabel : typeof item.sfx_label === "string" ? item.sfx_label : fallback.sfxLabel,
            version: typeof item.version === "number" ? item.version : fallback.version,
            updatedAt,
            source: "admin-catalog",
            description: typeof item.description === "string" ? item.description : fallback.description,
          } satisfies ViralTemplateSpec];
        });
        if (disposed) return;
        // The admin catalog is the single source of truth. Its order is also
        // retained so a recently updated/published template appears immediately.
        const formalOrder = new Map(VIRAL_TEMPLATES.map((template, index) => [template.id, index]));
        remoteTemplates.sort((left, right) => (formalOrder.get(left.id) ?? 999) - (formalOrder.get(right.id) ?? 999));
        setViralTemplates(remoteTemplates);
        setViralTemplatesError("");
        setViralTemplatesLoading(false);
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        setViralTemplatesError("模板库暂时无法读取，请稍后刷新。");
        setViralTemplatesLoading(false);
      }
    };

    void loadTemplates();
    const interval = window.setInterval(() => void loadTemplates(), 10_000);
    const refreshOnFocus = () => void loadTemplates();
    const refreshOnStorage = (event: StorageEvent) => {
      if (event.key === TEMPLATE_LIBRARY_UPDATE_KEY) void loadTemplates();
    };
    const templateChannel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(TEMPLATE_LIBRARY_UPDATE_KEY);
    if (templateChannel) templateChannel.onmessage = () => void loadTemplates();
    window.addEventListener("focus", refreshOnFocus);
    window.addEventListener("storage", refreshOnStorage);
    document.addEventListener("visibilitychange", refreshOnFocus);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshOnFocus);
      window.removeEventListener("storage", refreshOnStorage);
      document.removeEventListener("visibilitychange", refreshOnFocus);
      templateChannel?.close();
    };
  }, []);

  useEffect(() => {
    if (!viralTemplates.length) return;
    if (!viralTemplates.some((template) => template.id === viralTemplate)) {
      queueMicrotask(() => setViralTemplate(viralTemplates[0].id));
    }
  }, [viralTemplate, viralTemplates]);

  useEffect(() => {
    if (!viralImportAsset) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setViralImportPreparing(true);
      openVideoWorkspace("viral-edit");
      setViralFiles([viralImportAsset.name]);
      setViralSourceFile(null);
      setViralVideoPreviewUrl(viralImportAsset.mediaUrl);
      setViralAnalyzed(true);
      setViralResultUrl("");
      setViralResultBlob(null);
      setViralDownloadUrl("");
      setViralSaved(false);
      setViralError("");
      setViralTranscriptError("");
      setViralProcessStarted(false);
      setViralCoverUrl("");
      setViralCaptions([]);
      setViralCaptionsConfirmed(false);
      setViralAnalysisSummary("");
      setViralAnalysisMode("");
      setViralProcessingEngine("");
      setViralRenderer("");
      setViralFailed(false);
    });
    window.sessionStorage.setItem("merchant-studio-viral-source", JSON.stringify({
      id: viralImportAsset.id,
      name: viralImportAsset.name,
      mediaUrl: viralImportAsset.mediaUrl,
    }));
    // Member assets used to remain only as a protected URL until the user
    // submitted the job. Preparing a real File now makes this path identical
    // to a local upload and avoids stale/partial asset streams being forwarded
    // to the cloud transcription worker.
    void (async () => {
      try {
        const response = await fetch(viralImportAsset.mediaUrl, {
          cache: "no-store",
          headers: { Accept: "video/*" },
        });
        if (!response.ok) throw new Error("会员视频读取失败");
        const blob = await response.blob();
        if (cancelled) return;
        const responseType = blob.type.split(";", 1)[0].trim();
        const contentType = responseType.startsWith("video/")
          ? responseType
          : viralImportAsset.contentType?.startsWith("video/")
            ? viralImportAsset.contentType
            : "video/mp4";
        const baseName = viralImportAsset.name.trim() || "member-video";
        const filename = /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(baseName)
          ? baseName
          : `${baseName}.mp4`;
        setViralSourceFile(new File([blob], filename, { type: contentType }));
      } catch {
        if (!cancelled) setViralTranscriptError("会员视频读取失败，请返回会员资产重新导入。 ");
      } finally {
        if (!cancelled) setViralImportPreparing(false);
      }
    })();
    return () => { cancelled = true; };
  }, [viralImportAsset]);

  useEffect(() => {
    if (viralImportAsset || viralSourceFile || viralVideoPreviewUrl) return;
    try {
      const saved = JSON.parse(window.sessionStorage.getItem("merchant-studio-viral-source") || "null") as { name?: string; mediaUrl?: string } | null;
      if (!saved?.name || !saved.mediaUrl || saved.mediaUrl.startsWith("blob:")) return;
      queueMicrotask(() => {
        setViralFiles([saved.name as string]);
        setViralVideoPreviewUrl(saved.mediaUrl as string);
        setViralAnalyzed(true);
      });
    } catch {
      window.sessionStorage.removeItem("merchant-studio-viral-source");
    }
  }, [viralImportAsset, viralSourceFile, viralVideoPreviewUrl]);

  useEffect(() => () => {
    if (lipVideoPreviewUrl) URL.revokeObjectURL(lipVideoPreviewUrl);
  }, [lipVideoPreviewUrl]);

  useEffect(() => () => {
    if (viralVideoPreviewUrl.startsWith("blob:")) URL.revokeObjectURL(viralVideoPreviewUrl);
  }, [viralVideoPreviewUrl]);

  useEffect(() => () => {
    if (viralResultUrl.startsWith("blob:")) URL.revokeObjectURL(viralResultUrl);
  }, [viralResultUrl]);

  async function cloneUploadedVoice(language: "cn" | "en") {
    if (!audioFile || !voiceName.trim() || voiceBusy) return;
    const cloneLanguage = language;
    setVoiceLanguage(cloneLanguage);
    setVoiceBusy(true);
    setVoiceError("");
    setVoiceNotice("");
    try {
      if (audioFile.size > 10 * 1024 * 1024) throw new Error("本地测试的音频文件不能超过 10MB。");
      const requestId = `voice_clone_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const form = new FormData();
      form.append("audio", audioFile, audioFile.name);
      form.append("name", voiceName.trim());
      form.append("language", cloneLanguage);
      form.append("requestId", requestId);
      const response = await fetch("/api/ai/voices", {
        method: "POST",
        body: form,
      });
      let data = await response.json() as {
        error?: string;
        warning?: string;
        voiceId?: string;
        name?: string;
        demoAudio?: string;
        state?: string;
        isFinal?: boolean;
        progress?: number;
        requestId?: string;
        voice?: ClonedVoice | null;
        wallet?: { points?: number };
      };
      if (!response.ok || !data.voiceId) throw new Error(data.error || "声音克隆任务创建失败，请稍后重试。");
      if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);
      const cloneVoiceId = data.voiceId;
      const cloneRequestId = data.requestId || requestId;
      const cloneName = data.name || voiceName.trim();
      const cloneDemoAudio = data.demoAudio || "";
      setVoiceNotice("声音样本已上传，正在克隆声音模型…");

      let attempts = 0;
      while (!data.isFinal && attempts < 100) {
        await new Promise((resolve) => window.setTimeout(resolve, 3000));
        const params = new URLSearchParams({
          voice_id: cloneVoiceId,
          request_id: cloneRequestId,
          name: cloneName,
          demo_audio: cloneDemoAudio,
          language: cloneLanguage,
        });
        const statusResponse = await fetch(`/api/ai/voices?${params}`, { cache: "no-store" });
        data = await statusResponse.json() as typeof data;
        if (!statusResponse.ok) throw new Error(data.error || "声音克隆状态查询失败。");
        if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);
        if (!data.isFinal) setVoiceNotice(`正在克隆声音模型${data.progress ? ` · ${data.progress}%` : "…"}`);
        attempts += 1;
      }
      if (!data.isFinal) throw new Error("声音克隆时间较长，请稍后重新进入“已有声音”查看。");
      if (data.state !== "success" || !data.voice?.voiceId) {
        throw new Error(data.error || "声音克隆失败，本次积分已自动退回。");
      }
      setSavedVoices((current) => [data.voice as ClonedVoice, ...current.filter((item) => item.voiceId !== data.voice?.voiceId)]);
      setSelectedVoice(data.voice.voiceId);
      setUploadedVoiceReady(true);
      setSpeechAudioReady(false);
      setSpeechAudioUrl("");
      setSpeechError("");
      setVoiceNotice(data.warning || `“${data.voice.name}”已成功克隆并保存。`);
      window.dispatchEvent(new CustomEvent("member-assets-updated"));
    } catch (error) {
      setUploadedVoiceReady(false);
      setVoiceError(error instanceof Error ? error.message : "声音克隆失败，请稍后重试。");
    } finally {
      setVoiceBusy(false);
    }
  }

  async function prepareVoiceAudioPreview(file: File | null) {
    const request = voicePreviewRequest.current + 1;
    voicePreviewRequest.current = request;
    setAudioFile(null);
    setAudioFileName(file?.name ?? "");
    setVoiceUploadPreviewUrl("");
    setVoiceUploadPreviewError("");
    setVoiceUploadPreviewConverting(false);
    voicePreviewConversionStarted.current = false;
    voicePreviewConverted.current = false;
    setUploadedVoiceReady(false);
    setSelectedVoice("");
    setSpeechAudioReady(false);
    setSpeechAudioUrl("");
    setSpeechError("");
    setVoiceError("");
    setVoiceNotice("");
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setVoiceUploadPreviewError("音频文件不能超过 10MB，请重新选择。");
      return;
    }
    try {
      const header = new Uint8Array(await file.slice(0, 32).arrayBuffer());
      if (voicePreviewRequest.current !== request) return;
      const ascii = String.fromCharCode(...header);
      const isMp4Audio = ascii.slice(4, 8) === "ftyp";
      const isWave = ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WAVE";
      const isOgg = ascii.startsWith("OggS");
      const isWebm = header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3;
      const isMp3 = ascii.startsWith("ID3") || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0);
      const extension = file.name.split(".").pop()?.toLowerCase();
      const normalizedType = isMp4Audio
        ? "audio/mp4"
        : isWave
          ? "audio/wav"
          : isOgg
            ? "audio/ogg"
            : isWebm
              ? "audio/webm"
              : isMp3
                ? "audio/mpeg"
                : file.type || (extension === "m4a" || extension === "mp4" ? "audio/mp4" : "audio/mpeg");
      const normalizedExtension = normalizedType === "audio/mp4"
        ? "m4a"
        : normalizedType === "audio/wav"
          ? "wav"
          : normalizedType === "audio/ogg"
            ? "ogg"
            : normalizedType === "audio/webm"
              ? "webm"
              : "mp3";
      const baseName = file.name.replace(/\.[^.]+$/, "") || "voice-sample";
      const normalizedFile = new File([file], `${baseName}.${normalizedExtension}`, {
        type: normalizedType,
        lastModified: file.lastModified,
      });
      setAudioFile(normalizedFile);
      setAudioFileName(file.name);
      const reader = new FileReader();
      reader.onload = () => {
        if (voicePreviewRequest.current !== request) return;
        if (typeof reader.result === "string") setVoiceUploadPreviewUrl(reader.result);
        else setVoiceUploadPreviewError("音频读取失败，请重新选择文件。");
      };
      reader.onerror = () => {
        if (voicePreviewRequest.current === request) setVoiceUploadPreviewError("音频读取失败，请重新选择文件。");
      };
      reader.readAsDataURL(normalizedFile);
    } catch {
      if (voicePreviewRequest.current === request) setVoiceUploadPreviewError("无法识别音频格式，请重新导出为 MP3、WAV 或 M4A。");
    }
  }

  async function convertVoiceAudioForBrowser() {
    const source = audioFile;
    if (!source || voiceUploadPreviewConverting || voicePreviewConversionStarted.current) return;
    const request = voicePreviewRequest.current;
    voicePreviewConversionStarted.current = true;
    setVoiceUploadPreviewConverting(true);
    setVoiceUploadPreviewError("");
    try {
      const { FFmpeg } = await import("@ffmpeg/ffmpeg");
      if (voicePreviewRequest.current !== request) return;
      const ffmpeg = new FFmpeg();
      let converted: Uint8Array | string;
      try {
        await ffmpeg.load(browserFfmpegLoadConfig());
        const inputName = `voice-input-${request}.m4a`;
        const outputName = `voice-output-${request}.mp3`;
        await ffmpeg.writeFile(inputName, new Uint8Array(await source.arrayBuffer()));
        const exitCode = await ffmpeg.exec(["-i", inputName, "-ac", "1", "-ar", "24000", "-b:a", "96k", outputName], 120_000);
        if (exitCode !== 0) throw new Error("音频转换失败");
        converted = await ffmpeg.readFile(outputName);
      } finally {
        ffmpeg.terminate();
      }
      if (!(converted instanceof Uint8Array) || !converted.byteLength) throw new Error("音频转换结果为空");
      if (voicePreviewRequest.current !== request) return;
      const baseName = source.name.replace(/\.[^.]+$/, "") || "voice-sample";
      const convertedBytes = new Uint8Array(converted.byteLength);
      convertedBytes.set(converted);
      const convertedFile = new File([convertedBytes.buffer], `${baseName}.mp3`, { type: "audio/mpeg" });
      const previewUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("兼容音频读取失败"));
        reader.onerror = () => reject(new Error("兼容音频读取失败"));
        reader.readAsDataURL(convertedFile);
      });
      if (voicePreviewRequest.current !== request) return;
      voicePreviewConverted.current = true;
      setAudioFile(convertedFile);
      setVoiceUploadPreviewUrl(previewUrl);
      setVoiceUploadPreviewError("");
    } catch (error) {
      if (voicePreviewRequest.current === request) {
        setVoiceUploadPreviewError(error instanceof Error
          ? `自动转换失败：${error.message}。请将录音导出为标准 MP3、WAV 或 AAC。`
          : "自动转换失败，请将录音导出为标准 MP3、WAV 或 AAC。");
      }
    } finally {
      if (voicePreviewRequest.current === request) setVoiceUploadPreviewConverting(false);
    }
  }

  async function auditionClonedVoice(voiceId: string) {
    const voice = savedVoices.find((item) => item.voiceId === voiceId);
    if (!voice || voiceAuditionBusy) return;
    setVoiceError("");

    const cachedUrl = voiceAuditionUrls[voiceId];
    if (cachedUrl) {
      const cachedAudio = new Audio(cachedUrl);
      void cachedAudio.play().catch(() => setVoiceError("试听音频暂时无法播放，请稍后重试。"));
      return;
    }

    setVoiceAuditionBusy(true);
    try {
      const projectName = "克隆声音试听";
      const auditionText = voice.language === "en" ? VOICE_AUDITION_TEXT_EN : VOICE_AUDITION_TEXT;
      const response = await fetch("/api/ai/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voiceId,
          voiceName: voice.name,
          text: auditionText,
          projectName,
          requestId: `voice_audition_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        }),
      });
      let data = await response.json() as {
        error?: string;
        taskId?: string | null;
        requestId?: string;
        state?: string;
        isFinal?: boolean;
        audioUrl?: string;
        estimatedPoints?: number;
        wallet?: { points?: number };
      };
      if (!response.ok) throw new Error(data.error || "试听音频生成失败，请稍后重试。");
      if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);

      let attempts = 0;
      while (!data.isFinal && data.taskId && attempts < 120) {
        await new Promise((resolve) => window.setTimeout(resolve, 3000));
        const params = new URLSearchParams({
          task_id: data.taskId,
          request_id: data.requestId || "",
          project_name: projectName,
          voice_name: voice.name,
          estimated_points: String(data.estimatedPoints || 1),
        });
        const statusResponse = await fetch(`/api/ai/speech?${params}`, { cache: "no-store" });
        data = await statusResponse.json() as typeof data;
        if (!statusResponse.ok) throw new Error(data.error || "试听音频状态查询失败。");
        if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);
        attempts += 1;
      }
      if (!data.isFinal) throw new Error("试听音频生成时间较长，请稍后再试。");
      if (data.state === "failed" || !data.audioUrl) throw new Error(data.error || "试听音频生成失败，请稍后再试。");

      setVoiceAuditionUrls((current) => ({ ...current, [voiceId]: data.audioUrl as string }));
      window.dispatchEvent(new CustomEvent("member-assets-updated"));
      const audio = new Audio(data.audioUrl);
      void audio.play().catch(() => setVoiceError("试听音频已经生成，请再次点击“试听声音”播放。"));
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : "试听音频生成失败，请稍后重试。");
    } finally {
      setVoiceAuditionBusy(false);
    }
  }

  async function rewriteSpeechScript() {
    const requirement = script.trim();
    if (requirement.length < 2 || scriptRewriteBusy) {
      if (requirement.length < 2) setSpeechError("请先在文本框中输入口播主题或具体要求。");
      return;
    }
    setScriptRewriteBusy(true);
    setSpeechError("");
    setSpeechAudioReady(false);
    setSpeechAudioUrl("");
    setLipSyncResultUrl("");
    setLipSyncError("");
    try {
      const response = await fetch("/api/ai/speech-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requirement,
          requestId: `speech_script_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        }),
      });
      const data = await response.json() as {
        error?: string;
        script?: string;
        wallet?: { points?: number };
      };
      if (!response.ok || !data.script?.trim()) {
        throw new Error(data.error || "口播文案生成失败，请稍后重试。");
      }
      setScript(data.script.trim());
      if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);
    } catch (error) {
      setSpeechError(error instanceof Error ? error.message : "口播文案生成失败，请稍后重试。");
    } finally {
      setScriptRewriteBusy(false);
    }
  }

  async function extractBenchmarkTranscript() {
    if (!benchmarkUrl.trim() || benchmarkBusy) {
      if (!benchmarkUrl.trim()) setBenchmarkError("请先粘贴抖音公开视频链接。");
      return;
    }
    setBenchmarkBusy("extract");
    setBenchmarkProgress(1);
    setBenchmarkMessage("正在提交公开链接…");
    setBenchmarkError("");
    setBenchmarkTranscript("");
    setBenchmarkTitle("");
    setBenchmarkAuthor("");
    setBenchmarkDraft("");
    try {
      const createResponse = await fetch("/api/ai/douyin-transcript", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shareUrl: benchmarkUrl.trim() }),
      });
      const createData = await createResponse.json().catch(() => null) as (ViralWorkerJob & { error?: string }) | null;
      if (!createResponse.ok || !createData?.id) throw new Error(createData?.error || "对标链接读取失败，请检查链接后重试。");

      let job = createData;
      const deadline = Date.now() + 10 * 60 * 1000;
      while (job.state !== "success" && job.state !== "failed") {
        if (Date.now() > deadline) throw new Error("对标文案提取超过10分钟，任务仍可能在后台继续，请稍后重试。");
        await new Promise((resolve) => window.setTimeout(resolve, 1_500));
        const statusResponse = await fetch(`/api/ai/douyin-transcript?jobId=${encodeURIComponent(job.id)}`, { cache: "no-store" });
        const statusData = await statusResponse.json().catch(() => null) as (ViralWorkerJob & { error?: string }) | null;
        if (!statusResponse.ok || !statusData?.id) throw new Error(statusData?.error || "读取对标文案进度失败。");
        job = statusData;
        setBenchmarkProgress(Math.max(1, Math.min(100, Number(job.progress) || 1)));
        setBenchmarkMessage(job.message || "正在提取口播文案…");
      }
      if (job.state === "failed") throw new Error(job.error || job.message || "对标文案提取失败。");
      const transcript = (job.transcript || "").trim() || (job.captions || []).map((item) => item.text.trim()).filter(Boolean).join("，");
      if (transcript.length < 10) throw new Error("没有从该视频中读取到可用口播，请更换清晰、有人声的公开视频。");
      setBenchmarkTranscript(transcript);
      setBenchmarkTitle((job.benchmark_title || job.title || "对标视频").trim());
      setBenchmarkAuthor((job.benchmark_author || "").trim());
      setBenchmarkProgress(100);
      setBenchmarkMessage("对标口播已提取，可以开始改写。");
    } catch (error) {
      setBenchmarkError(error instanceof Error ? error.message : "对标文案提取失败，请稍后重试。");
      setBenchmarkProgress(0);
      setBenchmarkMessage("");
    } finally {
      setBenchmarkBusy("");
    }
  }

  async function rewriteBenchmarkScript() {
    if (benchmarkTranscript.trim().length < 10 || benchmarkProfile.trim().length < 5 || benchmarkBusy) {
      if (benchmarkProfile.trim().length < 5) setBenchmarkError("请先填写你自己的业务、产品或个人资料。");
      return;
    }
    setBenchmarkBusy("rewrite");
    setBenchmarkError("");
    try {
      const response = await fetch("/api/ai/speech-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "benchmark",
          sourceScript: benchmarkTranscript,
          businessProfile: benchmarkProfile,
          requestId: `benchmark_script_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        }),
      });
      const data = await response.json() as { error?: string; script?: string; wallet?: { points?: number } };
      if (!response.ok || !data.script?.trim()) throw new Error(data.error || "AI 对标改写失败，请稍后重试。");
      setBenchmarkDraft(data.script.trim());
      if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);
    } catch (error) {
      setBenchmarkError(error instanceof Error ? error.message : "AI 对标改写失败，请稍后重试。");
    } finally {
      setBenchmarkBusy("");
    }
  }

  function confirmBenchmarkScript() {
    const confirmed = benchmarkDraft.trim();
    if (!confirmed) {
      setBenchmarkError("请先生成或填写一版可用的改写文案。");
      return;
    }
    setScript(confirmed);
    setSpeechAudioReady(false);
    setSpeechAudioUrl("");
    setSpeechError("");
    setLipSyncResultUrl("");
    setLipSyncError("");
    openVideoWorkspace("lip-sync");
  }

  async function generateSpeechAudio() {
    if (!selectedVoice || !script.trim() || speechBusy) return;
    setSpeechCaptions([]);
    const selectedVoiceRecord = savedVoices.find((item) => item.voiceId === selectedVoice);
    const containsChinese = /[\u3400-\u9fff]/.test(script);
    const containsEnglish = /[A-Za-z]/.test(script);
    if (selectedVoiceRecord?.language === "en" && containsChinese && !containsEnglish) {
      setSpeechError("当前选择的是英文音色，请输入英文文案或切换中文音色。");
      return;
    }
    if (selectedVoiceRecord?.language !== "en" && containsEnglish && !containsChinese) {
      setSpeechError("当前选择的是中文音色，请切换英文音色后再生成英文口播。");
      return;
    }
    setSpeechBusy(true);
    setSpeechError("");
    setSpeechAudioReady(false);
    setSpeechAudioUrl("");
    setSpeechAudioDuration(0);
    setLipSyncResultUrl("");
    setLipSyncError("");
    try {
      const voice = savedVoices.find((item) => item.voiceId === selectedVoice);
      const projectName = "口播音频";
      const response = await fetch("/api/ai/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voiceId: selectedVoice,
          voiceName: voice?.name || voiceName || "克隆声音",
          text: script.trim(),
          speed: speechSpeed,
          projectName,
          requestId: `speech_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        }),
      });
      let data = await response.json() as {
        error?: string;
        taskId?: string | null;
        requestId?: string;
        state?: string;
        isFinal?: boolean;
        audioUrl?: string;
        duration?: number;
        captions?: ViralCaption[];
        estimatedPoints?: number;
        wallet?: { points?: number };
      };
      if (!response.ok) throw new Error(data.error || "口播音频生成失败，请稍后重试。");
      if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);

      let attempts = 0;
      while (!data.isFinal && data.taskId && attempts < 120) {
        await new Promise((resolve) => window.setTimeout(resolve, 3000));
        const params = new URLSearchParams({
          task_id: data.taskId || "",
          request_id: data.requestId || "",
          project_name: projectName,
          voice_name: voice?.name || voiceName || "克隆声音",
          estimated_points: String(data.estimatedPoints || 1),
        });
        const statusResponse = await fetch(`/api/ai/speech?${params}`, { cache: "no-store" });
        data = await statusResponse.json() as typeof data;
        if (!statusResponse.ok) throw new Error(data.error || "口播音频状态查询失败。");
        if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);
        attempts += 1;
      }
      if (!data.isFinal) throw new Error("口播音频生成时间较长，请稍后重试。");
      if (data.state === "failed" || !data.audioUrl) throw new Error(data.error || "口播音频生成失败，请重新提交。");
      setSpeechAudioUrl(data.audioUrl);
      setSpeechAudioDuration(Math.max(0, Number(data.duration) || 0));
      setSpeechCaptions(Array.isArray(data.captions) ? normalizeViralCaptionsForReview(data.captions) : []);
      setSpeechAudioReady(true);
      window.dispatchEvent(new CustomEvent("member-assets-updated"));
    } catch (error) {
      setSpeechAudioReady(false);
      setSpeechError(error instanceof Error ? error.message : "口播音频生成失败，请稍后重试。");
    } finally {
      setSpeechBusy(false);
    }
  }

  async function generateLipSyncVideo() {
    if (!lipVideoFile || !speechAudioUrl || lipSyncBusy) return;
    setLipSyncBusy(true);
    setLipSyncError("");
    setLipSyncProgress(0);
    setLipSyncResultUrl("");
    try {
      const audioResponse = await fetch(speechAudioUrl, { cache: "no-store" });
      if (!audioResponse.ok) throw new Error("口播音频读取失败，请重新生成音频。");
      const audioBlob = await audioResponse.blob();
      const isWav = audioBlob.type.includes("wav");
      const audioFileForUpload = new File([audioBlob], isWav ? "speech.wav" : "speech.mp3", { type: audioBlob.type || "audio/mpeg" });
      const form = new FormData();
      form.append("video", lipVideoFile, lipVideoFile.name);
      form.append("audio", audioFileForUpload, audioFileForUpload.name);
      form.append("width", String(lipVideoSize.width));
      form.append("height", String(lipVideoSize.height));
      form.append("audioDuration", String(speechAudioDuration));
      form.append("projectName", "对口型视频");
      form.append("requestId", `lip_sync_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`);

      const response = await fetch("/api/ai/lip-sync", { method: "POST", body: form });
      const responseText = await response.text();
      let data: {
        error?: string;
        taskId?: string;
        requestId?: string;
        projectName?: string;
        state?: string;
        isFinal?: boolean;
        progress?: number;
        videoUrl?: string;
        wallet?: { points?: number };
        estimatedPoints?: number;
        audioDuration?: number;
      };
      try {
        data = responseText ? JSON.parse(responseText) as typeof data : {};
      } catch {
        if (response.status === 413) {
          throw new Error("视频上传失败：文件超过当前服务允许的大小，请压缩到 200MB 以内后重试。");
        }
        throw new Error(responseText.trim() || `对口型接口返回异常（${response.status}）。`);
      }
      if (!response.ok || !data.taskId) throw new Error(data.error || "对口型任务创建失败，请稍后重试。");
      if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);

      let attempts = 0;
      while (!data.isFinal && attempts < 240) {
        await new Promise((resolve) => window.setTimeout(resolve, 5000));
        const params = new URLSearchParams({
          task_id: data.taskId || "",
          request_id: data.requestId || "",
          project_name: data.projectName || "对口型视频",
        });
        const statusResponse = await fetch(`/api/ai/lip-sync?${params}`, { cache: "no-store" });
        data = await statusResponse.json() as typeof data;
        if (!statusResponse.ok) throw new Error(data.error || "对口型任务状态查询失败。");
        setLipSyncProgress(Math.max(0, Math.min(100, Number(data.progress) || 0)));
        if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);
        attempts += 1;
      }
      if (!data.isFinal) throw new Error("对口型任务仍在处理中，请稍后重新进入会员资产查看。");
      if (data.state !== "success" || !data.videoUrl) throw new Error(data.error || "对口型视频生成失败，本次积分已自动退回。");
      setLipSyncProgress(100);
      // The provider URL is playable as soon as the task finishes. Do not wait
      // for the whole MP4 to be copied through the application server first.
      setLipSyncResultUrl(data.videoUrl);
      const completedTaskId = data.taskId || "";
      void fetch("/api/member/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: stableAssetId(`lip-sync|${completedTaskId || data.videoUrl}`),
          projectName: "对口型视频",
          kind: "video",
          name: "对口型成片",
          sourceUrl: data.videoUrl,
          sourceTaskId: completedTaskId ? `chanjing_${completedTaskId}` : "",
          createdAt: Date.now(),
        }),
      }).then((archiveResponse) => {
        if (archiveResponse.ok) window.dispatchEvent(new CustomEvent("member-assets-updated"));
      }).catch(() => undefined);
    } catch (error) {
      setLipSyncError(error instanceof Error ? error.message : "对口型视频生成失败，请稍后重试。");
    } finally {
      setLipSyncBusy(false);
    }
  }

  function openLipSyncResultInViralEditor() {
    if (!lipSyncResultUrl || lipSyncBusy) return;
    const sourceName = "对口型成片.mp4";
    const confirmedCaptions = normalizeViralCaptionsForReview(speechCaptions);
    openVideoWorkspace("viral-edit");
    setViralFiles([sourceName]);
    setViralSourceFile(null);
    setViralVideoPreviewUrl(lipSyncResultUrl);
    setViralSourceResolution(`${lipVideoSize.width} × ${lipVideoSize.height}`);
    setViralAnalyzed(true);
    setViralTitle(viralTitleFromKnownScript(script));
    setViralSubtitle(confirmedCaptions.map((caption) => caption.text).join(" / ").slice(0, 120));
    setViralCaptions(confirmedCaptions);
    setViralCaptionsConfirmed(Boolean(confirmedCaptions.length));
    setViralAnalysisSummary(confirmedCaptions.length ? "已复用对口型口播的原始字幕时间轴，无需再次识别整条视频。" : "");
    setViralAnalysisMode(confirmedCaptions.length ? "ai" : "");
    setViralProcessingEngine("");
    setViralRenderer("");
    setViralCoverUrl("");
    setViralProcessBusy(false);
    setViralFailed(false);
    setViralProgress(0);
    setViralStage("");
    setViralError("");
    setViralTranscriptError("");
    setViralTranscriptProgress(confirmedCaptions.length ? 100 : 0);
    setViralProcessStarted(false);
    setViralResultUrl("");
    setViralResultBlob(null);
    setViralDownloadUrl("");
    setViralSaved(false);
    window.sessionStorage.setItem("merchant-studio-viral-source", JSON.stringify({
      id: `lip-sync-${Date.now()}`,
      name: sourceName,
      mediaUrl: lipSyncResultUrl,
    }));
  }

  function openDirectorResultInViralEditor(source: { name: string; mediaUrl: string }) {
    if (!source.mediaUrl) return;
    openVideoWorkspace("viral-edit");
    setViralFiles([source.name]);
    setViralSourceFile(null);
    setViralVideoPreviewUrl(source.mediaUrl);
    setViralAnalyzed(true);
    setViralTitle("");
    setViralSubtitle("");
    setViralCaptions([]);
    setViralCaptionsConfirmed(false);
    setViralTranscriptDialogOpen(false);
    setViralReviewTitle("");
    setViralReviewCaptions([]);
    setViralAnalysisSummary("");
    setViralAnalysisMode("");
    setViralProcessingEngine("");
    setViralRenderer("");
    setViralCoverUrl("");
    setViralProcessBusy(false);
    setViralFailed(false);
    setViralProgress(0);
    setViralStage("");
    setViralError("");
    setViralTranscriptError("");
    setViralProcessStarted(false);
    setViralResultUrl("");
    setViralResultBlob(null);
    setViralDownloadUrl("");
    setViralSaved(false);
    window.sessionStorage.setItem("merchant-studio-viral-source", JSON.stringify({ id: `ai-director-${Date.now()}`, ...source }));
  }

  async function addMaterialFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []).slice(0, Math.max(0, 12 - materialFiles.length));
    event.target.value = "";
    const items = await Promise.all(files.map(async (file) => {
      const image = file.type.startsWith("image/");
      const previewUrl = image ? await blobToAiReferenceDataUrl(file) : URL.createObjectURL(file);
      return {
        id: `${file.name}-${file.size}-${file.lastModified}`,
        name: file.name,
        type: image ? "image" as const : "video" as const,
        previewUrl,
        aiImage: image ? previewUrl : "",
      };
    }));
    setMaterialFiles((current) => [...current, ...items].slice(0, 12));
    setVideoAnalysis(null);
    setVideoDirections([]);
    setSelectedDirection("");
    setStoryboard(null);
    setGeneratedVideoUrl("");
  }

  function addViralFiles(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setViralFiles([file.name]);
    setViralSourceFile(file);
    setViralImportPreparing(false);
    setViralVideoPreviewUrl(URL.createObjectURL(file));
    setViralAnalyzed(true);
    setViralResultUrl("");
    setViralResultBlob(null);
    setViralDownloadUrl("");
    setViralSaved(false);
    setViralError("");
    setViralProgress(0);
    setViralStage("");
    setViralCoverUrl("");
    setViralTitle("");
    setViralSubtitle("");
    setViralCaptions([]);
    setViralCaptionsConfirmed(false);
    setViralAnalysisSummary("");
    setViralAnalysisMode("");
    setViralProcessingEngine("");
    setViralFailed(false);
    setViralTranscriptError("");
    setViralProcessStarted(false);
    window.sessionStorage.removeItem("merchant-studio-viral-source");
    event.target.value = "";
  }

  async function extractViralTranscript() {
    if (!viralVideoPreviewUrl || viralTranscriptBusy || viralProcessBusy) return;
    setViralTranscriptBusy(true);
    setViralTranscriptProgress(1);
    setViralTranscriptError("");
    setViralAnalysisSummary("");
    try {
      // Do not block the real upload behind a separate health probe. The
      // worker can be healthy while a cold-started /health request exceeds a
      // browser timeout, which previously produced a false "not connected"
      // error. The transcription request below is the authoritative check and
      // returns the worker's actual error when it cannot accept the video.
      const createForm = async (renderFallback = false) => {
        const form = new FormData();
        await appendWorkerSource(form);
        form.append("template_id", viralTemplate);
        // Interactive review only needs the precise ASR timeline here. Title,
        // correction and semantic layout are completed once by the app below.
        form.append("fast_mode", "1");
        if (renderFallback) form.append("title", "");
        return form;
      };
      let compatibilityMode = false;
      let createResponse = await fetch(`${videoWorkerBaseUrl()}/v1/transcriptions`, {
        method: "POST",
        body: await createForm(),
      });
      // 旧版云端服务还没有独立口播接口。先兼容已有的任务接口取得
      // 真实语音时间轴，之后仍统一交给站内大模型校对和整句整理。
      if (createResponse.status === 404 || createResponse.status === 405) {
        compatibilityMode = true;
        setViralTranscriptProgress(8);
        createResponse = await fetch(`${videoWorkerBaseUrl()}/v1/jobs`, {
          method: "POST",
          body: await createForm(true),
        });
      }
      const createText = await createResponse.text().catch(() => "");
      let createData: ViralWorkerJob | { detail?: string } | null = null;
      try {
        createData = createText ? JSON.parse(createText) as ViralWorkerJob | { detail?: string } : null;
      } catch {
        createData = null;
      }
      if (!createResponse.ok || !createData || !("id" in createData)) {
        const detail = createData && "detail" in createData && typeof createData.detail === "string" ? createData.detail : "";
        if (detail && detail !== "Not Found") throw new Error(detail);
        if (createResponse.status === 413) {
          throw new Error("原片超过网页端上传限制，请压缩视频后重试，或联系管理员提高服务器上传上限。");
        }
        if (createResponse.status === 502 || createResponse.status === 503 || createResponse.status === 504) {
          throw new Error("视频识别服务暂时无法连接，请稍后重试。");
        }
        throw new Error(`视频识别请求失败（HTTP ${createResponse.status || "网络异常"}），请稍后重试。`);
      }
      let job = createData;
      const deadline = Date.now() + 5 * 60 * 1000;
      while (job.state !== "success" && job.state !== "failed") {
        if (Date.now() > deadline) throw new Error("口播文案提取超过5分钟，任务仍可在后台继续，请稍后重新查看。");
        await new Promise((resolve) => window.setTimeout(resolve, 750));
        const statusResponse = await fetch(`${videoWorkerBaseUrl()}/v1/jobs/${job.id}`, { cache: "no-store" });
        const statusData = await statusResponse.json().catch(() => null) as ViralWorkerJob | { detail?: string } | null;
        if (!statusResponse.ok || !statusData || !("id" in statusData)) {
          throw new Error(statusData && "detail" in statusData ? statusData.detail || "读取口播提取进度失败。" : "读取口播提取进度失败。");
        }
        job = statusData;
        setViralTranscriptProgress(Math.max(1, Math.min(100, Number(job.progress) || 1)));
      }
      const captions = Array.isArray(job.captions)
        ? job.captions.filter((caption) => caption && typeof caption.text === "string" && Number.isFinite(caption.start) && Number.isFinite(caption.end))
        : [];
      // 旧版云端接口会在完成语音识别后继续尝试渲染成片。即使渲染环境
      // 失败，已经写入任务的真实口播时间轴仍然有效，应继续交给大模型整理。
      if (job.state === "failed" && !captions.length) {
        const detail = job.error || job.message || "口播文案提取失败。";
        const friendlyDetail = /EACCES|remotion|\.cache|Not Found/i.test(detail)
          ? "云端口播识别服务尚未完成升级，请更新视频服务后重试。"
          : detail;
        throw new Error(friendlyDetail);
      }
      setViralTranscriptProgress(88);
      const directVideoAi = [
        "direct-video-multimodal",
      ].includes(job.analysis_mode || "");
      const frames: string[] = [];
      const sourceDuration = Math.max(1, Number(job.metadata?.duration) || 60);

      // Title generation, phrase segmentation and timestamp alignment all
      // finish as part of "核对标题与口播". Applying a template later must
      // only consume the confirmed result and must not regroup the captions.
      let sentenceCaptions = normalizeViralCaptionsForReview(captions);
      let aiSummary = directVideoAi
        ? job.analysis_summary || "多模态大模型已直接读取视频并完成口播整理。"
        : "";
      let aiTitle = job.title || "";
      if (!directVideoAi) {
        try {
          const aiResponse = await fetch("/api/ai/viral-transcript", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ captions, frames, duration: sourceDuration }),
          });
          const aiData = await aiResponse.json() as {
            error?: string;
            title?: string;
            summary?: string;
            captions?: ViralCaption[];
            degraded?: boolean;
          };
          if (!aiResponse.ok) throw new Error(aiData.error || "大模型口播整理失败。");
          if (Array.isArray(aiData.captions) && aiData.captions.length) {
            sentenceCaptions = aiData.captions;
          }
          aiTitle = aiData.title || "";
          aiSummary = aiData.summary || "大模型已完成口播错字校正与完整句整理。";
        } catch (error) {
          aiSummary = `${error instanceof Error ? error.message : "大模型校对暂时不可用"} 已保留真实语音识别结果，并按完整句整理。`;
        }
      }
      setViralCaptions(sentenceCaptions);
      setViralCaptionsConfirmed(false);
      setViralSubtitle(sentenceCaptions.map((caption) => caption.text).join(" / ").slice(0, 120));
      const transcriptLanguage = viralSpeechLanguage(sentenceCaptions.map((caption) => caption.text).join(" "));
      const titleCandidate = aiTitle || job.title || "";
      const languageMatchedTitle = titleCandidate && viralSpeechLanguage(titleCandidate) === transcriptLanguage
        ? titleCandidate
        : "";
      const localEnglishTitle = transcriptLanguage === "en"
        ? sentenceCaptions.find((caption) => caption.text.trim().split(/\s+/).length >= 3)?.text.replace(/[.!?]+$/g, "") || "English Video Highlights"
        : "口播内容提炼";
      const resolvedTitle = languageMatchedTitle || localEnglishTitle;
      setViralTitle(resolvedTitle);
      setViralReviewTitle(resolvedTitle);
      setViralReviewCaptions(sentenceCaptions.map((caption) => ({ ...caption })));
      setViralTranscriptDialogOpen(true);
      setViralAnalysisMode("ai");
      setViralAnalysisSummary(`${aiSummary} 已整理为 ${sentenceCaptions.length} 条字幕短句${compatibilityMode ? "；当前云端旧版已由兼容通道完成识别" : ""}。修改后将按当前文本生成字幕。`);
      setViralTranscriptProgress(100);
    } catch (error) {
      setViralTranscriptError(error instanceof Error ? error.message : "口播文案提取失败，请稍后重试。");
    } finally {
      setViralTranscriptBusy(false);
    }
  }

  async function seekViralVideo(video: HTMLVideoElement, time: number) {
    const target = Math.max(0, Math.min(Math.max(0, (video.duration || 0) - 0.05), time));
    if (Math.abs(video.currentTime - target) < 0.03) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("读取原片关键帧超时。"));
      }, 8_000);
      const cleanup = () => {
        window.clearTimeout(timeout);
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onError);
      };
      const onSeeked = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("原片关键帧读取失败。"));
      };
      video.addEventListener("seeked", onSeeked, { once: true });
      video.addEventListener("error", onError, { once: true });
      video.currentTime = target;
    });
  }

  function viralFrameDataUrl(video: HTMLVideoElement, maxWidth = 448, quality = 0.62) {
    const sourceWidth = Math.max(1, video.videoWidth);
    const sourceHeight = Math.max(1, video.videoHeight);
    const scale = Math.min(1, maxWidth / sourceWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return "";
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", quality);
  }

  async function extractViralKeyframes(video: HTMLVideoElement) {
    const duration = Math.max(1, video.duration || 1);
    const times = [0.08, duration * 0.5, Math.max(0.08, duration - 0.16)];
    const frames: string[] = [];
    for (const time of times) {
      await seekViralVideo(video, time);
      const frame = viralFrameDataUrl(video);
      if (frame) frames.push(frame);
    }
    await seekViralVideo(video, 0.05);
    const cover = viralFrameDataUrl(video, 900, 0.78);
    if (cover) setViralCoverUrl(cover);
    return { frames, cover };
  }

  function scheduleViralSfx(
    audioContext: AudioContext,
    destination: AudioNode,
    template: ViralTemplateSpec,
    duration: number,
  ) {
    const startAt = audioContext.currentTime + 0.08;
    const cues = (template.effectCadence === "opening"
      ? [0]
      : [0, ...Array.from({ length: Math.max(0, Math.floor(duration / 3.2)) }, (_, index) => (index + 1) * 3.2)])
      .filter((time) => time < duration);
    cues.forEach((offset, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const cueAt = startAt + offset;
      const isOpening = index === 0;
      const frequencies = template.sfx === "impact"
        ? [isOpening ? 150 : 190, 72]
        : template.sfx === "bright"
          ? [isOpening ? 760 : 620, 1080]
          : template.sfx === "click"
            ? [520, 310]
            : template.sfx === "wood"
              ? [360, 240]
              : [360, 540];
      oscillator.type = template.sfx === "impact" ? "sine" : template.sfx === "bright" ? "triangle" : "sine";
      oscillator.frequency.setValueAtTime(frequencies[0], cueAt);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(40, frequencies[1]), cueAt + (isOpening ? 0.2 : 0.11));
      gain.gain.setValueAtTime(0.0001, cueAt);
      gain.gain.exponentialRampToValueAtTime(template.sfx === "impact" ? 0.12 : 0.055, cueAt + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, cueAt + (isOpening ? 0.24 : 0.14));
      oscillator.connect(gain).connect(destination);
      oscillator.start(cueAt);
      oscillator.stop(cueAt + (isOpening ? 0.26 : 0.16));
    });
  }

  function drawViralFrame(
    context: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    width: number,
    height: number,
    time: number,
    duration: number,
    content: { title: string; captions: ViralCaption[] },
    template: ViralTemplateSpec,
  ) {
    const sourceRatio = video.videoWidth / video.videoHeight;
    const outputRatio = width / height;
    let sourceWidth = video.videoWidth;
    let sourceHeight = video.videoHeight;
    let sourceX = 0;
    let sourceY = 0;
    if (sourceRatio > outputRatio) {
      sourceWidth = video.videoHeight * outputRatio;
      sourceX = (video.videoWidth - sourceWidth) / 2;
    } else {
      sourceHeight = video.videoWidth / outputRatio;
      sourceY = (video.videoHeight - sourceHeight) / 2;
    }
    const preserveSourceEdit = template.transitionLabel === "保留原片剪辑";
    const transitionPhase = time % 3.2;
    const transitionStrength = preserveSourceEdit ? 0 : transitionPhase < 0.18 ? 1 - transitionPhase / 0.18 : 0;
    const zoom = template.transition === "zoom" ? 1 + transitionStrength * 0.045 : 1;
    const slide = template.transition === "slide" ? transitionStrength * width * 0.035 : 0;
    context.save();
    context.translate(width / 2 + slide, height / 2);
    context.scale(zoom, zoom);
    context.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, -width / 2, -height / 2, width, height);
    context.restore();
    if (template.transition === "flash" && transitionStrength > 0) {
      context.fillStyle = `rgba(255,245,214,${transitionStrength * 0.22})`;
      context.fillRect(0, 0, width, height);
    }

    const padding = Math.round(width * 0.055);
    const isBoldYellowWhite = template.id === "template-10";
    const titleSize = Math.max(26, Math.round(width * (isBoldYellowWhite ? 0.078 : 0.08)));
    const subtitleSize = Math.max(17, Math.round(width * (isBoldYellowWhite ? 0.052 : 0.043)));
    const currentCaption = content.captions.find((caption) => time >= caption.start && time < caption.end);
    const introDuration = template.titleTiming === "persistent"
      ? Math.max(1.8, duration - 0.05)
      : isBoldYellowWhite
        ? Math.min(2.4, Math.max(1.8, duration - 0.05))
        : Math.min(3.2, Math.max(1.8, duration * 0.24));
    const introProgress = Math.min(1, Math.max(0, time / 0.38));

    context.save();
    if (time <= introDuration) {
      const title = content.title.trim() || "真实体验";
      const forceTwoLines = isBoldYellowWhite && title.length >= 6;
      const splitAt = title.length > 9 || forceTwoLines
        ? Math.max(3, Math.min(title.length - 3, Math.round(title.length / 2)))
        : title.length;
      const titleLines = title.length > 9 || forceTwoLines
        ? [title.slice(0, splitAt), title.slice(splitAt, 16)]
        : [title];
      if (template.overlay === "outline") {
        const titleY = Math.round(height * 0.042 + (1 - introProgress) * height * 0.018);
        const titleScale = 0.9 + introProgress * 0.1;
        context.globalAlpha = introProgress;
        context.translate(width / 2, titleY);
        context.scale(titleScale, titleScale);
        context.textAlign = "center";
        context.textBaseline = "top";
        context.lineJoin = "round";
        context.font = `900 ${titleSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
        context.strokeStyle = "rgba(30,18,11,.92)";
        context.lineWidth = Math.max(5, Math.round(width * 0.012));
        context.shadowColor = "rgba(93,39,18,.7)";
        context.shadowBlur = Math.max(2, Math.round(width * 0.006));
        titleLines.forEach((line, index) => {
          const lineY = index * titleSize * 1.02;
          context.strokeText(line, 0, lineY, width - padding * 3);
          context.fillStyle = index === titleLines.length - 1 && titleLines.length > 1 ? template.accent : template.titleColor;
          context.fillText(line, 0, lineY, width - padding * 3);
        });
        context.setTransform(1, 0, 0, 1, 0, 0);
      } else {
        const panelHeight = Math.round(height * 0.13);
        const panelY = Math.round(height * 0.075 + (1 - introProgress) * height * 0.025);
        context.globalAlpha = introProgress;
        context.fillStyle = template.panel;
        context.beginPath();
        context.roundRect(padding, panelY, width - padding * 2, panelHeight, Math.round(width * 0.025));
        context.fill();
        context.fillStyle = template.accent;
        context.fillRect(padding, panelY, Math.round(width * 0.018), panelHeight);
        context.textAlign = template.align;
        context.textBaseline = "middle";
        const titleX = template.align === "center" ? width / 2 : padding + Math.round(width * 0.055);
        context.font = `900 ${titleSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
        context.fillStyle = template.titleColor;
        titleLines.forEach((line, index) => {
          const lineY = panelY + panelHeight / 2 + (index - (titleLines.length - 1) / 2) * titleSize * 1.02;
          context.fillText(line, titleX, lineY, width - padding * 4);
        });
      }
    }

    if (currentCaption) {
      const captionFade = Math.min(1, (time - currentCaption.start) / 0.16, (currentCaption.end - time) / 0.16);
      context.globalAlpha = Math.max(0, captionFade);
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.font = `800 ${subtitleSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
      const captionLineLength = isBoldYellowWhite ? 8 : 14;
      const captionLines = currentCaption.text.length > captionLineLength
        ? [currentCaption.text.slice(0, captionLineLength), currentCaption.text.slice(captionLineLength, captionLineLength * 2)]
        : [currentCaption.text];
      if (template.overlay === "outline") {
        context.lineJoin = "round";
        context.strokeStyle = "rgba(0,0,0,.94)";
        context.lineWidth = Math.max(4, Math.round(width * 0.011));
        context.shadowColor = "rgba(0,0,0,.55)";
        context.shadowBlur = Math.max(2, Math.round(width * 0.005));
        const baseY = isBoldYellowWhite
          ? Math.round(height * 0.6)
          : height - Math.round(height * 0.095);
        captionLines.forEach((line, index) => {
          const lineY = baseY + (index - (captionLines.length - 1) / 2) * subtitleSize * 1.15;
          context.strokeText(line, width / 2, lineY, width - padding * 4);
          context.fillStyle = template.titleColor;
          context.fillText(line, width / 2, lineY, width - padding * 4);
        });
      } else {
        const panelHeight = Math.round(height * 0.075);
        const panelY = height - panelHeight - Math.round(height * 0.055);
        context.fillStyle = template.panel;
        context.beginPath();
        context.roundRect(padding, panelY, width - padding * 2, panelHeight, Math.round(width * 0.022));
        context.fill();
        context.fillStyle = template.titleColor;
        captionLines.forEach((line, index) => {
          const lineY = panelY + panelHeight / 2 + (index - (captionLines.length - 1) / 2) * subtitleSize * 1.08;
          context.fillText(line, width / 2, lineY, width - padding * 4);
        });
      }
    }

    const fadeDuration = Math.min(0.45, duration / 8);
    const fadeOpacity = time < fadeDuration ? 1 - time / fadeDuration : duration - time < fadeDuration ? 1 - (duration - time) / fadeDuration : 0;
    if (fadeOpacity > 0) {
      context.fillStyle = `rgba(8,22,15,${Math.max(0, Math.min(1, fadeOpacity))})`;
      context.fillRect(0, 0, width, height);
    }
    context.restore();
  }

  async function uploadViralResult(blob: Blob, requestId: string, coverUrl = "") {
    const form = new FormData();
    const resultName = viralTitle.trim() || "一键网感成片";
    const extension = blob.type.includes("mp4") ? "mp4" : "webm";
    form.append("file", new File([blob], `${resultName}.${extension}`, { type: blob.type || "video/webm" }));
    form.append("id", stableAssetId(`${requestId}|${resultName}`));
    form.append("projectName", "一键网感");
    form.append("kind", "video");
    form.append("name", resultName);
    form.append("sourceTaskId", requestId);
    form.append("createdAt", String(Date.now()));
    if (coverUrl) {
      try {
        const coverResponse = await fetch(coverUrl, { cache: "no-store" });
        if (coverResponse.ok) {
          const coverBlob = await coverResponse.blob();
          if (coverBlob.size) form.append("cover", new File([coverBlob], `${resultName}-cover.jpg`, { type: coverBlob.type || "image/jpeg" }));
        }
      } catch {
        // 封面上传失败不应阻断成片保存；资产空间会退回视频原生首帧。
      }
    }
    const response = await fetch("/api/member/assets", { method: "POST", body: form });
    const data = await response.json() as { error?: string; item?: { mediaUrl?: string } };
    if (!response.ok) throw new Error(data.error || "成片已生成，但保存到会员资产失败。");
    window.dispatchEvent(new CustomEvent("member-assets-updated"));
    return typeof data.item?.mediaUrl === "string" ? data.item.mediaUrl : "";
  }

  async function archiveViralWorkerResult(sourceUrl: string, requestId: string, coverUrl = "") {
    const resultName = viralTitle.trim() || "一键网感成片";
    const response = await fetch("/api/member/assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: stableAssetId(`${requestId}|${resultName}`),
        projectName: "一键网感",
        kind: "video",
        name: resultName,
        sourceUrl,
        coverUrl,
        sourceTaskId: requestId,
        createdAt: Date.now(),
      }),
    });
    const data = await response.json() as { error?: string; item?: { mediaUrl?: string } };
    if (!response.ok) throw new Error(data.error || "成片已生成，但保存到会员资产失败。");
    window.dispatchEvent(new CustomEvent("member-assets-updated"));
    return typeof data.item?.mediaUrl === "string" ? data.item.mediaUrl : "";
  }

  async function videoWorkerAvailable() {
    const controller = new AbortController();
    // The cloud worker may need several seconds to wake up. A short timeout
    // caused healthy services to be reported as disconnected during local QA.
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(`${videoWorkerBaseUrl()}/health`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await response.json() as { ok?: boolean };
      return response.ok && data.ok === true;
    } catch {
      return false;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function workerSourceFile() {
    if (viralSourceFile) {
      if (viralSourceFile.type.toLowerCase().startsWith("video/")) return viralSourceFile;
      return new File([viralSourceFile], viralSourceFile.name || "source.mp4", {
        type: "video/mp4",
        lastModified: viralSourceFile.lastModified,
      });
    }
    if (!viralVideoPreviewUrl || viralVideoPreviewUrl.startsWith("blob:")) {
      throw new Error("真实原片文件已经失效，请重新上传原片，或从会员资产点击“一键网感”导入。");
    }
    const response = await fetch(viralVideoPreviewUrl, { cache: "no-store" });
    if (!response.ok) throw new Error("无法读取导入的会员视频，请重新上传原片。");
    const blob = await response.blob();
    const contentType = blob.type.toLowerCase().startsWith("video/") ? blob.type : "video/mp4";
    return new File([blob], viralFiles[0] || "source.mp4", { type: contentType });
  }

  async function appendWorkerSource(form: FormData) {
    if (!viralSourceFile && /^https?:\/\//i.test(viralVideoPreviewUrl)) {
      const source = new URL(viralVideoPreviewUrl);
      const protectedMemberAsset = source.origin === window.location.origin && source.pathname.startsWith("/api/member/assets/");
      if (!protectedMemberAsset) {
        form.append("source_url", source.toString());
        form.append("source_name", viralFiles[0] || "source.mp4");
        return;
      }
    }
    const sourceFile = await workerSourceFile();
    form.append("video", sourceFile, sourceFile.name);
  }

  async function analyzeViralSourceForTemplate(requestId: string) {
    const source = document.createElement("video");
    source.crossOrigin = "anonymous";
    source.src = viralSourceFile ? URL.createObjectURL(viralSourceFile) : viralVideoPreviewUrl;
    source.preload = "auto";
    source.playsInline = true;
    source.muted = true;
    source.style.position = "fixed";
    source.style.left = "-99999px";
    source.style.width = "1px";
    document.body.appendChild(source);
    try {
      await new Promise<void>((resolve, reject) => {
        source.onloadedmetadata = () => resolve();
        source.onerror = () => reject(new Error("原片内容读取失败。"));
      });
      const { frames, cover } = await extractViralKeyframes(source);
      const template = viralTemplateById(viralTemplate, viralTemplates);
      const response = await fetch("/api/ai/viral-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase: "analyze",
          requestId,
          frames,
          duration: source.duration || 15,
          template: {
            name: template.name,
            referenceUrl: template.previewUrl,
            titleEffect: template.titleEffect,
            subtitleEffect: template.subtitleEffect,
            transition: template.transitionLabel,
            sfx: template.sfxLabel,
          },
          fallbackTitle: "",
          fallbackSubtitle: "",
        }),
      });
      const data = await response.json() as {
        error?: string;
        title?: string;
        summary?: string;
        degraded?: boolean;
      };
      if (!response.ok) throw new Error(data.error || "原片内容分析失败。");
      if (cover) setViralCoverUrl(cover);
      return {
        // 标题必须来自原片口播；画面分析只用于辅助模板适配，不能代替口播摘要。
        title: "",
        summary: typeof data.summary === "string" ? data.summary : "已读取原片画面并完成模板内容适配。",
        degraded: Boolean(data.degraded),
      };
    } finally {
      source.remove();
      if (viralSourceFile && source.src.startsWith("blob:")) URL.revokeObjectURL(source.src);
    }
  }

  async function processViralVideoOnWorker() {
    const requestId = `viral_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    let pointsReserved = false;
    setViralProcessBusy(true);
    setViralProcessingEngine("server");
    setViralError("");
    setViralProgress(1);
    setViralStage("正在把原片发送到本地视频处理服务…");
    setViralSaved(false);
    setViralFailed(false);
    setViralAnalysisMode("local");
    setViralResultUrl("");
    setViralResultBlob(null);
    setViralDownloadUrl("");
    try {
      const reserveResponse = await fetch("/api/ai/viral-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phase: "reserve", requestId }),
      });
      const reserveData = await reserveResponse.json() as { error?: string; wallet?: { points?: number } };
      if (!reserveResponse.ok) throw new Error(reserveData.error || "积分预扣失败，请稍后重试。");
      pointsReserved = true;
      if (typeof reserveData.wallet?.points === "number") onPointsChange(reserveData.wallet.points);

      setViralProgress(6);
      const generatedTitle = viralTitle.trim();
      setViralStage("正在提交已确认的标题与口播文案…");
      setViralAnalysisSummary("标题与分段口播已经人工确认，将直接交给模板生成，不再重复分析或改写。");
      setViralAnalysisMode("ai");

      setViralProgress(12);
      setViralStage("原片内容已读取，正在按模板规则重新编排…");
      const form = new FormData();
      await appendWorkerSource(form);
      form.append("template_id", viralTemplate);
      form.append("title", generatedTitle);
      form.append("captions_json", viralCaptions.length ? JSON.stringify(viralCaptions) : "[]");
      form.append("include_sfx", viralIncludeSfx ? "true" : "false");
      form.append("include_bgm", viralIncludeBgm ? "true" : "false");
      const createResponse = await fetch(`${videoWorkerBaseUrl()}/v1/jobs`, {
        method: "POST",
        body: form,
      });
      const createData = await createResponse.json().catch(() => null) as ViralWorkerJob | { detail?: string } | null;
      if (!createResponse.ok || !createData || !("id" in createData)) {
        throw new Error(createData && "detail" in createData ? createData.detail || "视频处理服务没有接受原片。" : "视频处理服务没有接受原片。");
      }

      let job = createData;
      const deadline = Date.now() + 30 * 60 * 1000;
      while (job.state !== "success" && job.state !== "failed") {
        if (Date.now() > deadline) throw new Error("视频处理超过30分钟，任务已停止等待。");
        await new Promise((resolve) => window.setTimeout(resolve, 1_800));
        const statusResponse = await fetch(`${videoWorkerBaseUrl()}/v1/jobs/${job.id}`, { cache: "no-store" });
        const statusData = await statusResponse.json().catch(() => null) as ViralWorkerJob | { detail?: string } | null;
        if (!statusResponse.ok || !statusData || !("id" in statusData)) {
          throw new Error(statusData && "detail" in statusData ? statusData.detail || "读取处理进度失败。" : "读取处理进度失败。");
        }
        job = statusData;
        setViralProgress(Math.max(1, Math.min(100, Number(job.progress) || 1)));
        setViralStage(job.message || "后台正在处理视频…");
      }
      if (job.state === "failed") throw new Error(job.error || job.message || "后台视频处理失败。");
      if (!job.result_url) throw new Error("后台任务完成，但没有返回成片地址。");

      const resultUrl = resolveVideoWorkerUrl(job.result_url);
      const coverUrl = job.cover_url ? resolveVideoWorkerUrl(job.cover_url) : "";
      // Show the range-enabled MP4 immediately. Previously the browser waited
      // for the whole file, then uploaded it again before revealing the player.
      // On a typical cloud connection that made a completed 30 MB result feel
      // blocked for one to three minutes.
      setViralResultUrl(resultUrl);
      setViralResultBlob(null);
      setViralCoverUrl(coverUrl);
      setViralProgress(96);
      setViralStage("成片已生成，可立即预览；正在保存到会员资产…");
      if (job.title) setViralTitle(job.title);
      setViralRenderer(job.renderer || "ffmpeg-fallback");
      if (Array.isArray(job.captions)) {
        setViralCaptions(job.captions);
        setViralSubtitle(job.captions.map((caption) => caption.text).join(" / ").slice(0, 120));
      }
      const titleMethod = job.title_source === "user-confirmed"
        ? "标题使用了人工确认版本"
        : job.title_source?.startsWith("ai:")
          ? "标题已由 AI 根据真实口播内容总结"
          : "标题已从真实口播内容提炼";
      const templateVersion = Number(job.template_profile?.version || 1);
      const transitionSummary = Array.isArray(job.transition_points)
        ? `依据镜头变化和口播停顿设置了 ${job.transition_points.length} 个效果触发点`
        : "已按模板规则编排效果触发点";
      // 成片完成后只展示由真实口播和处理任务返回的数据生成的摘要。
      setViralAnalysisSummary(`已通过 Faster-Whisper 读取真实口播时间轴，${titleMethod}；Template V${templateVersion} ${transitionSummary}，并按确认内容生成逐字字幕与提示音。`);

      setViralStage("成片可立即预览，正在保存到会员资产…");
      let saved = true;
      try {
        setViralDownloadUrl(await archiveViralWorkerResult(resultUrl, requestId, coverUrl));
      } catch (error) {
        saved = false;
        setViralError(error instanceof Error ? error.message : "成片已生成，但保存到会员资产失败。");
      }
      setViralSaved(saved);
      const settleResponse = await fetch("/api/ai/viral-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phase: "settle", requestId, actualCost: 28 }),
      });
      const settleData = await settleResponse.json() as { error?: string; wallet?: { points?: number } };
      if (!settleResponse.ok) throw new Error(settleData.error || "积分结算失败。");
      if (typeof settleData.wallet?.points === "number") onPointsChange(settleData.wallet.points);
      pointsReserved = false;
      setViralProgress(100);
      setViralFailed(false);
      setViralStage(saved ? "处理完成，MP4 成片已保存到会员资产。" : "处理完成，可先下载 MP4 成片。");
    } catch (error) {
      if (pointsReserved) {
        const refundResponse = await fetch("/api/ai/viral-edit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phase: "refund", requestId }),
        }).catch(() => null);
        const refundData = refundResponse ? await refundResponse.json().catch(() => null) as { wallet?: { points?: number } } | null : null;
        if (typeof refundData?.wallet?.points === "number") onPointsChange(refundData.wallet.points);
      }
      setViralFailed(true);
      setViralStage("后台处理失败，积分已退回，可直接重新开始。");
      const message = error instanceof Error ? error.message : "后台视频处理失败。";
      setViralError(`${message.replace(/[。！!]*$/, "")}，本次积分已退回。`);
    } finally {
      setViralProcessBusy(false);
    }
  }

  async function processViralVideoInBrowser() {
    if (!viralVideoPreviewUrl || viralProcessBusy) return;
    if (typeof MediaRecorder === "undefined") {
      setViralError("当前浏览器不支持本地视频合成，请使用最新版 Chrome 或 Codex 浏览器。");
      return;
    }

    const requestId = `viral_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    let pointsReserved = false;
    setViralProcessBusy(true);
    setViralProcessingEngine("browser");
    setViralError("");
    setViralProgress(1);
    setViralStage("正在读取原片…");
    setViralSaved(false);
    setViralFailed(false);
    setViralAnalysisMode("");
    try {
      const reserveResponse = await fetch("/api/ai/viral-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phase: "reserve", requestId }),
      });
      const reserveData = await reserveResponse.json() as { error?: string; wallet?: { points?: number } };
      if (!reserveResponse.ok) throw new Error(reserveData.error || "积分预扣失败，请稍后重试。");
      pointsReserved = true;
      if (typeof reserveData.wallet?.points === "number") onPointsChange(reserveData.wallet.points);

      const source = document.createElement("video");
      source.crossOrigin = "anonymous";
      source.src = viralSourceFile ? URL.createObjectURL(viralSourceFile) : viralVideoPreviewUrl;
      source.preload = "auto";
      source.playsInline = true;
      source.muted = false;
      source.style.position = "fixed";
      source.style.left = "-99999px";
      source.style.width = "1px";
      document.body.appendChild(source);
      await new Promise<void>((resolve, reject) => {
        source.onloadedmetadata = () => resolve();
        source.onerror = () => reject(new Error("原片读取失败，请重新导入视频。"));
      });

      setViralProgress(6);
      setViralStage("正在读取首帧并载入已确认文案…");
      const { cover } = await extractViralKeyframes(source);
      const template = viralTemplateById(viralTemplate, viralTemplates);
      setViralProgress(12);
      setViralStage("正在应用已确认的标题与口播文案…");
      const generatedTitle = viralTitle.trim();
      const generatedCaptions = viralCaptions;
      if (!generatedCaptions.length) throw new Error("没有生成可用字幕，请重新处理。");
      setViralTitle(generatedTitle);
      setViralSubtitle(generatedCaptions.map((caption) => caption.text).join(" / ").slice(0, 120));
      setViralCaptions(generatedCaptions);
      setViralAnalysisSummary("标题与分段口播已经人工确认，将直接交给模板生成，不再重复分析或改写。");
      setViralAnalysisMode("ai");
      if (cover) setViralCoverUrl(cover);

      const outputHeight = Math.min(1920, Math.max(568, source.videoHeight || 1920));
      const outputWidth = Math.round(outputHeight * 9 / 16);
      const canvas = document.createElement("canvas");
      canvas.width = outputWidth;
      canvas.height = outputHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("当前浏览器无法创建视频画布。");
      const outputStream = canvas.captureStream(30);
      const captureSource = source as HTMLVideoElement & { captureStream?: () => MediaStream };
      const originalStream = captureSource.captureStream?.();
      let audioContext: AudioContext | null = null;
      try {
        audioContext = new AudioContext();
        await audioContext.resume();
        const mediaSource = audioContext.createMediaElementSource(source);
        const originalGain = audioContext.createGain();
        originalGain.gain.value = 1;
        const mixedAudio = audioContext.createMediaStreamDestination();
        mediaSource.connect(originalGain).connect(mixedAudio);
        if (viralIncludeSfx) scheduleViralSfx(audioContext, mixedAudio, template, source.duration || 15);
        mixedAudio.stream.getAudioTracks().forEach((track) => outputStream.addTrack(track));
      } catch {
        originalStream?.getAudioTracks().forEach((track) => outputStream.addTrack(track));
      }

      const mimeType = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm",
      ].find((type) => MediaRecorder.isTypeSupported(type)) || "";
      const recorder = new MediaRecorder(outputStream, mimeType ? { mimeType, videoBitsPerSecond: 5_000_000 } : undefined);
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      const finished = new Promise<Blob>((resolve, reject) => {
        recorder.onerror = () => reject(new Error("本地视频编码失败，请重新处理。"));
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || "video/webm" }));
      });

      setViralStage("正在应用模板标题、字幕、转场与音效…");
      recorder.start(1000);
      source.currentTime = 0;
      await source.play();
      await new Promise<void>((resolve) => {
        const render = () => {
          drawViralFrame(
            context,
            source,
            outputWidth,
            outputHeight,
            source.currentTime,
            source.duration || 1,
            { title: generatedTitle, captions: generatedCaptions },
            template,
          );
          const progress = Math.min(94, Math.max(3, Math.round((source.currentTime / Math.max(1, source.duration)) * 92)));
          setViralProgress(progress);
          setViralStage(progress < 35 ? "正在应用标题特效…" : progress < 75 ? "正在合成字幕、转场与模板音效…" : "正在完成视频编码…");
          if (source.ended || source.currentTime >= source.duration) {
            resolve();
          } else {
            window.requestAnimationFrame(render);
          }
        };
        window.requestAnimationFrame(render);
      });
      recorder.stop();
      const resultBlob = await finished;
      source.remove();
      if (audioContext) await audioContext.close().catch(() => undefined);
      if (viralSourceFile && source.src.startsWith("blob:")) URL.revokeObjectURL(source.src);
      if (!resultBlob.size) throw new Error("本地视频没有生成有效内容，请重新处理。");

      const resultUrl = URL.createObjectURL(resultBlob);
      setViralResultBlob(resultBlob);
      setViralResultUrl(resultUrl);
      setViralProgress(96);
      setViralStage("正在保存到会员资产…");
      let saved = true;
      try {
        setViralDownloadUrl(await uploadViralResult(resultBlob, requestId, viralCoverUrl));
      } catch (error) {
        saved = false;
        setViralError(error instanceof Error ? error.message : "成片已生成，但保存到会员资产失败。");
      }
      setViralSaved(saved);

      const settleResponse = await fetch("/api/ai/viral-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phase: "settle", requestId, actualCost: 28 }),
      });
      const settleData = await settleResponse.json() as { error?: string; wallet?: { points?: number } };
      if (!settleResponse.ok) throw new Error(settleData.error || "积分结算失败。");
      if (typeof settleData.wallet?.points === "number") onPointsChange(settleData.wallet.points);
      pointsReserved = false;
      setViralProgress(100);
      setViralFailed(false);
      setViralStage(saved
        ? "处理完成，成片已保存到会员资产。"
        : "处理完成，可先下载本地成片。");
    } catch (error) {
      if (pointsReserved) {
        const refundResponse = await fetch("/api/ai/viral-edit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phase: "refund", requestId }),
        }).catch(() => null);
        const refundData = refundResponse ? await refundResponse.json().catch(() => null) as { wallet?: { points?: number } } | null : null;
        if (typeof refundData?.wallet?.points === "number") onPointsChange(refundData.wallet.points);
      }
      setViralFailed(true);
      setViralProgress((current) => Math.max(1, current));
      setViralStage("处理失败，积分已退回，可直接重新开始。");
      const message = error instanceof Error ? error.message : "一键网感处理失败。";
      setViralError(`${message.replace(/[。！!]*$/, "")}，本次积分已退回。`);
    } finally {
      setViralProcessBusy(false);
    }
  }

  async function processViralVideo() {
    if (!viralVideoPreviewUrl || viralProcessBusy) return;
    if (!viralTitle.trim() || !viralCaptions.length || !viralCaptionsConfirmed) {
      setViralTranscriptError("请先核对标题与口播文案，确认全部内容无误后再应用模板。");
      return;
    }
    setViralProcessStarted(true);
    setViralTranscriptError("");
    if (await videoWorkerAvailable()) {
      await processViralVideoOnWorker();
      return;
    }
    await processViralVideoInBrowser();
  }

  useEffect(() => {
    if (workspace !== "material") return;
    const controller = new AbortController();
    fetch(`/api/ai/videos?duration=${videoDuration}&resolution=${videoResolution}&version=${encodeURIComponent(videoVersion)}`, { cache: "no-store", signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("pricing unavailable")))
      .then((data: { quote?: VideoQuote }) => setVideoQuote(data.quote ?? null))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setVideoQuote(null);
      });
    return () => controller.abort();
  }, [videoDuration, videoResolution, videoVersion, workspace]);

  useEffect(() => {
    if (workspace !== "material" || commonVoices.length) return;
    const controller = new AbortController();
    queueMicrotask(() => setCommonVoicesLoading(true));
    fetch("/api/ai/common-voices", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as { error?: string; voices?: CommonVoice[] };
        if (!response.ok) throw new Error(data.error || "开放声音读取失败。");
        const voices = Array.isArray(data.voices) ? data.voices : [];
        setCommonVoices(voices);
        setPhotoVoiceId((current) => voices.some((voice) => voice.voiceId === current)
          ? current
          : voices.find((voice) => voice.name === "中年专家")?.voiceId || voices[0]?.voiceId || "");
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setVideoAgentError(error instanceof Error ? error.message : "开放声音读取失败。");
        }
      })
      .finally(() => setCommonVoicesLoading(false));
    return () => controller.abort();
  }, [commonVoices.length, workspace]);

  useEffect(() => {
    if (workspace !== "material") return;
    let cancelled = false;
    const loadSavedMaterials = async () => {
      setSavedMaterialsLoading(true);
      try {
        const response = await fetch("/api/member/assets", { cache: "no-store" });
        const data = await response.json() as { items?: MemberAssetItem[] };
        if (!response.ok || !Array.isArray(data.items)) return;
        const imageAssets = data.items.filter((item) => item.kind === "image").slice(0, 6);
        const prepared = await Promise.allSettled(imageAssets.map(async (item) => {
          const imageResponse = await fetch(item.mediaUrl, { cache: "no-store" });
          if (!imageResponse.ok) throw new Error("saved material unavailable");
          const aiImage = await blobToAiReferenceDataUrl(await imageResponse.blob());
          return {
            id: `saved-${item.id}`,
            name: `${item.projectName} · ${item.name}`,
            type: "image" as const,
            previewUrl: item.mediaUrl,
            aiImage,
          };
        }));
        if (!cancelled) setSavedMaterialFiles(prepared.flatMap((item) => item.status === "fulfilled" ? [item.value] : []));
      } catch {
        if (!cancelled) setSavedMaterialFiles([]);
      } finally {
        if (!cancelled) setSavedMaterialsLoading(false);
      }
    };
    void loadSavedMaterials();
    const refresh = () => void loadSavedMaterials();
    window.addEventListener("member-assets-updated", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("member-assets-updated", refresh);
    };
  }, [workspace]);

  useEffect(() => {
    if (voiceRecoveryStarted.current) return;
    const query = new URLSearchParams(window.location.search);
    const voiceId = (query.get("recover_voice_id") || "").trim();
    const name = (query.get("recover_voice_name") || "").trim();
    const demoAudio = (query.get("recover_voice_sample") || "").trim();
    if (!voiceId || !demoAudio) return;

    voiceRecoveryStarted.current = true;
    voiceRecoveryPending.current = true;
    queueMicrotask(() => {
      openVideoWorkspace("lip-sync");
      setVoicesLoading(true);
      setVoiceError("");
      setVoiceNotice("正在恢复已克隆声音的试听样本…");
    });

    const recover = async () => {
      try {
        const params = new URLSearchParams({
          support_recover: "execute",
          voice_id: voiceId,
          name: name || "克隆声音",
          demo_audio: demoAudio,
        });
        const response = await fetch(`/api/ai/voices?${params}`, { cache: "no-store" });
        const data = await response.json() as {
          error?: string;
          voice?: ClonedVoice;
          wallet?: { points?: number };
        };
        if (!response.ok || !data.voice?.voiceId) {
          throw new Error(data.error || "声音资产恢复失败。");
        }
        if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);
        const listResponse = await fetch("/api/ai/voices", { cache: "no-store" });
        const listData = await listResponse.json() as { error?: string; voices?: ClonedVoice[] };
        if (!listResponse.ok) throw new Error(listData.error || "恢复后的声音列表读取失败。");
        const voices = Array.isArray(listData.voices) ? listData.voices : [data.voice];
        setSavedVoices(voices);
        setSelectedVoice(data.voice.voiceId);
        setVoiceNotice(`“${data.voice.name}”的试听声音已恢复。`);
        window.dispatchEvent(new CustomEvent("member-assets-updated"));
      } catch (error) {
        setVoiceError(error instanceof Error ? error.message : "声音资产恢复失败。");
      } finally {
        voiceRecoveryPending.current = false;
        setVoicesLoading(false);
        query.delete("recover_voice_id");
        query.delete("recover_voice_name");
        query.delete("recover_voice_sample");
        const nextQuery = query.toString();
        window.history.replaceState({}, "", `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`);
      }
    };
    void recover();
  }, [onPointsChange]);

  useEffect(() => {
    if (workspace !== "lip-sync") return;
    const controller = new AbortController();
    queueMicrotask(() => {
      setVoicesLoading(true);
      setVoiceError("");
    });
    fetch("/api/ai/voices", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as { error?: string; voices?: ClonedVoice[] };
        if (!response.ok) throw new Error(data.error || "已克隆声音读取失败。");
        if (voiceRecoveryPending.current) return;
        const voices = Array.isArray(data.voices) ? data.voices : [];
        setSavedVoices(voices);
        setSelectedVoice((current) => voices.some((item) => item.voiceId === current) ? current : voices[0]?.voiceId || "");
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setSavedVoices([]);
          setSelectedVoice("");
          setVoiceError(error instanceof Error ? error.message : "已克隆声音读取失败。");
        }
      })
      .finally(() => {
        if (!voiceRecoveryPending.current) setVoicesLoading(false);
      });
    return () => controller.abort();
  }, [workspace]);

  function videoReferenceImages() {
    return [...materialFiles, ...savedMaterialFiles]
      .filter((item) => item.aiImage)
      .slice(0, 9)
      .map((item) => item.aiImage);
  }

  function photoVideoMaterials() {
    return [...materialFiles, ...savedMaterialFiles]
      .filter((item) => item.type === "image" && item.aiImage && !excludedPhotoMaterialIds.includes(item.id))
      .slice(0, 12);
  }

  function removePhotoVideoMaterial(item: VideoMaterialItem) {
    if (item.id.startsWith("saved-")) {
      setExcludedPhotoMaterialIds((current) => current.includes(item.id) ? current : [...current, item.id]);
    } else {
      setMaterialFiles((current) => current.filter((file) => file.id !== item.id));
    }
    setGeneratedVideoUrl("");
    setPhotoRenderProgress(0);
  }

  async function loadPhotoVideoImage(source: string) {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("有一张图片无法读取，请移除后重试。"));
      image.src = source;
    });
  }

  async function generatePhotoSpeech() {
    if (!photoIncludeSpeech) return null;
    const voice = commonVoices.find((item) => item.voiceId === photoVoiceId);
    if (!voice) throw new Error("请先选择一个开放声音。");
    const text = photoScript.trim();
    if (text.length < 2) throw new Error("请先填写口播文案。");

    setVideoProgress("正在生成口播与字幕");
    setPhotoRenderProgress(3);
    const projectName = "素材智能成片口播";
    const response = await fetch("/api/ai/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voiceId: voice.voiceId,
        voiceName: voice.name,
        text,
        speed: photoSpeechSpeed,
        projectName,
        requestId: `photo_speech_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      }),
    });
    let data = await response.json() as {
      error?: string;
      taskId?: string;
      requestId?: string;
      state?: string;
      isFinal?: boolean;
      audioUrl?: string;
      duration?: number;
      captions?: ViralCaption[];
      estimatedPoints?: number;
      wallet?: { points?: number };
    };
    if (!response.ok) throw new Error(data.error || "口播音频生成失败。");
    if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);

    for (let attempt = 0; !data.isFinal && data.taskId && attempt < 120; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2500));
      const params = new URLSearchParams({
        task_id: data.taskId,
        request_id: data.requestId || "",
        project_name: projectName,
        voice_name: voice.name,
        estimated_points: String(data.estimatedPoints || 1),
      });
      const statusResponse = await fetch(`/api/ai/speech?${params}`, { cache: "no-store" });
      data = await statusResponse.json() as typeof data;
      if (!statusResponse.ok) throw new Error(data.error || "口播音频状态读取失败。");
      if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);
      setPhotoRenderProgress(Math.min(16, 4 + Math.floor(attempt / 3)));
    }
    if (!data.isFinal || data.state === "failed" || !data.audioUrl) {
      throw new Error(data.error || "口播音频生成失败，请重试。");
    }
    const duration = Math.max(1, Number(data.duration) || videoDuration);
    const captions = Array.isArray(data.captions) ? data.captions : [];
    const audioResponse = await fetch(data.audioUrl, { cache: "no-store" });
    if (!audioResponse.ok) throw new Error("口播音频已生成，但暂时无法读取。");
    window.dispatchEvent(new CustomEvent("member-assets-updated"));
    return {
      voice,
      duration,
      captions,
      audio: await audioResponse.blob(),
    };
  }

  async function transcodePhotoMontageToMp4(source: Blob, input: {
    title: string;
    duration: number;
    width: number;
    height: number;
    audio?: Blob;
  }) {
    setVideoProgress("正在上传并转换为 MP4");
    setPhotoRenderProgress(72);
    const form = new FormData();
    form.append("video", new File([source], "photo-video.webm", { type: source.type || "video/webm" }));
    if (input.audio?.size) form.append("audio", new File([input.audio], "speech.mp3", { type: input.audio.type || "audio/mpeg" }));
    form.append("title", input.title);
    form.append("duration", String(input.duration));
    form.append("width", String(input.width));
    form.append("height", String(input.height));
    const response = await fetch("/api/ai/photo-video/mps", { method: "POST", body: form });
    const created = await response.json() as { error?: string; jobId?: string; progress?: number };
    if (!response.ok || !created.jobId) throw new Error(created.error || "MP4 转码任务创建失败。");

    for (let attempt = 0; attempt < 240; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, attempt === 0 ? 500 : 1500));
      const statusResponse = await fetch(`/api/ai/photo-video/mps?jobId=${encodeURIComponent(created.jobId)}`, { cache: "no-store" });
      const status = await statusResponse.json() as {
        error?: string;
        state?: "running" | "success" | "failed";
        progress?: number;
        mediaUrl?: string;
      };
      if (!statusResponse.ok) throw new Error(status.error || "MP4 转码状态读取失败。");
      setPhotoRenderProgress(Math.max(75, Math.min(100, Number(status.progress) || 75)));
      setVideoProgress(status.state === "success" ? "MP4 成片已完成" : "正在生成 MP4 成片");
      if (status.state === "success" && status.mediaUrl) {
        return `${status.mediaUrl}&v=${Date.now()}`;
      }
      if (status.state === "failed") throw new Error(status.error || "MP4 转码失败，请重试。");
    }
    throw new Error("MP4 转码等待超时，请稍后重试。");
  }

  async function generatePhotoMontage() {
    const materials = photoVideoMaterials();
    if (materials.length < 2) {
      setVideoAgentError("请至少添加两张图片，再生成图片视频。");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      setVideoAgentError("当前浏览器不支持本地视频编码，请使用最新版 Chrome 或 Codex 浏览器。");
      return;
    }

    setVideoAgentBusy("generate");
    setVideoAgentError("");
    setVideoProgress("正在读取图片");
    setPhotoRenderProgress(2);
    try {
      const speech = await generatePhotoSpeech();
      const images = await Promise.all(materials.map((item) => loadPhotoVideoImage(item.aiImage)));
      const { width, height } = photoVideoCanvasSize(photoRatio, videoResolution);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("当前浏览器无法创建视频画布。");

      const stream = canvas.captureStream(30);
      const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type)) || "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: videoResolution === "720p" ? 5_500_000 : 3_000_000 } : undefined);
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      const finished = new Promise<Blob>((resolve, reject) => {
        recorder.onerror = () => reject(new Error("本地视频编码失败，请重试。"));
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || "video/webm" }));
      });

      const totalDuration = speech ? Math.max(1, speech.duration) : Math.max(6, videoDuration);
      const imageDuration = totalDuration / images.length;
      const startedAt = performance.now();
      setVideoProgress("正在按模板生成画面");
      setPhotoRenderProgress(5);
      recorder.start(500);

      await new Promise<void>((resolve) => {
        let lastPercent = 4;
        const render = (timestamp: number) => {
          const elapsed = Math.min(totalDuration, (timestamp - startedAt) / 1000);
          const rawIndex = Math.min(images.length - 1, Math.floor(elapsed / imageDuration));
          const localProgress = Math.min(1, Math.max(0, (elapsed - rawIndex * imageDuration) / imageDuration));
          const transition = rawIndex < images.length - 1 ? Math.min(1, Math.max(0, (localProgress - .82) / .18)) : 0;
          drawPhotoTemplateFrame(context, images, rawIndex, localProgress, width, height, photoTemplate, 1);
          if (transition > 0) drawPhotoTemplateTransition(context, images, rawIndex, transition, width, height, photoTemplate);
          if (speech && photoIncludeSubtitles) drawPhotoCaption(context, speech.captions, elapsed, width, height);
          const percent = Math.min(70, Math.max(5, Math.round((elapsed / totalDuration) * 65)));
          if (percent !== lastPercent) {
            lastPercent = percent;
            setPhotoRenderProgress(percent);
            setVideoProgress(percent < 92 ? `正在生成成片 ${percent}%` : "正在完成视频编码");
          }
          if (elapsed >= totalDuration) resolve();
          else window.setTimeout(() => render(performance.now()), 33);
        };
        render(performance.now());
      });

      recorder.stop();
      const result = await finished;
      const selectedTemplate = PHOTO_VIDEO_TEMPLATES.find((template) => template.id === photoTemplate) || PHOTO_VIDEO_TEMPLATES[0];
      const resultUrl = await transcodePhotoMontageToMp4(result, {
        title: `素材智能成片-${selectedTemplate.name}`,
        duration: totalDuration,
        width,
        height,
        audio: speech?.audio,
      });
      setGeneratedVideoUrl((current) => {
        if (current.startsWith("blob:")) URL.revokeObjectURL(current);
        return resultUrl;
      });
      setPhotoRenderProgress(100);
      setPhotoResultDuration(totalDuration);
      setVideoProgress("MP4 成片已完成");
    } catch (error) {
      setPhotoRenderProgress(0);
      setVideoProgress("");
      setVideoAgentError(error instanceof Error ? error.message : "本地图片视频生成失败，请重试。");
    } finally {
      setVideoAgentBusy("");
    }
  }

  function videoMaterialNames() {
    return [...materialFiles, ...savedMaterialFiles].slice(0, 12).map((item) => item.name);
  }

  function toggleVideoPlatform(platform: string) {
    setVideoPlatforms((current) => current.includes(platform)
      ? current.length === 1 ? current : current.filter((item) => item !== platform)
      : [...current, platform].slice(0, 3));
    setVideoAnalysis(null);
    setVideoDirections([]);
    setSelectedDirection("");
    setStoryboard(null);
  }

  async function analyzeVideoMaterials() {
    setVideoAgentBusy("analyze");
    setVideoAgentError("");
    try {
      const response = await fetch("/api/ai/video-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage: "analyze",
          brief: videoBrief,
          platforms: videoPlatforms,
          materialNames: videoMaterialNames(),
          referenceImages: videoReferenceImages(),
          duration: videoDuration,
          resolution: videoResolution,
          requestId: `video_analysis_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        }),
      });
      const data = await response.json() as {
        error?: string;
        summary?: string;
        platformInsight?: string;
        missing?: string[];
        directions?: VideoDirection[];
        wallet?: { points?: number };
      };
      if (!response.ok) throw new Error(data.error || "素材分析失败，请重试。");
      const directions = Array.isArray(data.directions) ? data.directions.slice(0, 3) : [];
      if (directions.length !== 3) throw new Error("AI 没有返回完整的3个视频方向，请重试。");
      setVideoAnalysis({
        summary: data.summary || "已完成本次需求与素材分析。",
        platformInsight: data.platformInsight || "",
        missing: Array.isArray(data.missing) ? data.missing.slice(0, 3) : [],
      });
      setVideoDirections(directions);
      setSelectedDirection(directions[0].id);
      if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);
    } catch (error) {
      setVideoAgentError(error instanceof Error ? error.message : "素材分析失败，请重试。");
    } finally {
      setVideoAgentBusy("");
    }
  }

  async function createVideoStoryboard() {
    const direction = videoDirections.find((item) => item.id === selectedDirection);
    if (!direction) return;
    setVideoAgentBusy("storyboard");
    setVideoAgentError("");
    try {
      const response = await fetch("/api/ai/video-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage: "storyboard",
          brief: videoBrief,
          platforms: videoPlatforms,
          materialNames: videoMaterialNames(),
          referenceImages: videoReferenceImages(),
          selectedDirection: direction,
          campaign: campaignInfo,
          audience: targetAudience,
          duration: videoDuration,
          resolution: videoResolution,
          requestId: `video_storyboard_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        }),
      });
      const data = await response.json() as Partial<VideoStoryboard> & { error?: string; wallet?: { points?: number } };
      if (!response.ok) throw new Error(data.error || "分镜生成失败，请重试。");
      if (!data.generationPrompt || !Array.isArray(data.shots) || data.shots.length < 3) throw new Error("AI 没有返回完整分镜，请重试。");
      setStoryboard({
        title: data.title || "短视频项目",
        script: data.script || "",
        generationPrompt: data.generationPrompt,
        shots: data.shots.slice(0, 6) as VideoShot[],
        modelPlan: Array.isArray(data.modelPlan) ? data.modelPlan as VideoStoryboard["modelPlan"] : [],
      });
      if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);
    } catch (error) {
      setVideoAgentError(error instanceof Error ? error.message : "分镜生成失败，请重试。");
    } finally {
      setVideoAgentBusy("");
    }
  }

  async function generateVideo() {
    if (!storyboard) return;
    const images = videoReferenceImages();
    if (!images.length) {
      setVideoAgentError("真实参考生视频至少需要一张图片素材；本地视频素材需要后续上传到云存储后才能传给模型。");
      return;
    }
    setVideoAgentBusy("generate");
    setVideoAgentError("");
    setVideoProgress("正在提交视频任务");
    try {
      const requestId = `video_generate_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const response = await fetch("/api/ai/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: storyboard.generationPrompt,
          images,
          duration: videoDuration,
          resolution: videoResolution,
          version: videoVersion,
          projectName: storyboard.title,
          requestId,
        }),
      });
      let data = await response.json() as {
        error?: string;
        taskId?: string | null;
        requestId?: string;
        isFinal?: boolean;
        state?: string;
        progress?: string;
        resultUrl?: string;
        wallet?: { points?: number };
      };
      if (!response.ok) throw new Error(data.error || "视频任务创建失败。");
      if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);
      const taskId = data.taskId || "";
      const settledRequestId = data.requestId || requestId;
      for (let attempt = 0; !data.isFinal && taskId && attempt < 72; attempt += 1) {
        setVideoProgress(data.progress && data.progress !== "0%" ? `视频生成中 ${data.progress}` : "视频生成中，通常需要几分钟");
        await new Promise((resolve) => window.setTimeout(resolve, 5000));
        const statusResponse = await fetch(`/api/ai/videos?task_id=${encodeURIComponent(taskId)}&request_id=${encodeURIComponent(settledRequestId)}`, { cache: "no-store" });
        data = await statusResponse.json() as typeof data;
        if (!statusResponse.ok) throw new Error(data.error || "视频任务查询失败。");
      }
      if (!data.isFinal) throw new Error("视频仍在平台生成中，请稍后在会员资产中查看。");
      if (data.state !== "success" || !data.resultUrl) throw new Error(data.error || "视频生成失败，本次积分将自动退回。");
      setGeneratedVideoUrl(data.resultUrl);
      setVideoProgress("视频生成完成");
      if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);
      await archiveGeneratedAssets({
        projectName: storyboard.title,
        kind: "video",
        urls: [data.resultUrl],
        taskIds: taskId ? [taskId] : undefined,
        namePrefix: "商家素材成片",
      });
    } catch (error) {
      setVideoAgentError(error instanceof Error ? error.message : "视频生成失败，请重试。");
      setVideoProgress("");
    } finally {
      setVideoAgentBusy("");
    }
  }

  if (workspace === "material") {
    const photoMaterials = photoVideoMaterials();
    const selectedPhotoTemplate = PHOTO_VIDEO_TEMPLATES.find((template) => template.id === photoTemplate) || PHOTO_VIDEO_TEMPLATES[0];
    const visiblePhotoTemplates = photoTemplateCategory === "all"
      ? PHOTO_VIDEO_TEMPLATES
      : PHOTO_VIDEO_TEMPLATES.filter((template) => template.category === photoTemplateCategory);
    const previewImage = photoMaterials[0]?.previewUrl || "";
    const selectedCommonVoice = commonVoices.find((voice) => voice.voiceId === photoVoiceId);
    const canGeneratePhotoVideo = photoMaterials.length >= 2
      && videoAgentBusy === ""
      && (!photoIncludeSpeech || Boolean(photoVoiceId && photoScript.trim().length >= 2));
    return <section className="video-workspace photo-video-workspace">
      <header className="video-workspace-head photo-video-head">
        <button type="button" onClick={() => openVideoWorkspace("chooser")}>← 返回短视频</button>
        <div><h1>素材智能成片</h1></div>
        {generatedVideoUrl || videoAgentBusy === "generate" ? <span>{generatedVideoUrl ? "成片已完成" : "正在生成"}</span> : null}
      </header>

      <div className="photo-video-layout">
        <main className="photo-video-stage">
          <section className="photo-video-upload" aria-labelledby="photo-video-upload-title">
            <div className="photo-video-section-head">
              <div><h2 id="photo-video-upload-title">添加图片</h2><p>按上传顺序生成；建议使用 4–12 张清晰图片。</p></div>
              <b>{photoMaterials.length} / 12</b>
            </div>
            <label className="photo-video-drop">
              <input type="file" accept="image/*" multiple onChange={addMaterialFiles} />
              <ImageSquare size={28} weight="duotone" />
              <span><b>{photoMaterials.length ? "继续添加图片" : "选择多张图片"}</b><small>支持 JPG、PNG、WebP</small></span>
            </label>
            {savedMaterialsLoading ? <div className="photo-video-loading" role="status">正在读取会员资产中的图片…</div> : null}
            {photoMaterials.length ? <div className="photo-filmstrip" aria-label="已添加图片顺序">
              {photoMaterials.map((item, index) => <article key={item.id}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <img src={item.previewUrl} alt={item.name} />
                <button type="button" aria-label={`移除${item.name}`} onClick={() => removePhotoVideoMaterial(item)}>移除</button>
                <small>{item.name}</small>
              </article>)}
            </div> : <div className="photo-video-empty"><b>还没有图片</b><span>添加图片后，这里会显示成片顺序。</span></div>}
            {excludedPhotoMaterialIds.length ? <button type="button" className="photo-video-restore" onClick={() => setExcludedPhotoMaterialIds([])}>恢复已移除的会员图片</button> : null}
          </section>

          <section className="photo-video-speech" aria-labelledby="photo-video-speech-title">
            <div className="photo-video-section-head">
              <div><h2 id="photo-video-speech-title">添加口播与字幕</h2></div>
              <label className="photo-speech-switch"><input type="checkbox" checked={photoIncludeSpeech} onChange={(event) => { setPhotoIncludeSpeech(event.target.checked); setGeneratedVideoUrl(""); setPhotoRenderProgress(0); }} /><span>{photoIncludeSpeech ? "已开启" : "纯画面"}</span></label>
            </div>
            {photoIncludeSpeech ? <div className="photo-speech-fields">
              <label className="photo-script-field"><span>口播文案 <small>{photoScript.trim().length} 字</small></span><textarea value={photoScript} maxLength={3000} onChange={(event) => { setPhotoScript(event.target.value); setGeneratedVideoUrl(""); setPhotoRenderProgress(0); }} placeholder="输入要转换成口播的文案" /></label>
              <div className="photo-voice-row">
                <label><span>开放声音</span><select value={photoVoiceId} disabled={commonVoicesLoading} onChange={(event) => { setPhotoVoiceId(event.target.value); setGeneratedVideoUrl(""); setPhotoRenderProgress(0); }}><option value="">{commonVoicesLoading ? "正在读取声音…" : "选择声音"}</option>{commonVoices.map((voice) => <option value={voice.voiceId} key={voice.voiceId}>{voice.name}</option>)}</select></label>
                <label><span>语速</span><select value={photoSpeechSpeed} onChange={(event) => { setPhotoSpeechSpeed(Number(event.target.value)); setGeneratedVideoUrl(""); setPhotoRenderProgress(0); }}><option value="0.75">舒缓 · 0.75×</option><option value="1">正常 · 1.0×</option><option value="1.25">稍快 · 1.25×</option><option value="1.5">快速 · 1.5×</option><option value="2">极速 · 2.0×</option></select></label>
                <label className="photo-subtitle-toggle"><span>字幕</span><button type="button" className={photoIncludeSubtitles ? "active" : ""} aria-pressed={photoIncludeSubtitles} onClick={() => { setPhotoIncludeSubtitles((current) => !current); setGeneratedVideoUrl(""); setPhotoRenderProgress(0); }}>{photoIncludeSubtitles ? "自动添加" : "不添加"}</button></label>
              </div>
              {selectedCommonVoice?.auditionUrl ? <div className="photo-voice-audition"><span><b>{selectedCommonVoice.name}</b><small>开放声音试听</small></span><audio key={selectedCommonVoice.voiceId} src={selectedCommonVoice.auditionUrl} controls preload="none" /></div> : null}
            </div> : <div className="photo-speech-off">关闭后将按右侧设定时长生成纯画面视频。</div>}
          </section>

          <section className="photo-video-templates" aria-labelledby="photo-video-template-title">
            <div className="photo-video-section-head">
              <div><h2 id="photo-video-template-title">选择模板</h2></div>
              <b>{selectedPhotoTemplate.name}</b>
            </div>
            <nav className="photo-template-categories" aria-label="图片成片模板分类">
              {PHOTO_VIDEO_CATEGORIES.map((category) => <button
                type="button"
                className={photoTemplateCategory === category.id ? "active" : ""}
                aria-pressed={photoTemplateCategory === category.id}
                onClick={() => setPhotoTemplateCategory(category.id)}
                key={category.id}
              >{category.name}</button>)}
            </nav>
            <div className="photo-template-grid">
              {visiblePhotoTemplates.map((template) => <button type="button" className={`photo-template-card layout-${template.layout} is-${template.id} ${photoTemplate === template.id ? "selected" : ""}`} aria-pressed={photoTemplate === template.id} onClick={() => { setPhotoTemplate(template.id); setGeneratedVideoUrl(""); setPhotoRenderProgress(0); }} key={template.id}>
                <span className="photo-template-art" aria-hidden="true">
                  {previewImage ? <img src={previewImage} alt="" /> : <i />}
                  <u /><em />
                </span>
                <span className="photo-template-copy"><small>{template.tag}</small><b>{template.name}</b><i>{template.detail}</i><span className="photo-template-effects">{template.effectLabel}</span></span>
              </button>)}
            </div>
          </section>
        </main>

        <aside className="photo-video-controls">
          <div className="photo-video-control-head"><VideoCamera size={22} weight="duotone" /><div><b>成片设置</b><span>自动输出标准 MP4</span></div></div>
          <label><span>画面比例</span><div className="photo-ratio-picker">{(["9:16", "1:1", "16:9"] as PhotoVideoRatio[]).map((ratio) => <button type="button" className={photoRatio === ratio ? "active" : ""} aria-pressed={photoRatio === ratio} onClick={() => { setPhotoRatio(ratio); setGeneratedVideoUrl(""); }} key={ratio}>{ratio}</button>)}</div></label>
          <label><span>成片时长</span>{photoIncludeSpeech ? <div className="photo-duration-locked">跟随口播音频</div> : <select value={videoDuration} onChange={(event) => { setVideoDuration(Number(event.target.value)); setGeneratedVideoUrl(""); }}><option value="8">8 秒 · 快速预览</option><option value="12">12 秒 · 推荐</option><option value="15">15 秒 · 完整展示</option></select>}</label>
          <label><span>清晰度</span><select value={videoResolution} onChange={(event) => { setVideoResolution(event.target.value as "480p" | "720p"); setGeneratedVideoUrl(""); }}><option value="480p">480P · 更快</option><option value="720p">720P · 高清</option></select></label>
          <button type="button" className="photo-video-generate" disabled={!canGeneratePhotoVideo} onClick={() => void generatePhotoMontage()}>{videoAgentBusy === "generate" ? `正在生成 ${photoRenderProgress}%` : generatedVideoUrl ? "重新生成成片" : "生成 MP4 成片"}</button>
          {!photoMaterials.length ? <small className="photo-video-control-tip">请先添加至少两张图片。</small> : photoMaterials.length === 1 ? <small className="photo-video-control-tip">再添加一张图片即可生成。</small> : null}
          {videoAgentBusy === "generate" || photoRenderProgress ? <div className={`photo-video-progress ${photoRenderProgress === 100 ? "complete" : ""}`} role="status" aria-live="polite"><span style={{ width: `${photoRenderProgress}%` }} /><b>{videoProgress || "准备生成"}</b></div> : null}
          {videoAgentError ? <div className="photo-video-error" role="alert">{videoAgentError}</div> : null}
          {generatedVideoUrl ? <div className="photo-video-result">
            <video src={generatedVideoUrl} controls playsInline preload="metadata" />
            <div><b>成片已完成</b><span>{selectedPhotoTemplate.name} · {selectedCommonVoice?.name || "纯画面"} · {photoRatio} · {(photoResultDuration || videoDuration).toFixed(1)} 秒</span></div>
            <a href={generatedVideoUrl} download={`素材智能成片-${selectedPhotoTemplate.name}.mp4`}>下载 MP4 成片</a>
            <button type="button" onClick={() => openDirectorResultInViralEditor({ name: `素材智能成片-${selectedPhotoTemplate.name}.mp4`, mediaUrl: generatedVideoUrl })}>进入一键网感</button>
          </div> : <div className={`photo-video-live-preview ratio-${photoRatio.replace(":", "-")}`}>
            {previewImage ? <img src={previewImage} alt="当前图片预览" /> : <div><ImageSquare size={34} /><b>等待添加图片</b></div>}
            <span>{selectedPhotoTemplate.name}</span>
          </div>}
        </aside>
      </div>
    </section>;
  }


  if (workspace === "ai-director") {
    return <AiDirectorStudio onBack={() => openVideoWorkspace("chooser")} onPointsChange={onPointsChange} onOpenViralEditor={openDirectorResultInViralEditor} />;
  }

  if (workspace === "ai-benchmark") {
    const benchmarkStep = benchmarkDraft.trim() ? 3 : benchmarkTranscript.trim() ? 2 : 1;
    return <section className="video-workspace lip-sync-workspace ai-benchmark-workspace">
      <header className="video-workspace-head lip-sync-workspace-head">
        <button type="button" onClick={() => openVideoWorkspace("lip-sync")}>← 返回对口型视频</button>
        <div><h1>AI 对标改写</h1></div>
        <span>{benchmarkBusy === "extract" ? `读取中 · ${benchmarkProgress}%` : benchmarkBusy === "rewrite" ? "正在改写" : `第 ${benchmarkStep} 步`}</span>
      </header>
      <nav className="lip-sync-progress ai-benchmark-progress" aria-label="AI 对标改写进度">
        {[
          { label: "读取", detail: benchmarkTranscript ? "口播已提取" : "粘贴公开链接" },
          { label: "改写", detail: benchmarkDraft ? "新文案已生成" : "填写自己的资料" },
          { label: "确认", detail: "回填口播文本框" },
        ].map((item, index) => {
          const step = index + 1;
          const isComplete = step < benchmarkStep;
          const isActive = step === benchmarkStep;
          return <span className={isComplete ? "complete" : isActive ? "active" : ""} aria-current={isActive ? "step" : undefined} key={item.label}>
            <i>{step}</i><b>{item.label}</b><small>{item.detail}</small>
          </span>;
        })}
      </nav>
      <div className="ai-benchmark-flow">
        <section className={`video-builder-card lip-sync-step-card ${benchmarkTranscript ? "is-complete" : "is-active"}`}>
          <div className="video-card-title lip-sync-card-title"><span>01</span><div><b>读取对标口播</b><small>支持 douyin.com 的公开短视频链接</small></div>{benchmarkTranscript ? <em>已完成</em> : <em>当前步骤</em>}</div>
          <div className="benchmark-link-row">
            <input value={benchmarkUrl} disabled={benchmarkBusy === "extract"} onChange={(event) => { setBenchmarkUrl(event.target.value); setBenchmarkError(""); }} placeholder="粘贴抖音分享链接，例如 https://v.douyin.com/…" aria-label="抖音公开视频链接" />
            <button type="button" disabled={!benchmarkUrl.trim() || Boolean(benchmarkBusy)} onClick={() => void extractBenchmarkTranscript()}>{benchmarkBusy === "extract" ? `${benchmarkProgress}% · 正在读取` : benchmarkTranscript ? "重新读取" : "读取视频文案"}</button>
          </div>
          {benchmarkBusy === "extract" || benchmarkMessage ? <div className="benchmark-status"><span style={{ width: `${benchmarkProgress}%` }} /><b>{benchmarkMessage || "正在读取公开视频…"}</b></div> : null}
          <p className="benchmark-rights-note">仅分析公开视频的表达结构与节奏。请确认你有权使用该链接，生成结果不会照搬原文。</p>
        </section>

        {benchmarkTranscript ? <section className={`video-builder-card lip-sync-step-card ${benchmarkDraft ? "is-complete" : "is-active"}`}>
          <div className="video-card-title lip-sync-card-title"><span>02</span><div><b>用你的资料重新创作</b><small>事实以你的资料为准，只借鉴对标视频的结构</small></div>{benchmarkDraft ? <em>已完成</em> : <em>当前步骤</em>}</div>
          <div className="benchmark-source-meta"><small>已读取</small><b>{benchmarkTitle || "对标视频"}</b>{benchmarkAuthor ? <span>作者：{benchmarkAuthor}</span> : null}</div>
          <div className="benchmark-copy-grid">
            <label><span>对标口播原文</span><textarea value={benchmarkTranscript} readOnly aria-label="对标口播原文" /></label>
            <label><span>你的真实资料</span><textarea value={benchmarkProfile} disabled={benchmarkBusy === "rewrite"} onChange={(event) => { setBenchmarkProfile(event.target.value); setBenchmarkDraft(""); setBenchmarkError(""); }} placeholder="例如：我是杭州一家社区烘焙店，主打当天现烤低糖面包；目标顾客是附近上班族和家庭；优势是原料透明、早上7点出炉；希望用户到店试吃。" aria-label="用户自己的业务资料" /></label>
          </div>
          <button type="button" className="benchmark-rewrite-button" disabled={benchmarkProfile.trim().length < 5 || Boolean(benchmarkBusy)} onClick={() => void rewriteBenchmarkScript()}>{benchmarkBusy === "rewrite" ? "AI 正在分析结构并重新创作…" : "✦ 按我的资料 AI 改写"}</button>
        </section> : null}

        {benchmarkTranscript ? <section className={`video-builder-card lip-sync-step-card benchmark-result-card ${benchmarkDraft ? "is-active" : "is-pending"}`}>
          <div className="video-card-title lip-sync-card-title"><span>03</span><div><b>确认新的口播文案</b><small>可以手动微调，确认后回填到口播音频文本框</small></div>{benchmarkDraft ? <em>可以确认</em> : <em>等待改写</em>}</div>
          <textarea value={benchmarkDraft} disabled={!benchmarkDraft || benchmarkBusy === "rewrite"} onChange={(event) => { setBenchmarkDraft(event.target.value); setBenchmarkError(""); }} placeholder="AI 改写后的文案将在这里显示" aria-label="AI 对标改写结果" />
          <div className="benchmark-confirm-row"><button type="button" disabled={!benchmarkDraft.trim() || Boolean(benchmarkBusy)} onClick={confirmBenchmarkScript}>确认并用于生成口播</button></div>
        </section> : null}
        {benchmarkError ? <div className="video-agent-error" role="alert">{benchmarkError}</div> : null}
      </div>
    </section>;
  }

  if (workspace === "lip-sync") {
    const voiceReady = Boolean(selectedVoice) && (voiceSource === "saved" || uploadedVoiceReady);
    const canGenerateSpeechAudio = voiceReady && Boolean(script.trim());
    const canGenerateLipSync = speechAudioReady
      && Boolean(speechAudioUrl)
      && Boolean(lipVideoFile);
    const currentSavedVoice = savedVoices.find((item) => item.voiceId === selectedVoice);
    const currentVoiceName = currentSavedVoice?.name || (voiceSource === "upload" ? voiceName || "待克隆声音" : "尚未选择声音");
    const lipSyncEstimatedPoints = speechAudioDuration > 0 ? lipSyncPoints(speechAudioDuration, true) : null;
    const lipSyncCurrentStep = lipSyncResultUrl || canGenerateLipSync ? 4 : speechAudioReady ? 3 : voiceReady ? 2 : 1;
    const resetVoiceResult = () => {
      setUploadedVoiceReady(false);
      setSelectedVoice("");
      setSpeechAudioReady(false);
      setSpeechAudioUrl("");
      setSpeechError("");
      setVoiceError("");
      setVoiceNotice("");
    };
    return <section className="video-workspace lip-sync-workspace">
      <header className="video-workspace-head lip-sync-workspace-head">
        <button type="button" onClick={() => openVideoWorkspace("chooser")}>← 返回短视频</button>
        <div><h1>对口型视频</h1></div>
        <span>{lipSyncResultUrl ? "视频已完成" : `正在制作 · 第 ${lipSyncCurrentStep} 步`}</span>
      </header>
      <nav className="lip-sync-progress" aria-label="对口型视频制作进度">
        {[
          { label: "声音", detail: voiceReady ? currentVoiceName : "选择或克隆" },
          { label: "口播", detail: speechAudioReady ? "音频已生成" : "输入文案" },
          { label: "视频", detail: lipVideoName || "上传正脸视频" },
          { label: "合成", detail: lipSyncResultUrl ? "制作完成" : "同步人物口型" },
        ].map((item, index) => {
          const step = index + 1;
          const isComplete = step < lipSyncCurrentStep || Boolean(lipSyncResultUrl);
          const isActive = step === lipSyncCurrentStep && !lipSyncResultUrl;
          return <span className={isComplete ? "complete" : isActive ? "active" : ""} aria-current={isActive ? "step" : undefined} key={item.label}>
            <i>{step}</i><b>{item.label}</b><small>{item.detail}</small>
          </span>;
        })}
      </nav>
      <div className="video-builder-grid lip-sync-grid">
        <div className="video-builder-form">
          <section className={`video-builder-card lip-sync-step-card ${voiceReady ? "is-complete" : "is-active"}`}>
            <div className="video-card-title lip-sync-card-title"><span>01</span><div><b>选择或克隆声音</b><small>{voiceReady ? `已选择 ${currentVoiceName}` : "先确定口播使用的声音"}</small></div>{voiceReady ? <em>已完成</em> : <em>当前步骤</em>}</div>
            <nav className="voice-source-tabs">
              <button type="button" className={voiceSource === "saved" ? "active" : ""} onClick={() => { setVoiceSource("saved"); setSpeechAudioReady(false); setSpeechAudioUrl(""); setSpeechError(""); setVoiceError(""); setVoiceNotice(""); }}>选择已有声音</button>
              <button type="button" className={voiceSource === "upload" ? "active" : ""} onClick={() => { setVoiceSource("upload"); setSpeechAudioReady(false); setSpeechAudioUrl(""); setSpeechError(""); setVoiceError(""); setVoiceNotice(""); }}>上传音频克隆</button>
            </nav>
            {voiceSource === "saved" ? <><div className="voice-saved-row"><label className="video-select-field"><span>已有克隆声音</span><select value={selectedVoice} disabled={voicesLoading || !savedVoices.length || voiceAuditionBusy} onChange={(event) => { setSelectedVoice(event.target.value); setSpeechAudioReady(false); setSpeechAudioUrl(""); setSpeechError(""); setVoiceError(""); }}><option value="">{voicesLoading ? "正在读取声音…" : savedVoices.length ? "请选择声音" : "暂无已克隆声音"}</option>{savedVoices.map((voice) => <option value={voice.voiceId} key={voice.voiceId}>{voice.name}（{voice.language === "en" ? "英文" : "中文"}）</option>)}</select><small>{currentSavedVoice ? `已绑定当前会员账号 · ${currentSavedVoice.language === "en" ? "英文音色" : "中文音色"}` : "请先在“上传音频克隆”中创建声音"}</small></label><button type="button" className="voice-audition-button" disabled={!currentSavedVoice || voiceAuditionBusy} onClick={() => void auditionClonedVoice(selectedVoice)}>{voiceAuditionBusy ? "正在生成试听…" : "▶ 试听声音"}</button></div><p className="voice-audition-copy">试听内容：{currentSavedVoice?.language === "en" ? VOICE_AUDITION_TEXT_EN : VOICE_AUDITION_TEXT}</p>{currentSavedVoice && voiceAuditionUrls[currentSavedVoice.voiceId] ? <div className="voice-audition-preview"><audio src={voiceAuditionUrls[currentSavedVoice.voiceId]} controls preload="metadata" /></div> : null}</> : null}
            {voiceSource === "upload" ? <div className="voice-clone-panel"><label className="video-file-drop is-compact"><input type="file" accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/mp4,audio/m4a,audio/ogg,audio/webm,.mp3,.m4a,.wav,.ogg,.webm" onChange={(event) => { void prepareVoiceAudioPreview(event.target.files?.[0] ?? null); event.target.value = ""; }} /><i>＋</i><b>{audioFileName || "上传清晰人声音频"}</b><span>清晰人声 · 无背景音乐 · 3–10 秒</span></label>{voiceUploadPreviewUrl ? <div className="voice-upload-preview"><span>原始音频试听</span><audio key={voiceUploadPreviewUrl} src={voiceUploadPreviewUrl} controls preload="auto" onCanPlay={() => setVoiceUploadPreviewError("")} onError={() => { if (voicePreviewConverted.current) setVoiceUploadPreviewError("浏览器仍无法播放转换后的音频，请重新导出为标准 MP3 或 WAV。"); else void convertVoiceAudioForBrowser(); }}>当前浏览器不支持音频试听。</audio>{voiceUploadPreviewConverting ? <em>正在转换兼容格式…</em> : null}</div> : null}{voiceUploadPreviewError ? <div className="voice-preview-error" role="alert">{voiceUploadPreviewError}</div> : null}<div className="voice-clone-controls"><input value={voiceName} placeholder="给克隆声音命名" disabled={voiceBusy} onChange={(event) => { setVoiceName(event.target.value); resetVoiceResult(); }} /><button type="button" className="voice-clone-action is-chinese" disabled={!audioFile || voiceUploadPreviewConverting || Boolean(voiceUploadPreviewError) || !voiceName.trim() || voiceBusy} onClick={() => void cloneUploadedVoice("cn")}>{voiceBusy && voiceLanguage === "cn" ? "正在克隆中文…" : `克隆中文 · ${CHANJING_VOICE_CLONE_POINTS}积分`}</button><button type="button" className="voice-clone-action is-english" disabled={!audioFile || voiceUploadPreviewConverting || Boolean(voiceUploadPreviewError) || !voiceName.trim() || voiceBusy} onClick={() => void cloneUploadedVoice("en")}>{voiceBusy && voiceLanguage === "en" ? "正在克隆英文…" : `克隆英文 · ${CHANJING_VOICE_CLONE_POINTS}积分`}</button></div>{uploadedVoiceReady ? <small className="voice-clone-ready">✓ {voiceNotice || `“${voiceName}”${voiceLanguage === "en" ? "英文" : "中文"}音色已保存`}</small> : null}</div> : null}
            {voiceError ? <div className="video-agent-error" role="alert">{voiceError}</div> : null}
          </section>
          <section className={`video-builder-card lip-sync-step-card ${speechAudioReady ? "is-complete" : voiceReady ? "is-active" : "is-pending"}`}>
            <div className="video-card-title lip-sync-card-title"><span>02</span><div><b>生成口播音频</b><small>{speechAudioReady ? "音频已生成，可以试听" : "输入文案并调整说话速度"}</small></div>{speechAudioReady ? <em>已完成</em> : voiceReady ? <em>当前步骤</em> : <em>等待声音</em>}</div>
            <textarea value={script} onChange={(event) => { setScript(event.target.value); setSpeechAudioReady(false); setSpeechAudioUrl(""); setSpeechError(""); setLipSyncResultUrl(""); }} aria-label="口播文案" />
            <div className="video-speech-actions">
              <button type="button" className="benchmark-entry-button" disabled={speechBusy || scriptRewriteBusy} onClick={() => { setBenchmarkError(""); openVideoWorkspace("ai-benchmark"); }}>AI 对标</button>
              <button type="button" disabled={scriptRewriteBusy || script.trim().length < 2} onClick={() => void rewriteSpeechScript()}>{scriptRewriteBusy ? "正在生成口播文案…" : "AI 辅助改写"}</button>
              <label className="speech-speed-field">
                <span>语速</span>
                <select value={speechSpeed} disabled={speechBusy} onChange={(event) => { setSpeechSpeed(Number(event.target.value)); setSpeechAudioReady(false); setSpeechAudioUrl(""); setSpeechError(""); setLipSyncResultUrl(""); }} aria-label="口播语速">
                  <option value={0.75}>慢速 · 0.75×</option>
                  <option value={1}>正常 · 1.0×</option>
                  <option value={1.25}>稍快 · 1.25×</option>
                  <option value={1.5}>快速 · 1.5×</option>
                  <option value={2}>很快 · 2.0×</option>
                </select>
              </label>
              <button type="button" className="primary" disabled={!canGenerateSpeechAudio || speechBusy || scriptRewriteBusy} onClick={() => void generateSpeechAudio()}>{speechBusy ? "正在生成口播音频…" : "生成口播音频 · 按实际积分结算"}</button>
            </div>
            {speechError ? <div className="video-agent-error" role="alert">{speechError}</div> : null}
            {speechAudioReady && speechAudioUrl ? <div className="speech-audio-preview"><div><i>♪</i><span><b>口播音频已生成</b><small>{`${currentVoiceName} · ${speechAudioDuration ? `${speechAudioDuration.toFixed(1)} 秒 · ` : ""}${speechSpeed}×`}</small></span></div><audio src={speechAudioUrl} controls preload="metadata" onLoadedMetadata={(event) => setSpeechAudioDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)} /></div> : null}
          </section>
          <section className={`video-builder-card lip-sync-step-card ${lipVideoName ? "is-complete" : speechAudioReady ? "is-active" : "is-pending"}`}>
            <div className="video-card-title lip-sync-card-title"><span>03</span><div><b>上传本人视频</b><small>{lipVideoName ? "人物视频已就绪" : "使用正脸、清晰、嘴部无遮挡的视频"}</small></div>{lipVideoName ? <em>已完成</em> : speechAudioReady ? <em>当前步骤</em> : <em>等待口播</em>}</div>
            <label className={`video-file-drop is-compact ${lipVideoName ? "has-files" : ""}`}><input type="file" accept="video/*" onChange={(event) => { const file = event.target.files?.[0] ?? null; setLipVideoFile(file); setLipVideoName(file?.name ?? ""); setLipVideoPreviewUrl(file ? URL.createObjectURL(file) : ""); setLipSyncResultUrl(""); setLipSyncError(""); setLipSyncProgress(0); event.target.value = ""; }} /><i>＋</i><b>{lipVideoName || "上传正脸口播视频"}</b><span>建议人物正脸、光线清晰、嘴部无遮挡</span></label>
            {lipVideoPreviewUrl ? <div className="lip-video-inline-preview"><video src={lipVideoPreviewUrl} controls muted playsInline preload="metadata" onLoadedMetadata={(event) => setLipVideoSize({ width: event.currentTarget.videoWidth || 1080, height: event.currentTarget.videoHeight || 1920 })} /><span><b>{lipVideoName}</b><small>{lipVideoSize.width} × {lipVideoSize.height} · 视频已就绪</small></span></div> : null}
          </section>
          <section className={`video-builder-card lip-sync-step-card lip-sync-final-card ${lipSyncResultUrl ? "is-complete" : canGenerateLipSync ? "is-active" : "is-pending"}`}>
            <div className="video-card-title lip-sync-card-title"><span>04</span><div><b>生成对口型视频</b><small>{lipSyncResultUrl ? "成片已保存，可继续网感剪辑" : "声音和人物视频将自动同步"}</small></div>{lipSyncResultUrl ? <em>已完成</em> : canGenerateLipSync ? <em>可以生成</em> : <em>等待素材</em>}</div>
            <div className="lip-sync-final-actions">
              <button type="button" className="video-generate-button" disabled={lipSyncBusy || !canGenerateLipSync || !lipSyncEstimatedPoints} onClick={() => void generateLipSyncVideo()}>{lipSyncBusy ? `正在同步口型${lipSyncProgress ? ` · ${lipSyncProgress}%` : "…"}` : canGenerateLipSync ? lipSyncEstimatedPoints ? `✦ 生成对口型视频 · ${lipSyncEstimatedPoints}积分` : "正在读取音频时长…" : !speechAudioReady ? "请先生成口播音频" : "请先上传本人视频"}</button>
              <button type="button" className="lip-sync-viral-button" disabled={lipSyncBusy || !lipSyncResultUrl} onClick={openLipSyncResultInViralEditor}>{lipSyncResultUrl ? "✦ 一键网感" : "生成后可使用一键网感"}</button>
            </div>
            {lipSyncError ? <div className="video-agent-error" role="alert">{lipSyncError}</div> : null}
          </section>
        </div>
        <aside className="video-builder-preview lip-sync-preview">
          <div className="video-preview-head"><div><b>成片监看</b><small>{lipSyncResultUrl ? "对口型结果" : lipVideoPreviewUrl ? "原始视频" : "等待视频"}</small></div><span>{lipSyncBusy ? `${lipSyncProgress || 0}%` : lipSyncResultUrl ? "已完成" : `第 ${lipSyncCurrentStep} 步`}</span></div>
          <div className={`video-phone-frame is-lip ${lipVideoPreviewUrl || lipSyncResultUrl ? "has-video" : ""}`}>{lipSyncResultUrl ? <video src={lipSyncResultUrl} controls playsInline preload="metadata" /> : lipVideoPreviewUrl ? <video src={lipVideoPreviewUrl} controls muted playsInline preload="metadata" /> : <div><i>●</i><b>上传视频后在这里预览</b><span>{currentVoiceName} · 9:16 竖版</span></div>}</div>
          <div className="lip-sync-preview-state"><small>当前任务</small><b>{lipSyncResultUrl ? "成片已生成" : lipSyncBusy ? "正在同步人物口型" : lipSyncCurrentStep === 1 ? "先选择声音" : lipSyncCurrentStep === 2 ? "生成口播音频" : lipSyncCurrentStep === 3 ? "上传人物视频" : "素材齐全，可以生成"}</b><span>{lipSyncResultUrl ? "可播放检查，或进入一键网感继续包装" : `${currentVoiceName}${lipVideoName ? ` · ${lipVideoSize.width} × ${lipVideoSize.height}` : ""}`}</span></div>
        </aside>
      </div>
    </section>;
  }

  if (workspace === "viral-edit") {
    const templates = viralTemplates;
    const selectedViralTemplate = viralTemplateById(viralTemplate, viralTemplates);
    const viralCurrentStep = viralResultUrl || viralProcessStarted ? 4 : viralCaptionsConfirmed ? 3 : viralFiles.length ? 2 : 1;
    return <section className="video-workspace viral-edit-workspace">
      <header className="video-workspace-head viral-edit-workspace-head">
        <button type="button" onClick={() => openVideoWorkspace("chooser")}>← 返回短视频</button>
        <div><h1>一键网感剪辑</h1></div>
        <span>{viralResultUrl ? "成片已完成" : `正在制作 · 第 ${viralCurrentStep} 步`}</span>
      </header>
      <nav className="viral-edit-progress" aria-label="一键网感剪辑制作进度">
        {[
          { label: "原片", detail: viralFiles.length ? "视频已导入" : "导入口播视频" },
          { label: "文案", detail: viralCaptionsConfirmed ? "标题口播已确认" : "核对标题口播" },
          { label: "模板", detail: viralCaptionsConfirmed ? selectedViralTemplate.name : "选择包装风格" },
          { label: "成片", detail: viralResultUrl ? "制作完成" : viralProcessBusy ? `${viralProgress}%` : "生成网感视频" },
        ].map((item, index) => {
          const step = index + 1;
          const isComplete = step < viralCurrentStep || Boolean(viralResultUrl);
          const isActive = step === viralCurrentStep && !viralResultUrl;
          return <span className={isComplete ? "complete" : isActive ? "active" : ""} aria-current={isActive ? "step" : undefined} key={item.label}>
            <i>{step}</i><b>{item.label}</b><small>{item.detail}</small>
          </span>;
        })}
      </nav>
      <div className="viral-quick-shell">
        <section className={`viral-source-pane viral-edit-step-card ${viralFiles.length ? "is-complete" : "is-active"}`}>
          <div className="viral-pane-heading">
            <i>01</i><span><b>导入口播原片</b></span>
            <label><input type="file" accept="video/*" onChange={addViralFiles} />{viralFiles.length ? "更换原片" : "导入原片"}</label>
          </div>
          <div className={`viral-main-preview template-${viralTemplate}`}>
            {viralVideoPreviewUrl ? <video src={viralVideoPreviewUrl} poster={viralCoverUrl || undefined} controls playsInline preload="metadata" onLoadedMetadata={(event) => setViralSourceResolution(`${event.currentTarget.videoWidth} × ${event.currentTarget.videoHeight}`)} onLoadedData={(event) => { if (!viralCoverUrl) { const cover = viralFrameDataUrl(event.currentTarget, 900); if (cover) setViralCoverUrl(cover); } }} /> : <div className="viral-empty-video">导入视频后在这里预览</div>}
            {viralCoverUrl ? <span className="viral-cover-badge">首帧封面</span> : null}
          </div>
          <section className="viral-source-transcript">
            <header>
              <i>02</i><span><b>核对标题与口播</b></span>
              <button type="button" disabled={!viralFiles.length || viralImportPreparing || viralTranscriptBusy || viralProcessBusy} onClick={() => viralCaptions.length ? openViralTranscriptReview() : void extractViralTranscript()}>{viralImportPreparing ? "正在读取会员视频…" : viralTranscriptBusy ? `AI 正在排版 · ${viralTranscriptProgress}%` : viralCaptions.length ? "查看并修改文案" : "AI 识别并排版"}</button>
            </header>
            {viralCaptions.length ? <div className={`viral-transcript-status ${viralCaptionsConfirmed ? "is-confirmed" : ""}`}>
              <span><b>{viralCaptionsConfirmed ? "标题与字幕已确认" : "AI 排版已完成，等待确认"}</b><small>{viralTitle || `${viralCaptions.length} 段字幕`}</small></span>
              <button type="button" onClick={openViralTranscriptReview}>{viralCaptionsConfirmed ? "修改" : "确认"}</button>
            </div> : null}
            {viralTranscriptError ? <div className="video-agent-error viral-transcript-error" role="alert">{viralTranscriptError}</div> : null}
          </section>
        </section>
        <section className={`viral-template-pane viral-edit-step-card ${viralCaptionsConfirmed ? "is-active" : "is-pending"}`}>
          <div className="viral-pane-heading">
            <i>03</i><span><b>选择网感模板</b></span>
            <em>{templates.find((template) => template.id === viralTemplate)?.name}</em>
          </div>
          <div className="viral-template-grid is-quick">
            {viralTemplatesLoading ? <p className="viral-template-state">正在同步管理员模板库…</p> : null}
            {!viralTemplatesLoading && viralTemplatesError ? <p className="viral-template-state is-error">{viralTemplatesError}</p> : null}
            {!viralTemplatesLoading && !viralTemplatesError && !templates.length ? <p className="viral-template-state">管理员暂未上架网感模板。</p> : null}
            {templates.map((template) => <button type="button" key={template.id} className={`viral-template-card ${viralTemplate === template.id ? "selected" : ""}`} aria-pressed={viralTemplate === template.id} aria-label={`选择${template.name}模板`} onClick={() => setViralTemplate(template.id)}>
              <span className={`template-thumb template-${template.id}`}>
                {template.previewUrl ? <video
                  key={`${template.id}-${template.previewUrl}`}
                  src={template.previewUrl}
                  muted
                  loop
                  playsInline
                  preload="auto"
                  autoPlay={viralTemplate === template.id}
                  onMouseEnter={(event) => {
                    const video = event.currentTarget;
                    void video.play().catch((error: unknown) => {
                      // Moving between preview cards can pause a pending play request.
                      // That interruption is expected and should not reach the dev overlay.
                      if (error instanceof DOMException && error.name === "AbortError") return;
                    });
                  }}
                  onMouseLeave={(event) => { if (viralTemplate !== template.id) event.currentTarget.pause(); }}
                /> : template.coverUrl ? <img src={template.coverUrl} alt={`${template.name}模板封面`} loading="lazy" /> : <video src={viralVideoPreviewUrl} muted playsInline preload="metadata" />}
                {viralTemplate === template.id ? <i>已选</i> : null}
              </span>
              <strong>{template.name}</strong>
            </button>)}
          </div>
          <div className="viral-process-bar">
            <span>保留原片声音</span>
            <label><input type="checkbox" checked={viralIncludeSfx} onChange={(event) => setViralIncludeSfx(event.target.checked)} />添加音效</label>
            <label><input type="checkbox" checked={viralIncludeBgm} onChange={(event) => setViralIncludeBgm(event.target.checked)} />添加背景音乐</label>
            <div><button type="button" disabled={!templates.length || !viralFiles.length || !viralTitle.trim() || !viralCaptionsConfirmed || !viralCaptions.length || viralProcessBusy || viralTranscriptBusy} onClick={() => void processViralVideo()}>{viralProcessBusy ? `正在处理 · ${viralProgress}%` : "一键应用模板 · 28积分"}</button></div>
          </div>
        </section>
      </div>
      {viralProcessStarted ? <section className="viral-result-shell">
        <header>
          <div><h2>{viralProcessBusy ? "正在生成网感成片" : viralResultUrl ? "网感成片已完成" : viralFailed ? "本次处理未完成" : "处理状态"}</h2></div>
          <span className={viralResultUrl ? "done" : viralFailed ? "failed" : ""}>{viralResultUrl ? "已完成" : viralProcessBusy ? `${viralProgress}%` : viralFailed ? "已停止并退款" : "未完成"}</span>
        </header>
        <div className="viral-progress-track"><i style={{ width: `${viralProgress}%` }} /></div>
        <div className="viral-result-grid">
          <div className="viral-result-video">{viralResultUrl ? <video src={viralResultUrl} poster={viralCoverUrl || undefined} controls playsInline preload="metadata" /> : <div><b>{viralProgress}%</b><span>{viralStage || "等待开始"}</span></div>}</div>
          <div className="viral-result-controls">
            {viralError ? <div className="video-agent-error" role="alert">{viralError}</div> : null}
            <div className="viral-result-actions">
              {viralResultUrl ? <a
                href={viralDownloadUrl
                  ? `${viralDownloadUrl}?download=1`
                  : `/api/ai/viral-download?source=${encodeURIComponent(viralResultUrl)}&filename=${encodeURIComponent("一键网感成片.mp4")}`}
                download="一键网感成片.mp4"
              >↓ 下载成片</a> : <button type="button" disabled>↓ 下载成片</button>}
              <button type="button" disabled={viralProcessBusy} onClick={() => { setViralProcessStarted(false); setViralResultUrl(""); setViralResultBlob(null); setViralDownloadUrl(""); setViralSaved(false); setViralFailed(false); setViralAnalysisMode(""); setViralProcessingEngine(""); setViralRenderer(""); setViralProgress(0); setViralStage(""); setViralError(""); }}>重新制作</button>
            </div>
          </div>
        </div>
      </section> : null}
      {viralTranscriptDialogOpen ? <div className="viral-transcript-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setViralTranscriptDialogOpen(false); }}>
        <section className="viral-transcript-dialog" role="dialog" aria-modal="true" aria-labelledby="viral-transcript-dialog-title">
          <header>
            <h2 id="viral-transcript-dialog-title">确认标题与字幕</h2>
            <button type="button" aria-label="关闭文案确认弹窗" onClick={() => setViralTranscriptDialogOpen(false)}>×</button>
          </header>
          <div className="viral-transcript-dialog-body">
            <label className="viral-dialog-title-field">
              <span>视频标题</span>
              <div><input autoFocus type="text" maxLength={viralSpeechLanguage(viralReviewCaptions.map((caption) => caption.text).join(" ")) === "en" ? 60 : 16} value={viralReviewTitle} onChange={(event) => setViralReviewTitle(event.target.value)} /><em>{viralReviewTitle.trim().length}/{viralSpeechLanguage(viralReviewCaptions.map((caption) => caption.text).join(" ")) === "en" ? 60 : 16}</em></div>
            </label>
            <div className="viral-dialog-caption-list" aria-label="AI 排版字幕">
              {viralReviewCaptions.map((caption, index) => <label key={`${caption.start}-${index}`}>
                <span>{viralTimestamp(caption.start)}–{viralTimestamp(caption.end)}</span>
                <input type="text" value={caption.text} aria-label={`第${index + 1}段字幕`} onChange={(event) => setViralReviewCaptions((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, text: event.target.value } : item))} />
              </label>)}
            </div>
          </div>
          <footer>
            <button type="button" onClick={() => setViralTranscriptDialogOpen(false)}>稍后确认</button>
            <button type="button" disabled={!viralReviewTitle.trim() || !viralReviewCaptions.length || viralReviewCaptions.some((caption) => !caption.text.trim())} onClick={confirmViralTranscriptReview}>确认并使用</button>
          </footer>
        </section>
      </div> : null}
    </section>;
  }

  return <><ToolHeading title="短视频制作" /><div className="video-modes"><article><i>▶</i><h3>素材智能成片</h3><button type="button" onClick={() => openVideoWorkspace("material")}>开始制作 →</button></article><article className="ai-director-mode"><i>◆</i><h3>AI成片</h3><button type="button" onClick={() => openVideoWorkspace("ai-director")}>开始制作 →</button></article><article><i>●</i><h3>对口型视频</h3><button type="button" onClick={() => openVideoWorkspace("lip-sync")}>开始制作 →</button></article><article><i>✦</i><h3>一键网感剪辑</h3><button type="button" onClick={() => openVideoWorkspace("viral-edit")}>开始制作 →</button></article><article><i>▣</i><h3>AI超级剪辑</h3><button type="button" onClick={() => window.location.assign("/ai-explainer/index.html")}>开始制作 →</button></article></div></>;
}

function formatAssetTime(value: number) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function walletDateKey(value: number) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value * 1000));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function walletDayLabel(key: string) {
  const now = Math.floor(Date.now() / 1000);
  if (key === walletDateKey(now)) return "今日";
  if (key === walletDateKey(now - 86_400)) return "昨日";
  const [year, month, day] = key.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}

function walletRecordTime(value: number, includeDate = false) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    ...(includeDate ? { year: "numeric", month: "2-digit", day: "2-digit" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value * 1000));
}

function walletReference(value: string | null) {
  if (!value) return "系统流水";
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}…${value.slice(-5)}`;
}

function formatAssetSize(value: number) {
  if (!value) return "已保存";
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function Assets({ initialFilter = "all", onUseViral }: { initialFilter?: AssetFilter; onUseViral: (asset: MemberAssetItem) => void }) {
  const [items, setItems] = useState<MemberAssetItem[]>([]);
  const [filter, setFilter] = useState<AssetFilter>(initialFilter);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedAsset, setSelectedAsset] = useState<MemberAssetItem | null>(null);
  const [syncing, setSyncing] = useState(false);

  async function loadAssets() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/member/assets", { cache: "no-store" });
      const data = await response.json() as { error?: string; items?: MemberAssetItem[] };
      if (!response.ok) throw new Error(data.error || "会员资产读取失败。");
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "会员资产读取失败。");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    queueMicrotask(() => void loadAssets());
    const refresh = () => void loadAssets();
    window.addEventListener("member-assets-updated", refresh);
    return () => window.removeEventListener("member-assets-updated", refresh);
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      setFilter(initialFilter);
      setSelectedAsset(null);
    });
  }, [initialFilter]);

  async function deleteAsset(item: MemberAssetItem) {
    const response = await fetch(`/api/member/assets/${encodeURIComponent(item.id)}`, { method: "DELETE" });
    if (!response.ok) return setError("删除失败，请稍后重试。");
    setItems((current) => current.filter((asset) => asset.id !== item.id));
    if (selectedAsset?.id === item.id) setSelectedAsset(null);
  }

  const visibleItems = filter === "all" ? items : filter === "audio" ? items.filter((item) => item.kind === "audio" || item.kind === "voice") : items.filter((item) => item.kind === filter);
  const projects = [...visibleItems.reduce((groups, item) => {
    const current = groups.get(item.projectName) ?? [];
    current.push(item);
    groups.set(item.projectName, current);
    return groups;
  }, new Map<string, MemberAssetItem[]>())].sort((left, right) => (right[1][0]?.createdAt || 0) - (left[1][0]?.createdAt || 0));
  const imageCount = items.filter((item) => item.kind === "image").length;
  const videoCount = items.filter((item) => item.kind === "video").length;
  const audioCount = items.filter((item) => item.kind === "audio" || item.kind === "voice").length;
  const usedBytes = items.reduce((total, item) => total + item.sizeBytes, 0);

  return <>
    <ToolHeading title="会员资产空间" />
    <div className="asset-summary asset-summary-live"><div><b>{usedBytes ? formatAssetSize(usedBytes) : `${items.length} 个资产`}</b><span>图片保存 30 天 · 视频保存 7 天</span><i><em style={{ width: `${Math.min(100, Math.max(3, usedBytes / (1024 * 1024 * 1024) * 100))}%` }} /></i></div><button disabled={syncing} onClick={() => { setSyncing(true); void loadAssets().finally(() => window.setTimeout(() => setSyncing(false), 500)); }}>{syncing ? "同步中…" : "↻ 立即同步"}</button></div>
    <div className="asset-groups asset-filter-groups">
      <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}><i>全</i><b>全部资产</b><span>{items.length} 个</span></button>
      <button className={filter === "image" ? "active" : ""} onClick={() => setFilter("image")}><i>图</i><b>生成图片</b><span>{imageCount} 个</span></button>
      <button className={filter === "video" ? "active" : ""} onClick={() => setFilter("video")}><i>视</i><b>生成短视频</b><span>{videoCount} 个</span></button>
      <button className={filter === "audio" ? "active" : ""} onClick={() => setFilter("audio")}><i>声</i><b>声音与音频</b><span>{audioCount} 个</span></button>
    </div>
    {error ? <div className="asset-state is-error"><b>资产空间暂时无法打开</b><span>{error}</span><button onClick={() => void loadAssets()}>重新加载</button></div> : loading ? <div className="asset-state"><i /><b>正在读取会员资产</b><span>生成记录正在按项目整理</span></div> : projects.length ? <div className="asset-project-list">{projects.map(([projectName, projectItems]) => <section className="asset-project" key={projectName}><header><div><small>项目</small><h2>{projectName}</h2></div><span>{formatAssetTime(projectItems[0].createdAt)} · {projectItems.length} 个文件</span></header><div className="asset-item-grid">{projectItems.map((item) => <article className={`asset-item is-${item.kind}`} key={item.id}><button className="asset-media" onClick={() => setSelectedAsset(item)} aria-label={`打开${item.name}`}>{item.kind === "image" ? <img src={item.mediaUrl} alt={item.name} loading="lazy" /> : item.kind === "video" ? <video src={item.mediaUrl} poster={item.coverUrl || undefined} preload="metadata" muted /> : <span>{item.kind === "voice" ? "声" : "音"}</span>}<i>{item.kind === "video" ? "▶" : item.kind === "image" ? "查看" : "播放"}</i></button><div><b>{item.name}</b><span>{formatAssetTime(item.createdAt)} · {formatAssetSize(item.sizeBytes)}</span></div><div className="asset-item-actions"><a href={`${item.mediaUrl}?download=1`} download={item.name}>下载</a><button onClick={() => void deleteAsset(item)}>删除</button></div></article>)}</div></section>)}</div> : <div className="asset-state is-empty"><b>还没有{filter === "all" ? "会员资产" : filter === "image" ? "生成图片" : filter === "video" ? "生成短视频" : "声音文件"}</b><span>完成一次 AI 生成后，结果会自动按项目名称与时间出现在这里。</span></div>}
    {selectedAsset ? <div className="asset-viewer-backdrop" role="dialog" aria-modal="true" aria-label="查看会员资产" onMouseDown={(event) => { if (event.currentTarget === event.target) setSelectedAsset(null); }}><section className="asset-viewer"><button className="asset-viewer-close" aria-label="关闭" onClick={() => setSelectedAsset(null)}>×</button><header><small>{selectedAsset.projectName}</small><h2>{selectedAsset.name}</h2><span>{formatAssetTime(selectedAsset.createdAt)}</span></header>{selectedAsset.kind === "image" ? <img src={selectedAsset.mediaUrl} alt={selectedAsset.name} /> : selectedAsset.kind === "video" ? <video src={selectedAsset.mediaUrl} poster={selectedAsset.coverUrl || undefined} controls autoPlay playsInline disablePictureInPicture /> : <audio src={selectedAsset.mediaUrl} controls autoPlay />}<footer><a href={`${selectedAsset.mediaUrl}?download=1`} download={selectedAsset.name}>↓ 下载文件</a>{selectedAsset.kind === "video" ? <button className="asset-viewer-viral" onClick={() => onUseViral(selectedAsset)}>✦ 一键网感</button> : null}<button onClick={() => setSelectedAsset(null)}>关闭</button></footer></section></div> : null}
  </>;
}

function Member({
  points,
  onPointsChange,
  onOpenAssets,
}: {
  points: number;
  onPointsChange: (points: number) => void;
  onOpenAssets: (filter: Exclude<AssetFilter, "all">) => void;
}) {
  const [recharging, setRecharging] = useState(false);
  const [rechargeMessage, setRechargeMessage] = useState("");
  const [assetItems, setAssetItems] = useState<MemberAssetItem[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(true);
  const [rechargePackages, setRechargePackages] = useState<Array<{ id: string; name: string; totalPoints: number; priceYuan: number }>>([]);
  const [selectedRecharge, setSelectedRecharge] = useState("");
  const [historyTab, setHistoryTab] = useState<"consumption" | "recharge">("consumption");
  const [walletHistory, setWalletHistory] = useState<WalletHistory>({ consumption: [], recharge: [] });
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      setAssetsLoading(true);
      try {
        const response = await fetch("/api/member/assets", { cache: "no-store" });
        const data = await response.json() as { items?: MemberAssetItem[] };
        if (mounted && response.ok) setAssetItems(Array.isArray(data.items) ? data.items : []);
      } catch {
        if (mounted) setAssetItems([]);
      } finally {
        if (mounted) setAssetsLoading(false);
      }
    };
    void load();
    const refresh = () => void load();
    window.addEventListener("member-assets-updated", refresh);
    return () => {
      mounted = false;
      window.removeEventListener("member-assets-updated", refresh);
    };
  }, []);

  async function loadWalletHistory() {
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const response = await fetch("/api/member/wallet/history", { cache: "no-store" });
      const data = await response.json() as { error?: string; history?: Partial<WalletHistory> };
      if (!response.ok) throw new Error(data.error || "积分记录读取失败。");
      setWalletHistory({
        consumption: Array.isArray(data.history?.consumption) ? data.history.consumption : [],
        recharge: Array.isArray(data.history?.recharge) ? data.history.recharge : [],
      });
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "积分记录读取失败。");
    } finally {
      setHistoryLoading(false);
    }
  }

  useEffect(() => {
    queueMicrotask(() => void loadWalletHistory());
  }, []);

  useEffect(() => {
    fetch("/api/member/wallet", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: { rechargePackages?: Array<{ id: string; name: string; totalPoints: number; priceYuan: number }> }) => {
        const packages = Array.isArray(data.rechargePackages) ? data.rechargePackages : [];
        setRechargePackages(packages);
        setSelectedRecharge((current) => current || packages[0]?.id || "");
      })
      .catch(() => undefined);
  }, []);

  async function rechargeDemoPoints() {
    if (recharging) return;
    setRecharging(true);
    setRechargeMessage("");
    try {
      const selected = rechargePackages.find((item) => item.id === selectedRecharge);
      if (!selected) throw new Error("请选择充值套餐。");
      const response = await fetch("/api/member/wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: selected.totalPoints, requestId: `demo-topup-${crypto.randomUUID()}` }),
      });
      const data = await response.json() as { error?: string; wallet?: { points?: number } };
      if (!response.ok || typeof data.wallet?.points !== "number") throw new Error(data.error || "充值失败，请稍后重试。");
      onPointsChange(data.wallet.points);
      setRechargeMessage(`${selected.totalPoints}积分已到账`);
      await loadWalletHistory();
    } catch (error) {
      setRechargeMessage(error instanceof Error ? error.message : "充值失败，请稍后重试。");
    } finally {
      setRecharging(false);
    }
  }

  const imageCount = assetItems.filter((item) => item.kind === "image").length;
  const videoCount = assetItems.filter((item) => item.kind === "video").length;
  const voiceCount = assetItems.filter((item) => item.kind === "voice" || item.kind === "audio").length;

  const currentPackage = rechargePackages.find((item) => item.id === selectedRecharge);
  const consumptionDays = [...walletHistory.consumption.reduce((groups, item) => {
    const key = walletDateKey(item.createdAt);
    const records = groups.get(key) ?? [];
    records.push(item);
    groups.set(key, records);
    return groups;
  }, new Map<string, WalletHistoryEntry[]>())];
  const activeRecords = historyTab === "consumption" ? walletHistory.consumption : walletHistory.recharge;

  return <>
    <ToolHeading title="会员与资产" />
    <div className="member-balance"><div><small>会员积分</small><b>{points.toLocaleString()} <span>PTS</span></b>{rechargeMessage ? <em role="status">{rechargeMessage}</em> : null}</div><div className="member-recharge-actions"><select value={selectedRecharge} onChange={(event) => setSelectedRecharge(event.target.value)}>{rechargePackages.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.totalPoints}积分</option>)}</select><button type="button" disabled={recharging || !currentPackage} onClick={() => void rechargeDemoPoints()}>{recharging ? "充值处理中…" : currentPackage ? `演示充值 ¥${currentPackage.priceYuan}` : "暂无充值套餐"}</button></div></div>

    <section className="member-history-panel" aria-labelledby="member-history-title">
      <header className="member-history-toolbar">
        <div><h2 id="member-history-title">账户记录</h2><p>消费按日期归档，充值逐笔留存。</p></div>
        <div className="member-history-tabs" role="tablist" aria-label="账户记录类型">
          <button type="button" role="tab" aria-selected={historyTab === "consumption"} className={historyTab === "consumption" ? "active" : ""} onClick={() => setHistoryTab("consumption")}>消费记录 <span>{walletHistory.consumption.length}</span></button>
          <button type="button" role="tab" aria-selected={historyTab === "recharge"} className={historyTab === "recharge" ? "active" : ""} onClick={() => setHistoryTab("recharge")}>充值记录 <span>{walletHistory.recharge.length}</span></button>
        </div>
      </header>

      {historyLoading ? <div className="member-history-state" role="status"><i /><b>正在核对账户流水</b><span>已结算记录马上就好</span></div> : historyError ? <div className="member-history-state is-error"><b>账户记录暂时无法打开</b><span>{historyError}</span><button type="button" onClick={() => void loadWalletHistory()}>重新加载</button></div> : !activeRecords.length ? <div className="member-history-state is-empty"><b>{historyTab === "consumption" ? "还没有消费记录" : "还没有充值记录"}</b><span>{historyTab === "consumption" ? "完成一次需要积分的 AI 任务后，明细会按日期出现在这里。" : "每次充值到账后，记录会保存在这里。"}</span></div> : historyTab === "consumption" ? <div className="member-history-days" role="tabpanel">
        {consumptionDays.map(([key, records]) => <section className="member-history-day" key={key}>
          <header><div><h3>{walletDayLabel(key)}</h3><span>{records.length} 笔已结算消费</span></div><b>-{records.reduce((total, item) => total + Math.abs(item.delta), 0).toLocaleString()} PTS</b></header>
          <div className="member-history-list">{records.map((item) => <article className="member-history-row" key={item.id}><div><b>{item.reason}</b><span>{walletRecordTime(item.createdAt)} · <span title={item.taskId || undefined}>{walletReference(item.taskId)}</span></span></div><strong className="is-consumption">-{Math.abs(item.delta).toLocaleString()} PTS</strong><small>余额 {item.balanceAfter.toLocaleString()}</small></article>)}</div>
        </section>)}
      </div> : <div className="member-history-list is-recharge" role="tabpanel">
        {walletHistory.recharge.map((item) => <article className="member-history-row" key={item.id}><div><b>{item.reason}</b><span>{walletRecordTime(item.createdAt, true)} · <span title={item.taskId || undefined}>{walletReference(item.taskId)}</span></span></div><strong className="is-recharge">+{item.delta.toLocaleString()} PTS</strong><small>到账后余额 {item.balanceAfter.toLocaleString()}</small></article>)}
      </div>}
      <footer className="member-history-note">消费记录仅展示已结算积分，失败任务的退回积分不会计入消费。</footer>
    </section>

    <div className="member-assets-heading"><h2>我的资产</h2><span>{assetsLoading ? "正在同步…" : `共 ${assetItems.length} 个资产`}</span></div><div className="member-grid"><article><span>账户状态</span><b>正常</b></article><button type="button" onClick={() => onOpenAssets("image")} aria-label={`打开图片素材，共 ${imageCount} 个`}><span>图片素材</span><b>{assetsLoading ? "—" : imageCount}</b></button><button type="button" onClick={() => onOpenAssets("video")} aria-label={`打开视频素材，共 ${videoCount} 个`}><span>视频素材</span><b>{assetsLoading ? "—" : videoCount}</b></button><button type="button" onClick={() => onOpenAssets("audio")} aria-label={`打开克隆声音，共 ${voiceCount} 个`}><span>克隆声音</span><b>{assetsLoading ? "—" : voiceCount}</b></button></div>
  </>;
}

function ToolHeading({ title }: { title: string }) { return <div className="tool-heading"><h1>{title}</h1></div>; }
