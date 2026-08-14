"use client";

import {
  ArrowClockwise,
  BellRinging,
  BookmarkSimple,
  ChartLineUp,
  ChatCircleDots,
  CheckCircle,
  Eye,
  Heart,
  LinkSimple,
  MagnifyingGlass,
  Play,
  Plus,
  ShareNetwork,
  Trash,
  TrendUp,
  UserFocus,
  VideoCamera,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";

/*
THESIS: 把账号追踪做成一张持续更新的数据打样单，拒绝泛白数据看板。
OWN-WORLD: 石墨工位、完整细边框、品红主操作、电子青焦点、信号黄提醒；无衬线紧凑排版。
STORY: 先确认监控对象，再浏览最新作品，最后读取单条变化并安排下一步拆解。
FIRST VIEWPORT: 标题与主操作居顶；账号身份和关键数据合并为主工单；作品联系表紧随其后，账号队列退居侧栏，移动端先展示作品。
FORM: Monitoring proof ledger，既有产品世界的第一顺位延展；seed MARKET-PROOF-LEDGER-01。
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
*/

type MarketAccount = {
  id: string;
  platform: string;
  sourceUrl: string;
  secUid: string;
  nickname: string;
  handle: string;
  avatarUrl: string;
  signature: string;
  status: "pending" | "syncing" | "ready" | "error";
  statusMessage: string;
  followerCount: number;
  followingCount: number;
  totalLikes: number;
  videoCount: number;
  lastSyncAt: number | null;
  nextSyncAt: number | null;
  createdAt: number;
  demo?: boolean;
};

type MarketVideo = {
  id: string;
  title: string;
  cover: string;
  published: string;
  duration: string;
  plays: number | null;
  likes: number;
  comments: number;
  shares: number;
  collects: number;
  growth: number;
  recent?: boolean;
};

const DEMO_ACCOUNT: MarketAccount = {
  id: "market-demo",
  platform: "douyin",
  sourceUrl: "",
  secUid: "",
  nickname: "本地生活增长观察站",
  handle: "抖音号：MarketLab",
  avatarUrl: "/media/flash-lab-logo.png",
  signature: "拆解门店短视频内容结构，持续观察选题、节奏与互动增长。",
  status: "ready",
  statusMessage: "界面预览数据",
  followerCount: 128_000,
  followingCount: 318,
  totalLikes: 2_846_000,
  videoCount: 186,
  lastSyncAt: Date.now() - 8 * 60 * 1000,
  nextSyncAt: Date.now() + 22 * 60 * 1000,
  createdAt: Date.now(),
  demo: true,
};

const DEMO_VIDEOS: MarketVideo[] = [
  { id: "v1", title: "门店短视频开场，前三秒一定要说清这件事", cover: "/template-covers/viral-pulse-cover-v23.jpg", published: "今天 11:26", duration: "00:38", plays: 286_000, likes: 18_600, comments: 1_238, shares: 3_409, collects: 7_611, growth: 42, recent: true },
  { id: "v2", title: "同样的产品，为什么别人的画面更有成交感", cover: "/template-covers/template-2-cover-v23.jpg", published: "昨天 19:42", duration: "00:52", plays: 168_000, likes: 9_842, comments: 684, shares: 1_932, collects: 5_107, growth: 31, recent: true },
  { id: "v3", title: "把一个卖点拆成三条内容，账号就有连续性", cover: "/template-covers/template-3-cover-v23.jpg", published: "08月12日", duration: "01:06", plays: 92_400, likes: 6_218, comments: 510, shares: 862, collects: 3_287, growth: 18 },
  { id: "v4", title: "本地生活账号常用的四种镜头推进方式", cover: "/template-covers/template-4-cover-v23.jpg", published: "08月11日", duration: "00:47", plays: 73_800, likes: 4_903, comments: 327, shares: 716, collects: 2_845, growth: 14 },
  { id: "v5", title: "知识口播不枯燥，字幕应该承担什么任务", cover: "/template-covers/template-5-cover-v23.jpg", published: "08月09日", duration: "00:59", plays: 121_000, likes: 8_426, comments: 598, shares: 1_207, collects: 4_921, growth: 26 },
  { id: "v6", title: "用户不是不感兴趣，而是你进入观点太慢", cover: "/template-covers/template-6-cover-v23.jpg", published: "08月07日", duration: "00:44", plays: 64_200, likes: 3_788, comments: 261, shares: 554, collects: 2_034, growth: 9 },
  { id: "v7", title: "一条视频只有一个重点，表达反而更有力量", cover: "/template-covers/template-7-cover-v23.jpg", published: "08月05日", duration: "00:36", plays: 87_600, likes: 5_512, comments: 404, shares: 909, collects: 2_986, growth: 12 },
  { id: "v8", title: "复盘短视频时，先别急着只看播放量", cover: "/template-covers/template-8-cover-v23.jpg", published: "08月03日", duration: "01:12", plays: 156_000, likes: 10_284, comments: 782, shares: 1_486, collects: 5_632, growth: 22 },
];

const TREND = [38, 44, 41, 53, 61, 58, 76, 83, 79, 92, 88, 100];

function compactNumber(value: number | null) {
  if (value === null) return "暂无";
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(value >= 1_000_000_000 ? 0 : 1)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(value >= 100_000 ? 1 : 2).replace(/\.0+$/, "")}万`;
  return value.toLocaleString("zh-CN");
}

function relativeTime(value: number | null) {
  if (!value) return "尚未同步";
  const minutes = Math.round((Date.now() - value) / 60_000);
  if (minutes < 1) return "刚刚同步";
  if (minutes < 60) return `${minutes}分钟前同步`;
  return `${Math.round(minutes / 60)}小时前同步`;
}

export function MarketDynamics({ title }: { title: string }) {
  const [accounts, setAccounts] = useState<MarketAccount[]>([]);
  const [selectedId, setSelectedId] = useState(DEMO_ACCOUNT.id);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [sourceUrl, setSourceUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const [search, setSearch] = useState("");
  const [videoFilter, setVideoFilter] = useState<"all" | "recent" | "rising">("all");
  const [selectedVideoId, setSelectedVideoId] = useState(DEMO_VIDEOS[0].id);
  const [syncing, setSyncing] = useState(false);

  async function loadAccounts() {
    setLoading(true);
    setLoadError("");
    try {
      const response = await fetch("/api/member/market/accounts", { cache: "no-store" });
      const data = await response.json() as { items?: MarketAccount[]; error?: string };
      if (!response.ok) throw new Error(data.error || "监控账号读取失败。");
      const items = Array.isArray(data.items) ? data.items : [];
      setAccounts(items);
      setSelectedId((current) => items.some((item) => item.id === current) ? current : items[0]?.id || DEMO_ACCOUNT.id);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "监控账号读取失败。");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void loadAccounts(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const visibleAccounts = accounts.length ? accounts : [DEMO_ACCOUNT];
  const selectedAccount = visibleAccounts.find((item) => item.id === selectedId) || visibleAccounts[0];
  const isDemo = Boolean(selectedAccount.demo);
  const videos = useMemo(() => {
    if (!isDemo) return [];
    const query = search.trim().toLowerCase();
    return DEMO_VIDEOS
      .filter((video) => !query || video.title.toLowerCase().includes(query))
      .filter((video) => videoFilter === "all" || videoFilter === "recent" ? videoFilter === "all" || video.recent : video.growth >= 20)
      .sort((left, right) => videoFilter === "rising" ? right.growth - left.growth : 0);
  }, [isDemo, search, videoFilter]);
  const selectedVideo = DEMO_VIDEOS.find((item) => item.id === selectedVideoId) || DEMO_VIDEOS[0];

  async function addAccount() {
    if (!sourceUrl.trim() || adding) return;
    setAdding(true);
    setActionMessage("");
    try {
      const response = await fetch("/api/member/market/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceUrl }),
      });
      const data = await response.json() as { item?: MarketAccount; error?: string };
      if (!response.ok || !data.item) throw new Error(data.error || "账号添加失败。");
      setAccounts((current) => [data.item!, ...current.filter((item) => item.id !== data.item!.id)]);
      setSelectedId(data.item.id);
      setSourceUrl("");
      setAddOpen(false);
      setActionMessage("账号已加入监控，首次同步任务已经排队。");
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "账号添加失败。");
    } finally {
      setAdding(false);
    }
  }

  async function syncAccount() {
    if (isDemo || syncing) return;
    setSyncing(true);
    setActionMessage("");
    try {
      const response = await fetch(`/api/member/market/accounts/${encodeURIComponent(selectedAccount.id)}`, { method: "PATCH" });
      const data = await response.json() as { item?: Partial<MarketAccount>; error?: string };
      if (!response.ok || !data.item) throw new Error(data.error || "同步任务提交失败。");
      setAccounts((current) => current.map((item) => item.id === selectedAccount.id ? { ...item, ...data.item } : item));
      setActionMessage("同步任务已经排队，接入采集服务后会自动更新主页与作品数据。");
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "同步任务提交失败。");
    } finally {
      setSyncing(false);
    }
  }

  async function removeAccount() {
    if (isDemo || !window.confirm(`确认停止监控“${selectedAccount.nickname}”吗？`)) return;
    const response = await fetch(`/api/member/market/accounts/${encodeURIComponent(selectedAccount.id)}`, { method: "DELETE" });
    if (!response.ok) return setActionMessage("账号移除失败，请稍后重试。");
    const next = accounts.filter((item) => item.id !== selectedAccount.id);
    setAccounts(next);
    setSelectedId(next[0]?.id || DEMO_ACCOUNT.id);
    setActionMessage("已停止监控这个账号。");
  }

  return (
    <section className="market-workspace">
      <header className="market-heading">
        <div>
          <h1>{title}</h1>
          <p>持续跟踪对标账号的内容更新与数据变化，找到值得复用的选题和表达。</p>
          <div className="market-heading-meta" aria-label="监控摘要">
            <span><UserFocus size={15} />监控账号 <b>{accounts.length}</b></span>
            <span><VideoCamera size={15} />今日新作品 <b>{isDemo ? 2 : 0}</b></span>
            <span><BellRinging size={15} />下次同步 <b>{selectedAccount.nextSyncAt ? "约22分钟" : "未排期"}</b></span>
          </div>
        </div>
        <button className="market-add-button" type="button" onClick={() => setAddOpen((open) => !open)} aria-expanded={addOpen}>
          {addOpen ? <X size={18} /> : <Plus size={18} weight="bold" />}
          {addOpen ? "收起" : "添加对标账号"}
        </button>
      </header>

      {addOpen ? <div className="market-add-dock">
        <span className="market-add-icon"><LinkSimple size={22} /></span>
        <label><b>粘贴抖音账号主页链接</b><input value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void addAccount(); }} placeholder="https://www.douyin.com/user/..." autoFocus /></label>
        <button type="button" disabled={adding || !sourceUrl.trim()} onClick={() => void addAccount()}>{adding ? "正在添加…" : "开始监控"}</button>
      </div> : null}

      {actionMessage ? <div className="market-message" role="status"><CheckCircle size={17} weight="fill" /><span>{actionMessage}</span><button type="button" onClick={() => setActionMessage("")} aria-label="关闭提示"><X size={15} /></button></div> : null}

      <div className="market-layout">
        <aside className="market-account-rail">
          <div className="market-rail-title"><div><b>账号队列</b><span>{loading ? "正在读取" : `${visibleAccounts.length} 个账号`}</span></div><button type="button" onClick={() => void loadAccounts()} aria-label="刷新账号列表"><ArrowClockwise size={17} className={loading ? "is-spinning" : ""} /></button></div>
          {loadError ? <div className="market-rail-error"><span>{loadError}</span><button onClick={() => void loadAccounts()}>重新加载</button></div> : null}
          <div className="market-account-list">
            {visibleAccounts.map((account) => <button type="button" className={`market-account-item ${selectedAccount.id === account.id ? "is-active" : ""}`} key={account.id} onClick={() => setSelectedId(account.id)}>
              <span className="market-avatar">{account.avatarUrl ? <img src={account.avatarUrl} alt="" /> : account.nickname.slice(0, 1)}</span>
              <span className="market-account-copy"><b>{account.nickname}</b><small>{account.demo ? "示例账号" : account.status === "ready" ? relativeTime(account.lastSyncAt) : account.status === "error" ? "同步异常" : "等待首次同步"}</small></span>
              <i className={`market-status is-${account.status}`} aria-label={account.statusMessage} />
            </button>)}
          </div>
          <div className="market-rail-note"><ChartLineUp size={20} /><p><b>数据按时间留档</b><span>每次同步都会保留独立快照，后续可查看增长曲线与爆发节点。</span></p></div>
        </aside>

        <div className="market-account-view">
          <section className="market-profile">
            <div className="market-profile-main">
              <span className="market-profile-avatar">{selectedAccount.avatarUrl ? <img src={selectedAccount.avatarUrl} alt="" /> : selectedAccount.nickname.slice(0, 1)}</span>
              <div className="market-profile-copy"><div><h2>{selectedAccount.nickname}</h2>{isDemo ? <em>示例数据</em> : <em className={`is-${selectedAccount.status}`}>{selectedAccount.status === "ready" ? "监控中" : selectedAccount.status === "error" ? "需处理" : "待同步"}</em>}</div><span>{selectedAccount.handle}</span><p>{selectedAccount.signature || selectedAccount.statusMessage}</p></div>
            </div>
            <div className="market-profile-actions">
              {!isDemo ? <a href={selectedAccount.sourceUrl} target="_blank" rel="noreferrer"><LinkSimple size={16} />打开主页</a> : null}
              <button type="button" disabled={isDemo || syncing} onClick={() => void syncAccount()}><ArrowClockwise size={16} className={syncing ? "is-spinning" : ""} />{syncing ? "正在排队" : "同步账号"}</button>
              {!isDemo ? <button className="is-danger" type="button" onClick={() => void removeAccount()} aria-label="停止监控"><Trash size={16} /></button> : null}
            </div>
          </section>

          <section className="market-profile-metrics">
            <div><small>粉丝</small><b>{compactNumber(selectedAccount.followerCount)}</b><span>{isDemo ? "近7天 +3,826" : "等待首次快照"}</span></div>
            <div><small>获赞</small><b>{compactNumber(selectedAccount.totalLikes)}</b><span>{isDemo ? "近7天 +8.4万" : "等待首次快照"}</span></div>
            <div><small>作品</small><b>{compactNumber(selectedAccount.videoCount)}</b><span>{isDemo ? "本周发布 6 条" : "等待首次快照"}</span></div>
            <div className="market-trend-cell"><div><small>近12次互动趋势</small><b>{isDemo ? "+27.6%" : "暂无趋势"}</b></div><span className="market-mini-chart" aria-hidden="true">{TREND.map((height, index) => <i style={{ height: `${isDemo ? height : 8}%` }} key={index} />)}</span></div>
          </section>

          {!isDemo ? <div className="market-pending-state">
            <span><ArrowClockwise size={27} className={selectedAccount.status === "syncing" ? "is-spinning" : ""} /></span>
            <div><h3>{selectedAccount.status === "error" ? "账号同步遇到问题" : "正在准备首次账号同步"}</h3><p>{selectedAccount.statusMessage || "接入采集服务后，这里会自动呈现账号主页、视频宫格和每条作品的数据变化。"}</p></div>
          </div> : <>
            <div className="market-video-toolbar">
              <div className="market-video-tabs"><button className={videoFilter === "all" ? "active" : ""} onClick={() => setVideoFilter("all")}>全部作品</button><button className={videoFilter === "recent" ? "active" : ""} onClick={() => setVideoFilter("recent")}>最新发布 <i>2</i></button><button className={videoFilter === "rising" ? "active" : ""} onClick={() => setVideoFilter("rising")}>增长最快</button></div>
              <label className="market-search"><MagnifyingGlass size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题或关键词" /></label>
            </div>

            <div className="market-video-area">
              <div className="market-video-grid">
                {videos.map((video) => <button type="button" className={`market-video-card ${selectedVideoId === video.id ? "is-selected" : ""}`} key={video.id} onClick={() => setSelectedVideoId(video.id)}>
                  <span className="market-cover"><img src={video.cover} alt="" loading="lazy" /><i className="market-duration">{video.duration}</i>{video.recent ? <i className="market-new">新发布</i> : null}<em><Play size={15} weight="fill" />{compactNumber(video.plays)}</em></span>
                  <span className="market-video-copy"><b>{video.title}</b><small>{video.published}</small><span><i><Heart size={14} />{compactNumber(video.likes)}</i><i><ChatCircleDots size={14} />{compactNumber(video.comments)}</i><i className="is-growth"><TrendUp size={14} />{video.growth}%</i></span></span>
                </button>)}
              </div>

              <aside className="market-insight-panel">
                <div className="market-insight-heading"><h3>数据速览</h3><span>示例</span></div>
                <p>{selectedVideo.title}</p>
                <dl>
                  <div><dt><Eye size={15} />播放</dt><dd>{compactNumber(selectedVideo.plays)}</dd></div>
                  <div><dt><Heart size={15} />点赞</dt><dd>{compactNumber(selectedVideo.likes)}</dd></div>
                  <div><dt><ChatCircleDots size={15} />评论</dt><dd>{compactNumber(selectedVideo.comments)}</dd></div>
                  <div><dt><ShareNetwork size={15} />分享</dt><dd>{compactNumber(selectedVideo.shares)}</dd></div>
                  <div><dt><BookmarkSimple size={15} />收藏</dt><dd>{compactNumber(selectedVideo.collects)}</dd></div>
                </dl>
                <div className="market-growth-callout"><TrendUp size={20} weight="bold" /><p><b>发布后持续增长</b><span>近24小时互动增速高于账号均值 {selectedVideo.growth}%</span></p></div>
                <button type="button" disabled>进入内容拆解</button>
                <small>下一阶段接入口播文案、标题结构与镜头节点分析。</small>
              </aside>
            </div>
          </>}
        </div>
      </div>
    </section>
  );
}
