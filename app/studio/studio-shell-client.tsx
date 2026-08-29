"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CaretRight, ChartLineUp, FolderOpen, House, ImageSquare, Plus, UserCircle, VideoCamera } from "@phosphor-icons/react";
import type { MemberSession } from "../member-session";
import type { PlatformFeature } from "../../lib/server/platform-settings";
import type { ViralWorkflowManifest } from "../../lib/viral-workflow";
import type { AssetFilter, MemberAssetItem } from "./studio-client";
import { publicMediaCdnEnabled, publicMediaUrl } from "../../lib/public-media";

const IndustryImageLab = dynamic(
  () => import("./image-lab").then((module) => module.IndustryImageLab),
  { loading: () => <StudioModuleLoading label="正在打开图片创作" /> },
);
const MarketDynamics = dynamic(
  () => import("./market-dynamics").then((module) => module.MarketDynamics),
  { loading: () => <StudioModuleLoading label="正在读取市场动态" /> },
);
const Video = dynamic(
  () => import("./studio-client").then((module) => module.Video),
  { loading: () => <StudioModuleLoading label="正在打开视频创作" /> },
);
const Assets = dynamic(
  () => import("./studio-client").then((module) => module.Assets),
  { loading: () => <StudioModuleLoading label="正在整理创作资产" /> },
);
const Member = dynamic(
  () => import("./studio-client").then((module) => module.Member),
  { loading: () => <StudioModuleLoading label="正在打开账号中心" /> },
);
const AccountDialog = dynamic(
  () => import("./studio-client").then((module) => module.AccountDialog),
);
const AiAssistant = dynamic(
  () => import("./ai-assistant").then((module) => module.AiAssistant),
  { loading: () => null },
);

const menu = [
  { id: "overview", label: "创作首页" },
  { id: "design", label: "图片创作" },
  { id: "video", label: "视频创作" },
  { id: "cases", label: "市场动态" },
  { id: "assets", label: "创作资产" },
  { id: "member", label: "账号中心" },
];

const menuIcons = {
  overview: House,
  design: ImageSquare,
  video: VideoCamera,
  cases: ChartLineUp,
  assets: FolderOpen,
  member: UserCircle,
};

const studioLabels: Record<string, string> = Object.fromEntries(menu.map((item) => [item.id, item.label]));
const STUDIO_ACTIVE_SESSION_KEY = "merchant-studio-active-section";

function afterFirstPaint(callback: () => void, delay = 350) {
  let timer = 0;
  const frame = window.requestAnimationFrame(() => {
    timer = window.setTimeout(callback, delay);
  });
  return () => {
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
  };
}

function StudioModuleLoading({ label }: { label: string }) {
  return <div className="asset-state" role="status"><i /><b>{label}</b><span>页面框架已就绪</span></div>;
}

export function StudioShellClient({ member, initialFeatures }: { member: MemberSession; initialFeatures: PlatformFeature[] }) {
  const isAdminAccount = member.role === "admin" || member.role === "super_admin";
  const [active, setActive] = useState("overview");
  const [assetInitialFilter, setAssetInitialFilter] = useState<AssetFilter>("all");
  const [viralImportAsset, setViralImportAsset] = useState<{ id: string; name: string; mediaUrl: string; importUrl?: string; contentType?: string; viralWorkflow?: ViralWorkflowManifest | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [memberMenuOpen, setMemberMenuOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [accountDialog, setAccountDialog] = useState<"password" | null>(null);
  const [dialogMessage, setDialogMessage] = useState("");
  const [walletPoints, setWalletPoints] = useState(member.points);
  const memberMenuRef = useRef<HTMLDivElement>(null);
  const visibleMenu = initialFeatures.length
    ? [...initialFeatures].filter((item) => item.enabled).sort((left, right) => left.sortOrder - right.sortOrder).map((item) => ({ id: item.entry, label: item.name || studioLabels[item.entry] }))
    : menu;
  const configuredLabels = Object.fromEntries(
    initialFeatures.map((item) => [item.entry, item.name || studioLabels[item.entry]]),
  ) as Partial<Record<PlatformFeature["entry"], string>>;

  function openStudioSection(section: string) {
    try {
      window.sessionStorage.setItem(STUDIO_ACTIVE_SESSION_KEY, section);
    } catch {
      // Session storage is an enhancement; navigation still works without it.
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
      if (savedSection && Object.hasOwn(studioLabels, savedSection)) queueMicrotask(() => setActive(savedSection));
    } catch {
      // Keep the overview when storage is unavailable.
    }
  }, []);

  useEffect(() => {
    function closeMemberMenu(event: MouseEvent) {
      if (memberMenuRef.current && !memberMenuRef.current.contains(event.target as Node)) setMemberMenuOpen(false);
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
    const controller = new AbortController();
    const cancel = afterFirstPaint(() => {
      fetch("/api/member/wallet", { cache: "no-store", signal: controller.signal })
        .then((response) => response.json())
        .then((data: { wallet?: { points?: number } }) => {
          if (typeof data.wallet?.points === "number") setWalletPoints(data.wallet.points);
        })
        .catch(() => undefined);
    }, 500);
    return () => {
      cancel();
      controller.abort();
    };
  }, []);

  function demoAction() {
    setBusy(true);
    window.setTimeout(() => setBusy(false), 1100);
  }

  return (
    <main className={`studio-shell ${active === "design" ? "is-image-lab" : ""}`}>
      <aside className="studio-sidebar">
        <Link className="studio-brand" href="/" aria-label="爆点实验室首页"><span><Image src={publicMediaUrl("/media/flash-lab-logo.png")} width={512} height={512} sizes="44px" alt="" priority unoptimized={publicMediaCdnEnabled} /></span><div><b>爆点实验室</b></div></Link>
        <nav>
          {visibleMenu.map((item, index) => {
            const MenuIcon = menuIcons[item.id as keyof typeof menuIcons] ?? House;
            return <button className={active === item.id ? "active" : ""} key={`${item.id}-${index}`} onClick={() => {
              if (item.id === "assets") setAssetInitialFilter("all");
              openStudioSection(item.id);
            }}><MenuIcon size={19} weight={active === item.id ? "fill" : "regular"} /><span>{item.label}</span></button>;
          })}
        </nav>
        <div className="sidebar-utility">
          <button type="button" className="sidebar-assistant" onClick={() => setAssistantOpen(true)}>
            <img src={publicMediaUrl("/media/ai-assistant-avatar.svg")} alt="" />
            <span><b>AI 助手</b><small>随时帮您创作</small></span>
            <CaretRight size={16} weight="bold" />
          </button>
          <div className="sidebar-wallet-row">
            <button type="button" className="sidebar-wallet-balance" onClick={() => openStudioSection("member")}><span>创作积分</span><b>{walletPoints.toLocaleString()} <small>PTS</small></b></button>
            <button type="button" className="sidebar-wallet-recharge" onClick={() => openStudioSection("member")}><Plus size={14} weight="bold" /><span>充值</span></button>
          </div>
        </div>
      </aside>

      <section className="studio-main">
        <header className="studio-topbar">
          <div className="member-menu" ref={memberMenuRef}>
            <button type="button" className="member-menu-trigger" aria-haspopup="menu" aria-expanded={memberMenuOpen} onClick={() => setMemberMenuOpen((open) => !open)}>
              <span className="member-menu-copy"><b>{member.displayName}</b></span>
              <i className={`member-chevron ${memberMenuOpen ? "is-open" : ""}`}>菜单</i>
            </button>
            {memberMenuOpen ? <div className="member-dropdown" role="menu" aria-label="会员菜单">
              <div className="member-dropdown-head"><b>{member.displayName}</b><span>{walletPoints.toLocaleString()} 积分可用</span></div>
              <div className="member-dropdown-actions">
                {isAdminAccount ? <a role="menuitem" href="/admin"><span><b>后台管理</b></span><i>›</i></a> : null}
                <button type="button" role="menuitem" onClick={() => { setAccountDialog("password"); setDialogMessage(""); setMemberMenuOpen(false); }}><span><b>修改密码</b></span><i>›</i></button>
              </div>
              <a className="member-logout" role="menuitem" href="/api/auth/logout"><span>退出登录</span><i>↗</i></a>
            </div> : null}
          </div>
        </header>
        <div className="studio-content">
          {active === "overview" && <Overview onOpen={openStudioSection} />}
          {active === "design" && <IndustryImageLab onPointsChange={setWalletPoints} />}
          {active === "video" && <Video memberId={member.id} busy={busy} action={demoAction} onPointsChange={setWalletPoints} viralImportAsset={viralImportAsset} />}
          {active === "cases" && <MarketDynamics title={configuredLabels.cases || studioLabels.cases} />}
          {active === "assets" && <Assets
            initialFilter={assetInitialFilter}
            onUseViral={(asset: MemberAssetItem) => {
              setViralImportAsset({ id: asset.id, name: asset.name, mediaUrl: asset.mediaUrl, importUrl: asset.importUrl, contentType: asset.contentType, viralWorkflow: asset.viralWorkflow });
              openStudioSection("video");
            }}
            onUseSuperEditor={(asset: MemberAssetItem) => {
              window.sessionStorage.setItem("merchant-studio-ai-explainer-source", JSON.stringify({
                id: asset.id,
                name: asset.name,
                mediaUrl: asset.mediaUrl,
                fallbackMediaUrl: asset.importUrl || `${asset.mediaUrl}${asset.mediaUrl.includes("?") ? "&" : "?"}stream=1`,
                transcript: asset.viralWorkflow?.script || "",
                title: asset.viralWorkflow?.title || "",
                duration: asset.viralWorkflow?.duration || 0,
                captions: asset.viralWorkflow?.captions || [],
                source: "member-asset",
                consumed: false,
              }));
              window.location.assign("/ai-explainer/index.html");
            }}
          />}
          {active === "member" && <Member points={walletPoints} onPointsChange={setWalletPoints} onOpenAssets={(filter: Exclude<AssetFilter, "all">) => {
            setAssetInitialFilter(filter);
            openStudioSection("assets");
          }} />}
        </div>
      </section>

      {accountDialog ? <AccountDialog message={dialogMessage} onMessage={setDialogMessage} onClose={() => { setAccountDialog(null); setDialogMessage(""); }} /> : null}
      {assistantOpen ? <AiAssistant open memberName={member.displayName} onClose={() => setAssistantOpen(false)} onPointsChange={setWalletPoints} /> : null}
    </main>
  );
}

function Overview({ onOpen }: { onOpen: (id: string) => void }) {
  const [assets, setAssets] = useState<MemberAssetItem[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(true);
  const [assetsError, setAssetsError] = useState("");
  const [heroReady, setHeroReady] = useState(false);

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
    const cancelHero = afterFirstPaint(() => setHeroReady(true), 120);
    const cancelAssets = afterFirstPaint(() => void loadOverviewAssets(), 900);
    const refresh = () => void loadOverviewAssets();
    window.addEventListener("member-assets-updated", refresh);
    return () => {
      cancelHero();
      cancelAssets();
      window.removeEventListener("member-assets-updated", refresh);
    };
  }, []);

  const recentProjects = Array.from(assets.reduce((projects, item) => {
    if (!projects.has(item.projectName)) projects.set(item.projectName, item);
    return projects;
  }, new Map<string, MemberAssetItem>()).values()).slice(0, 5);
  const quickEntries = [
    { label: "社交海报", tone: "yellow", action: "design" },
    { label: "小绿书", tone: "cyan", action: "design" },
    { label: "对口型", tone: "pink", action: "video" },
    { label: "一键网感", tone: "yellow", action: "video" },
  ];
  const kindLabel = (kind: MemberAssetItem["kind"]) => kind === "image" ? "生成图片" : kind === "video" ? "生成短视频" : kind === "voice" ? "克隆声音" : "口播音频";

  return <div className="hyper-home">
    <section className="hyper-hero">
      <video className="hyper-hero-art" src={heroReady ? publicMediaUrl("/media/flash-lab-hero-20260808.mp4") : undefined} poster={publicMediaUrl("/media/flash-lab-hero-poster.jpg")} autoPlay muted loop playsInline preload="metadata" disablePictureInPicture aria-hidden="true" />
      <div className="hyper-hero-copy"><h1>把灵感<br /><span>放大</span></h1><p>图片、视频、声音，一站式完成。</p></div>
      <div className="hyper-main-actions"><button className="is-image" onClick={() => onOpen("design")}><span>图片创作</span></button><button className="is-video" onClick={() => onOpen("video")}><span>视频创作</span></button></div>
    </section>
    <section className="hyper-shortcuts" aria-label="快速创作">{quickEntries.map((entry) => <button className={`is-${entry.tone}`} key={entry.label} onClick={() => onOpen(entry.action)}><span>{entry.label}</span></button>)}</section>
    <section className="hyper-recent">
      <header><h2>最近项目</h2><button disabled={assetsLoading} onClick={() => void loadOverviewAssets()}>{assetsLoading ? "同步中" : "同步作品"}</button></header>
      <div className="hyper-project-grid">
        {recentProjects.length ? recentProjects.map((item, index) => <button className={`hyper-project-card tone-${index + 1}`} key={item.id} onClick={() => onOpen("assets")}>
          <span className="hyper-project-media">{item.kind === "image" ? <img src={item.mediaUrl} alt={item.projectName} loading="lazy" decoding="async" /> : item.kind === "video" ? <video src={item.mediaUrl} poster={item.coverUrl || undefined} preload="metadata" muted playsInline onLoadedMetadata={(event) => { const video = event.currentTarget; if (!item.coverUrl && Number.isFinite(video.duration) && video.duration > 0.08) video.currentTime = Math.min(0.12, video.duration / 2); }} /> : <b>{item.kind === "voice" ? "VOICE" : "AUDIO"}</b>}</span>
          <strong>{item.projectName}</strong><em>{kindLabel(item.kind)} · {formatAssetTime(item.createdAt)}</em>
        </button>) : ["赛博广告", "潮流视频", "视觉海报", "网感短片", "内容实验"].map((name, index) => <button className={`hyper-project-card is-placeholder tone-${index + 1}`} key={name} onClick={() => onOpen(index % 2 ? "video" : "design")}><span className="hyper-project-media"><b>{String(index + 1).padStart(2, "0")}</b></span><strong>{name}</strong><em>{assetsError ? "等待同步" : "新建项目"}</em></button>)}
      </div>
    </section>
  </div>;
}

function formatAssetTime(value: number) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}
