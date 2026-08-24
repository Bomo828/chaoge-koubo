"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { MemberSession } from "../member-session";
import type { AdminTemplate, AdminUser } from "../../lib/server/admin-data";
import type { ClonedVoiceRecord } from "../../lib/server/cloned-voices";
import type { AdminInvitation } from "../../lib/server/invitations";
import type { PlatformFeature, PlatformSettings, RechargePackage } from "../../lib/server/platform-settings";
import { AI_COST_MARKUP_MULTIPLIER, billablePointsFromCost } from "../../lib/billing";

type Stats = { users: number; projects: number; templates: number; tasks: number };
type Tab = "features" | "templates" | "points" | "ai" | "voices" | "invites" | "users";
type AiServiceStatus = {
  id: string;
  name: string;
  configured: boolean;
  connected: boolean;
  balance: number | null;
  unit: string;
  sufficient: boolean;
  message: string;
  secretHint: string;
  baseUrl?: string;
  credentialSource?: "admin" | "environment" | "none";
  credentialUpdatedAt?: number | null;
};

type AiCredentialEditor = {
  providerId: "lk888" | "chanjing";
  apiKey: string;
  appId: string;
  secretKey: string;
  baseUrl: string;
};

type TemplateForm = {
  name: string; slug: string; category: string; version: number; status: string;
  previewUrl: string; coverUrl: string; description: string; config: Record<string, unknown>;
};

type TemplateLearningJob = {
  id: string; state: "queued" | "running" | "success" | "failed"; stage: string;
  progress: number; message: string; error?: string;
  template?: Record<string, unknown>; catalog?: Record<string, unknown>;
  analysis_summary?: Record<string, unknown>;
};

type MemberForm = {
  id: string | null;
  username: string;
  displayName: string;
  password: string;
  level: string;
  points: number;
};

type InvitationForm = {
  count: number;
  maxUses: number;
  validityDays: number;
  giftPoints: number;
  memberLevel: string;
  note: string;
};

const emptyTemplate: TemplateForm = {
  name: "", slug: "", category: "viral_video", version: 1, status: "draft",
  previewUrl: "", coverUrl: "", description: "", config: {},
};

const emptyMember: MemberForm = {
  id: null, username: "", displayName: "", password: "", level: "basic", points: 0,
};

const TEMPLATE_LIBRARY_UPDATE_KEY = "merchant-studio:template-library-updated";

const entryOptions: Array<{ value: PlatformFeature["entry"]; label: string }> = [
  { value: "overview", label: "创作首页" },
  { value: "design", label: "图片设计" }, { value: "video", label: "短视频" },
  { value: "cases", label: "行业案例" }, { value: "assets", label: "会员资产" },
  { value: "member", label: "会员中心" },
];

export function AdminClient({ member, initialStats, initialTemplates, initialUsers, initialVoices, initialInvitations, initialSettings }: {
  member: MemberSession;
  initialStats: Stats;
  initialTemplates: AdminTemplate[];
  initialUsers: AdminUser[];
  initialVoices: ClonedVoiceRecord[];
  initialInvitations: AdminInvitation[];
  initialSettings: PlatformSettings;
}) {
  const [tab, setTab] = useState<Tab>("features");
  const [templates, setTemplates] = useState(initialTemplates);
  const [users, setUsers] = useState(initialUsers);
  const [invitations, setInvitations] = useState(initialInvitations);
  const [voices] = useState(initialVoices);
  const [settings, setSettings] = useState(initialSettings);
  const [pointEdits, setPointEdits] = useState<Record<string, string>>({});
  const [templateForm, setTemplateForm] = useState(emptyTemplate);
  const [editingTemplate, setEditingTemplate] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [templateVideoFile, setTemplateVideoFile] = useState<File | null>(null);
  const [learningJob, setLearningJob] = useState<TemplateLearningJob | null>(null);
  const [learning, setLearning] = useState(false);
  const [aiStatuses, setAiStatuses] = useState<AiServiceStatus[]>([]);
  const [checkingAi, setCheckingAi] = useState(false);
  const [credentialEditor, setCredentialEditor] = useState<AiCredentialEditor | null>(null);
  const [credentialBusy, setCredentialBusy] = useState<"test" | "save" | null>(null);
  const [credentialMessage, setCredentialMessage] = useState("");
  const [credentialError, setCredentialError] = useState(false);
  const credentialKeyRef = useRef<HTMLInputElement>(null);
  const [memberForm, setMemberForm] = useState<MemberForm | null>(null);
  const [invitationForm, setInvitationForm] = useState<InvitationForm>({
    count: 1,
    maxUses: 1,
    validityDays: 30,
    giftPoints: initialSettings.newUserPoints,
    memberLevel: "basic",
    note: "",
  });
  const [generatedCodes, setGeneratedCodes] = useState<string[]>([]);

  const publishedCount = useMemo(() => templates.filter((item) => item.status === "published").length, [templates]);
  const enabledFeatureCount = settings.features.filter((item) => item.enabled).length;
  const credentialEditorOpen = credentialEditor !== null;

  useEffect(() => {
    if (!credentialEditorOpen) return;
    credentialKeyRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !credentialBusy) setCredentialEditor(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [credentialEditorOpen, credentialBusy]);

  async function api<T>(url: string, init?: RequestInit) {
    const response = await fetch(url, init);
    const data = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw new Error(data.error || "操作失败，请稍后重试。");
    return data;
  }

  function notifyTemplateLibraryUpdated() {
    const updatedAt = Date.now();
    try {
      window.localStorage.setItem(TEMPLATE_LIBRARY_UPDATE_KEY, String(updatedAt));
      const channel = new BroadcastChannel(TEMPLATE_LIBRARY_UPDATE_KEY);
      channel.postMessage({ type: "templates-updated", updatedAt });
      channel.close();
    } catch {
      // The catalog still refreshes on page focus and by its polling fallback.
    }
  }

  async function saveSettings(next = settings, success = "平台设置已保存，并同步到用户端。") {
    setBusy(true);
    setMessage("");
    try {
      const data = await api<{ settings: PlatformSettings }>("/api/admin/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: next }),
      });
      setSettings(data.settings);
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "平台设置保存失败。");
    } finally { setBusy(false); }
  }

  function addFeature() {
    const next: PlatformFeature = {
      id: `feature-${Date.now()}`, name: "新功能", icon: "新", description: "填写用户端功能说明",
      entry: "overview", enabled: false, sortOrder: (settings.features.length + 1) * 10,
    };
    setSettings((current) => ({ ...current, features: [...current.features, next] }));
  }

  function updateFeature(id: string, changes: Partial<PlatformFeature>) {
    setSettings((current) => ({ ...current, features: current.features.map((item) => item.id === id ? { ...item, ...changes } : item) }));
  }

  function removeFeature(id: string) {
    const item = settings.features.find((entry) => entry.id === id);
    if (!item || !window.confirm(`确认删除功能“${item.name}”吗？`)) return;
    setSettings((current) => ({ ...current, features: current.features.filter((entry) => entry.id !== id) }));
  }

  async function refreshAiStatus(announce = true) {
    setCheckingAi(true);
    setMessage("");
    try {
      const data = await api<{ services: AiServiceStatus[] }>("/api/admin/ai-status", { cache: "no-store" });
      setAiStatuses(data.services);
      if (announce) setMessage("AI 服务状态和余额已经刷新。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "AI 服务检查失败。");
    } finally { setCheckingAi(false); }
  }

  function openCredentialEditor(providerId: "lk888" | "chanjing") {
    const status = aiStatuses.find((item) => item.id === providerId);
    setCredentialEditor({
      providerId,
      apiKey: "",
      appId: "",
      secretKey: "",
      baseUrl: status?.baseUrl || (providerId === "lk888" ? "https://api.lk888.ai" : "https://open-api.chanjing.cc"),
    });
    setCredentialMessage("");
    setCredentialError(false);
  }

  async function testCredential() {
    if (!credentialEditor) return;
    setCredentialBusy("test");
    setCredentialMessage("");
    setCredentialError(false);
    try {
      const data = await api<{ balance: number | null; unit: string }>("/api/admin/provider-credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentialEditor),
      });
      setCredentialMessage(data.balance === null ? "连接成功，可以保存。" : `连接成功，当前余额 ${data.balance.toFixed(4)} ${data.unit}。`);
    } catch (error) {
      setCredentialError(true);
      setCredentialMessage(error instanceof Error ? error.message : "接口连接失败，请检查地址和 Key。");
    } finally { setCredentialBusy(null); }
  }

  async function saveCredential() {
    if (!credentialEditor) return;
    setCredentialBusy("save");
    setCredentialMessage("正在验证新接口，验证通过后自动保存…");
    setCredentialError(false);
    try {
      await api<{ credential: { configured: boolean } }>("/api/admin/provider-credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentialEditor),
      });
      setCredentialEditor(null);
      setCredentialMessage("");
      setMessage(`${credentialEditor.providerId === "lk888" ? "开放 AI 平台" : "蝉镜数字人"}接口已更新，相关功能将立即使用新配置。`);
      await refreshAiStatus(false);
    } catch (error) {
      setCredentialError(true);
      setCredentialMessage(error instanceof Error ? error.message : "接口凭证保存失败，原配置未变更。");
    } finally { setCredentialBusy(null); }
  }

  async function uploadPreview(file: File) {
    setTemplateVideoFile(file);
    setUploading(true); setMessage("");
    try {
      const form = new FormData(); form.append("file", file);
      const data = await api<{ url: string }>("/api/admin/uploads", { method: "POST", body: form });
      setTemplateForm((current) => ({ ...current, previewUrl: data.url }));
      setMessage("模板视频上传完成，可以继续保存模板。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "模板视频上传失败。"); }
    finally { setUploading(false); }
  }

  async function learnTemplateFromVideo() {
    if (!templateVideoFile) { setMessage("请先上传需要学习的参考原视频。"); return; }
    if (!templateForm.name.trim() || !/^[a-z0-9][a-z0-9-]{1,48}$/.test(templateForm.slug.trim())) {
      setMessage("请先填写模板名称和正确的模板标识。"); return;
    }
    setLearning(true); setMessage("");
    try {
      const form = new FormData();
      form.append("file", templateVideoFile, templateVideoFile.name);
      form.append("name", templateForm.name.trim());
      form.append("slug", templateForm.slug.trim());
      form.append("previewUrl", templateForm.previewUrl);
      let job = await api<TemplateLearningJob>("/api/admin/templates/learn", { method: "POST", body: form });
      setLearningJob(job);
      for (let attempt = 0; attempt < 180 && job.state !== "success" && job.state !== "failed"; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 3000));
        job = await api<TemplateLearningJob>(`/api/admin/templates/learn/${job.id}`, { cache: "no-store" });
        setLearningJob(job);
      }
      if (job.state !== "success") throw new Error(job.error || job.message || "模板学习超时，请稍后重试。");
      const catalog = job.catalog || {};
      const learnedTemplate = job.template || {};
      // Re-learning an existing template creates a new published revision.
      // Keep the catalog and the renderer package on the same version so the
      // user-facing template never appears to be the stale previous build.
      const learnedVersion = editingTemplate
        ? Math.max(Number(templateForm.version) + 1, Number(learnedTemplate.version) || 1)
        : Math.max(1, Number(learnedTemplate.version) || Number(templateForm.version) || 1);
      const learnedForm: TemplateForm = {
        ...templateForm,
        version: learnedVersion,
        description: String(catalog.description || templateForm.description || "逐帧学习生成的网感模板草稿。"),
        config: {
          ...catalog,
          learnedTemplate: { ...learnedTemplate, version: learnedVersion },
          analysisSummary: job.analysis_summary || {},
          // The learning worker has already completed the full-frame analysis.
          // Preserve the administrator's selected publication state instead of
          // silently forcing every learned template back to draft.
          validationStatus: templateForm.status === "published" ? "published-ready" : "learned-draft",
        },
      };
      const path = editingTemplate ? `/api/admin/templates/${editingTemplate}` : "/api/admin/templates";
      const data = await api<{ item: AdminTemplate }>(path, {
        method: editingTemplate ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(learnedForm),
      });
      setTemplates((current) => editingTemplate
        ? current.map((item) => item.id === data.item.id ? data.item : item)
        : [data.item, ...current]);
      notifyTemplateLibraryUpdated();
      setTemplateForm(emptyTemplate); setTemplateVideoFile(null); setEditingTemplate(null);
      setMessage(templateForm.status === "published"
        ? "逐帧学习完成，模板已上架并同步到用户端。"
        : "逐帧学习完成：标题、字幕、色彩、转场和音效规则已自动生成，并保存为草稿。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "模板学习失败。");
    } finally { setLearning(false); }
  }

  async function saveTemplate(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const path = editingTemplate ? `/api/admin/templates/${editingTemplate}` : "/api/admin/templates";
      const data = await api<{ item: AdminTemplate }>(path, {
        method: editingTemplate ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(templateForm),
      });
      setTemplates((current) => editingTemplate ? current.map((item) => item.id === data.item.id ? data.item : item) : [data.item, ...current]);
      notifyTemplateLibraryUpdated();
      setTemplateForm(emptyTemplate); setTemplateVideoFile(null); setLearningJob(null); setEditingTemplate(null);
      setMessage(editingTemplate ? "模板修改已保存。" : "新模板已添加，用户端模板库会立即同步。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "模板保存失败。"); }
    finally { setBusy(false); }
  }

  function editTemplate(item: AdminTemplate) {
    setEditingTemplate(item.id);
    setTemplateForm({ name: item.name, slug: item.slug, category: item.category, version: item.version, status: item.status, previewUrl: item.previewUrl, coverUrl: item.coverUrl, description: item.description, config: item.config });
    setTemplateVideoFile(null); setLearningJob(null);
    setMessage("正在修改模板，保存后版本与预览会同步更新。");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function removeTemplate(item: AdminTemplate) {
    if (!window.confirm(`确认删除模板“${item.name}”吗？`)) return;
    try {
      await api(`/api/admin/templates/${item.id}`, { method: "DELETE" });
      setTemplates((current) => current.filter((entry) => entry.id !== item.id));
      notifyTemplateLibraryUpdated();
      setMessage("模板已删除。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "模板删除失败。"); }
  }

  async function updateUser(item: AdminUser, changes: Record<string, unknown>) {
    setBusy(true); setMessage("");
    try {
      const data = await api<{ item: AdminUser }>(`/api/admin/users/${item.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes),
      });
      setUsers((current) => current.map((entry) => entry.id === data.item.id ? data.item : entry));
      setPointEdits((current) => ({ ...current, [item.id]: "" })); setMessage("会员资料与积分已经更新。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "会员更新失败。"); }
    finally { setBusy(false); }
  }

  function editMember(item: AdminUser) {
    setMemberForm({
      id: item.id,
      username: item.username,
      displayName: item.displayName,
      password: "",
      level: item.level,
      points: item.points,
    });
    setMessage("");
  }

  async function saveMemberAccount(event: FormEvent) {
    event.preventDefault();
    if (!memberForm) return;
    setBusy(true); setMessage("");
    try {
      const editing = Boolean(memberForm.id);
      const data = await api<{ item: AdminUser }>(editing ? `/api/admin/users/${memberForm.id}` : "/api/admin/users", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: memberForm.username,
          displayName: memberForm.displayName,
          password: memberForm.password || undefined,
          level: memberForm.level,
          points: editing ? undefined : memberForm.points,
        }),
      });
      setUsers((current) => editing
        ? current.map((item) => item.id === data.item.id ? data.item : item)
        : [data.item, ...current]);
      setMemberForm(null);
      setMessage(editing
        ? `会员“${data.item.displayName}”的账号资料已经更新${memberForm.password ? "，旧登录已失效" : ""}。`
        : `会员“${data.item.displayName}”已创建，可以使用新账号登录。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "会员账号保存失败。");
    } finally { setBusy(false); }
  }

  async function generateInvitationCodes(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(""); setGeneratedCodes([]);
    try {
      const data = await api<{ items: AdminInvitation[]; codes: Array<{ id: string; code: string }> }>("/api/admin/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(invitationForm),
      });
      setInvitations((current) => [...data.items, ...current]);
      setGeneratedCodes(data.codes.map((item) => item.code));
      setMessage(`已生成 ${data.codes.length} 个邀请码。完整邀请码只在本次显示，请立即复制保存。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "邀请码生成失败。");
    } finally { setBusy(false); }
  }

  async function changeInvitationStatus(item: AdminInvitation) {
    setBusy(true); setMessage("");
    try {
      const data = await api<{ item: AdminInvitation }>(`/api/admin/invitations/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: item.status === "active" ? "disabled" : "active" }),
      });
      setInvitations((current) => current.map((entry) => entry.id === data.item.id ? data.item : entry));
      setMessage(data.item.status === "active" ? "邀请码已重新启用。" : "邀请码已停用。用户将无法再使用。 ");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "邀请码状态更新失败。");
    } finally { setBusy(false); }
  }

  async function copyGeneratedCodes() {
    if (!generatedCodes.length) return;
    try {
      await navigator.clipboard.writeText(generatedCodes.join("\n"));
      setMessage("邀请码已经复制到剪贴板。完整邀请码关闭页面后不会再次显示。");
    } catch {
      setMessage("自动复制失败，请手动选择邀请码复制。 ");
    }
  }

  const navItems: Array<{ id: Tab; icon: string; label: string }> = [
    { id: "features", icon: "功", label: "用户端功能" }, { id: "templates", icon: "模", label: "网感模板" },
    { id: "points", icon: "积", label: "积分与充值" }, { id: "ai", icon: "AI", label: "AI 服务中心" },
    { id: "voices", icon: "声", label: "克隆声音" },
    { id: "invites", icon: "邀", label: "邀请码" },
    { id: "users", icon: "会", label: "会员管理" },
  ];

  return <main className="admin-shell">
    <aside className="admin-sidebar">
      <a className="admin-brand" href="/studio"><i><img src="/media/flash-lab-logo.png" alt="" /></i><span><b>爆点实验室</b></span></a>
      <nav>{navItems.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => { setTab(item.id); if (item.id === "ai" && !aiStatuses.length) void refreshAiStatus(); }}><i>{item.icon}</i><span>{item.label}</span></button>)}</nav>
      <div className="admin-account"><span>{member.displayName}</span><small>{member.role === "super_admin" ? "超级管理员" : "运营管理员"}</small><a href="/studio">返回创作平台 →</a></div>
    </aside>
    <section className="admin-main">
      <header className="admin-header"><h1>平台管理</h1><span className="admin-live"><i />系统运行中</span></header>
      <div className="admin-stats">
        <article><small>会员用户</small><b>{users.length}</b><span>账号与权限</span></article>
        <article><small>用户端功能</small><b>{enabledFeatureCount}</b><span>{settings.features.length} 个已配置</span></article>
        <article><small>网感模板</small><b>{templates.length}</b><span>{publishedCount} 个已上架</span></article>
        <article><small>AI 任务</small><b>{initialStats.tasks}</b><span>统一任务中心</span></article>
      </div>
      {message ? <div className="admin-message" role="status">{message}</div> : null}

      {tab === "features" ? <>
        <section className="admin-list">
          <header><h2>用户端功能</h2><button className="admin-add" onClick={addFeature}>＋ 新增功能</button></header>
          <div className="admin-feature-list">
            {[...settings.features].sort((a, b) => a.sortOrder - b.sortOrder).map((item) => <article key={item.id}>
              <input className="feature-icon" value={item.icon} maxLength={2} onChange={(event) => updateFeature(item.id, { icon: event.target.value })} aria-label="功能图标" />
              <label><span>功能名称</span><input value={item.name} onChange={(event) => updateFeature(item.id, { name: event.target.value })} /></label>
              <label className="feature-desc"><span>用户端说明</span><input value={item.description} onChange={(event) => updateFeature(item.id, { description: event.target.value })} /></label>
              <label><span>打开页面</span><select value={item.entry} onChange={(event) => updateFeature(item.id, { entry: event.target.value as PlatformFeature["entry"] })}>{entryOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              <label><span>排序</span><input type="number" value={item.sortOrder} onChange={(event) => updateFeature(item.id, { sortOrder: Number(event.target.value) })} /></label>
              <button className={`admin-switch ${item.enabled ? "is-on" : ""}`} onClick={() => updateFeature(item.id, { enabled: !item.enabled })}>{item.enabled ? "已启用" : "已停用"}</button>
              <button className="admin-delete" onClick={() => removeFeature(item.id)}>删除</button>
            </article>)}
          </div>
          <footer className="admin-savebar"><span>修改后需要保存，用户重新进入工作台即可看到变化。</span><button disabled={busy} onClick={() => void saveSettings()}>{busy ? "正在保存…" : "保存用户端功能"}</button></footer>
        </section>
      </> : tab === "templates" ? <>
        <section className="admin-editor">
          <header><h2>{editingTemplate ? "修改网感模板" : "新增网感模板"}</h2>{editingTemplate ? <button onClick={() => { setEditingTemplate(null); setTemplateForm(emptyTemplate); setTemplateVideoFile(null); setLearningJob(null); }}>取消修改</button> : null}</header>
          <form onSubmit={saveTemplate}>
            <label><span>模板名称</span><input required value={templateForm.name} onChange={(event) => setTemplateForm({ ...templateForm, name: event.target.value })} placeholder="例如：轻奢白·双语" /></label>
            <label><span>模板标识</span><input required pattern="[a-z0-9][a-z0-9-]{1,48}" value={templateForm.slug} onChange={(event) => setTemplateForm({ ...templateForm, slug: event.target.value })} placeholder="luxury-white-bilingual" /></label>
            <label><span>分类</span><select value={templateForm.category} onChange={(event) => setTemplateForm({ ...templateForm, category: event.target.value })}><option value="viral_video">一键网感</option><option value="image">图片模板</option><option value="video">视频模板</option></select></label>
            <label><span>版本</span><input type="number" min="1" value={templateForm.version} onChange={(event) => setTemplateForm({ ...templateForm, version: Number(event.target.value) })} /></label>
            <label><span>状态</span><select value={templateForm.status} onChange={(event) => setTemplateForm({ ...templateForm, status: event.target.value })}><option value="draft">草稿</option><option value="published">上架</option></select></label>
            <label className="wide"><span>预览视频地址</span><input value={templateForm.previewUrl} onChange={(event) => setTemplateForm({ ...templateForm, previewUrl: event.target.value })} placeholder="可填写 URL，或使用右侧上传" /></label>
            <label className="admin-upload"><span>{uploading ? "正在上传…" : templateVideoFile ? `已选择：${templateVideoFile.name}` : "上传参考原视频"}</span><input type="file" accept="video/mp4,video/webm,video/quicktime" disabled={uploading || learning} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadPreview(file); event.target.value = ""; }} /></label>
            <label className="full"><span>模板说明</span><textarea value={templateForm.description} onChange={(event) => setTemplateForm({ ...templateForm, description: event.target.value })} placeholder="系统学习后会自动填写，也可以手动补充" /></label>
            {learningJob ? <div className="admin-learning full"><div><i style={{ width: `${Math.max(4, learningJob.progress || 0)}%` }} /></div><strong>{learningJob.message}</strong><span>{learningJob.progress || 0}% · {learningJob.stage}</span></div> : null}
            <button className="admin-generate" type="button" disabled={learning || uploading || !templateVideoFile} onClick={() => void learnTemplateFromVideo()}>{learning ? "正在逐帧学习并生成…" : "✦ 一键学习并生成模板"}</button>
            <button className="admin-primary" type="submit" disabled={busy || uploading || learning}>{busy ? "正在保存…" : editingTemplate ? "仅保存当前修改" : "仅保存模板资料"}</button>
          </form>
        </section>
        <section className="admin-list"><header><h2>网感模板库</h2><span>{templates.length} 个模板</span></header><div className="admin-template-grid">
          {templates.map((item) => <article key={item.id}><div className="admin-template-media">{item.previewUrl ? <video src={item.previewUrl} muted playsInline preload="metadata" /> : <span>暂无预览</span>}<em>V{item.version}</em></div><div className="admin-template-info"><small>{item.category === "viral_video" ? "一键网感" : item.category}</small><h3>{item.name}</h3><p>{item.description || "尚未填写模板说明"}</p><span className={item.status}>{item.status === "published" ? "已上架" : "草稿"}</span></div><footer><button onClick={() => editTemplate(item)}>修改</button><button className="danger" onClick={() => void removeTemplate(item)}>删除</button></footer></article>)}
        </div></section>
      </> : tab === "points" ? <>
        <section className="admin-list">
          <header><h2>AI 积分扣费规则</h2><span>按功能独立设置</span></header>
          <div className="admin-point-rules">{settings.pointRules.map((rule) => <article key={rule.action}><div><b>{rule.name}</b><small>{rule.action}</small></div><label><span>成本积分 / 单位</span><input type="number" min="0" value={rule.points} onChange={(event) => setSettings((current) => ({ ...current, pointRules: current.pointRules.map((item) => item.action === rule.action ? { ...item, points: Number(event.target.value) } : item) }))} /><small className="admin-retail-points">用户扣费 {billablePointsFromCost(rule.points)} 积分</small></label><button className={`admin-switch ${rule.enabled ? "is-on" : ""}`} onClick={() => setSettings((current) => ({ ...current, pointRules: current.pointRules.map((item) => item.action === rule.action ? { ...item, enabled: !item.enabled } : item) }))}>{rule.enabled ? "计费中" : "免费"}</button></article>)}</div>
        </section>
        <section className="admin-list">
          <header><h2>充值套餐</h2><button className="admin-add" onClick={() => setSettings((current) => ({ ...current, rechargePackages: [...current.rechargePackages, { id: `package-${Date.now()}`, name: "新套餐", points: 990, bonus: 0, priceYuan: 99, enabled: false }] }))}>＋ 新增套餐</button></header>
          <div className="admin-package-grid">{settings.rechargePackages.map((item) => <RechargeEditor key={item.id} item={item} pointsPerYuan={settings.rechargePointsPerYuan} onChange={(next) => setSettings((current) => ({ ...current, rechargePackages: current.rechargePackages.map((entry) => entry.id === item.id ? next : entry) }))} onDelete={() => setSettings((current) => ({ ...current, rechargePackages: current.rechargePackages.filter((entry) => entry.id !== item.id) }))} />)}</div>
          <div className="admin-payment-row">
            <label><span>充值积分比例</span><input type="number" min="1" max="100000" step="1" value={settings.rechargePointsPerYuan} onChange={(event) => setSettings({ ...settings, rechargePointsPerYuan: Number(event.target.value) })} /></label>
            <label><span>新会员赠送积分</span><input type="number" min="0" value={settings.newUserPoints} onChange={(event) => setSettings({ ...settings, newUserPoints: Number(event.target.value) })} /></label>
            <label><span>支付接入模式</span><select value={settings.paymentMode} onChange={(event) => setSettings({ ...settings, paymentMode: event.target.value === "wechat" ? "wechat" : "demo" })}><option value="demo">本地演示充值</option><option value="wechat">微信支付</option></select></label>
            <p><strong>1 元 = {Math.max(1, Math.floor(settings.rechargePointsPerYuan || 10)).toLocaleString()} 积分</strong><span>基础积分自动换算，套餐赠送积分另行叠加。</span></p>
          </div>
          <div className="admin-billing-audit" role="status"><div><span>用户扣费</span><strong>实际成本 × {AI_COST_MARKUP_MULTIPLIER}</strong></div><div><span>加价率</span><strong>100%</strong></div><div><span>毛利率</span><strong>50%</strong></div><p>任务先预扣，完成后按上游实际消耗结算；失败全退，多预扣部分自动退回。</p></div>
          <footer className="admin-savebar"><span>积分规则填写成本积分；用户端统一按成本的 2 倍扣费。</span><button disabled={busy} onClick={() => void saveSettings(settings, "积分规则和充值套餐已保存。")}>{busy ? "正在保存…" : "保存积分与充值设置"}</button></footer>
        </section>
      </> : tab === "ai" ? <>
        <section className="admin-list">
          <header><h2>AI 接口与余额</h2><button className="admin-add" disabled={checkingAi} onClick={() => void refreshAiStatus()}>{checkingAi ? "正在检测…" : "↻ 刷新实时状态"}</button></header>
          <div className="admin-ai-grid">{settings.aiProviders.map((provider) => {
            const status = aiStatuses.find((item) => item.id === provider.id);
            const configurableId = provider.id === "lk888" || provider.id === "chanjing" ? provider.id : null;
            return <article key={provider.id} className={status ? status.sufficient ? "is-ok" : "is-warning" : ""}>
              <header><i>{provider.id === "lk888" ? "AI" : provider.id === "chanjing" ? "声" : "视"}</i><div><b>{provider.name}</b><span>{provider.purpose}</span></div><em>{status ? status.connected ? "已连接" : "异常" : "待检测"}</em></header>
              <div className="ai-balance"><small>实时余额 / 状态</small><b>{status?.balance === null || status?.balance === undefined ? status?.unit || "—" : `${status.balance.toFixed(4)} ${status.unit}`}</b><span>{status?.message || "点击刷新读取状态"}</span></div>
              <label><span>余额预警阈值</span><input type="number" min="0" value={provider.lowBalanceThreshold} onChange={(event) => setSettings((current) => ({ ...current, aiProviders: current.aiProviders.map((item) => item.id === provider.id ? { ...item, lowBalanceThreshold: Number(event.target.value) } : item) }))} /></label>
              <button className={`admin-switch ${provider.enabled ? "is-on" : ""}`} onClick={() => setSettings((current) => ({ ...current, aiProviders: current.aiProviders.map((item) => item.id === provider.id ? { ...item, enabled: !item.enabled } : item) }))}>{provider.enabled ? "服务启用" : "服务停用"}</button>
              <footer className="admin-provider-credential"><div><small>{configurableId ? "接口凭证" : "服务地址"}</small><b>{status?.secretHint || "配置状态尚未读取"}</b></div>{configurableId && member.role === "super_admin" ? <button type="button" onClick={() => openCredentialEditor(configurableId)}>配置接口</button> : configurableId ? <span>仅平台管理员可配置</span> : null}</footer>
            </article>;
          })}</div>
          <footer className="admin-savebar"><span>每项服务独立配置接口凭证；这里保存服务开关与余额预警阈值。</span><button disabled={busy} onClick={() => void saveSettings(settings, "AI 服务开关和余额阈值已保存。")}>{busy ? "正在保存…" : "保存 AI 服务设置"}</button></footer>
        </section>
        {credentialEditor ? <div className="admin-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !credentialBusy) setCredentialEditor(null); }}>
          <section className="admin-credential-dialog" role="dialog" aria-modal="true" aria-labelledby="credential-dialog-title">
            <header><div><h2 id="credential-dialog-title">配置{credentialEditor.providerId === "lk888" ? "开放 AI 平台" : "蝉镜数字人"}</h2><p>新配置验证成功后才会替换当前配置</p></div><button type="button" aria-label="关闭" disabled={Boolean(credentialBusy)} onClick={() => setCredentialEditor(null)}>×</button></header>
            <label><span>接口地址</span><input type="url" maxLength={500} value={credentialEditor.baseUrl} onChange={(event) => setCredentialEditor({ ...credentialEditor, baseUrl: event.target.value })} placeholder="https://api.example.com" /></label>
            {credentialEditor.providerId === "lk888" ? <label><span>API Key</span><input ref={credentialKeyRef} type="password" maxLength={500} autoComplete="new-password" value={credentialEditor.apiKey} onChange={(event) => setCredentialEditor({ ...credentialEditor, apiKey: event.target.value })} placeholder="留空表示继续使用当前 Key" /></label> : <>
              <label><span>AppID</span><input ref={credentialKeyRef} type="password" maxLength={500} autoComplete="new-password" value={credentialEditor.appId} onChange={(event) => setCredentialEditor({ ...credentialEditor, appId: event.target.value })} placeholder="留空表示继续使用当前 AppID" /></label>
              <label><span>Secret Key</span><input type="password" maxLength={500} autoComplete="new-password" value={credentialEditor.secretKey} onChange={(event) => setCredentialEditor({ ...credentialEditor, secretKey: event.target.value })} placeholder="留空表示继续使用当前密钥" /></label>
            </>}
            <div className={`admin-credential-feedback ${credentialError ? "is-error" : ""}`} role="status">{credentialMessage || "凭证只在服务端加密保存，页面不会显示完整内容。"}</div>
            <footer><button type="button" className="admin-dialog-secondary" disabled={Boolean(credentialBusy)} onClick={() => void testCredential()}>{credentialBusy === "test" ? "正在测试…" : "测试连接"}</button><button type="button" className="admin-dialog-primary" disabled={Boolean(credentialBusy)} onClick={() => void saveCredential()}>{credentialBusy === "save" ? "正在验证并保存…" : "验证并保存"}</button></footer>
          </section>
        </div> : null}
      </> : tab === "voices" ? <section className="admin-list admin-voice-section">
        <header><h2>会员克隆声音</h2><span>{voices.length} 个声音模型</span></header>
        {voices.length ? <div className="admin-voice-list">{voices.map((voice) => <article key={voice.id}>
          <i>{voice.name.slice(0, 1) || "声"}</i>
          <div className="admin-voice-name"><h3>{voice.name}</h3><p>{voice.ownerName} · @{voice.ownerUsername}</p></div>
          <div className="admin-voice-provider"><span>服务商</span><b>{voice.provider === "chanjing" ? "蝉镜" : voice.provider}</b></div>
          <div className="admin-voice-id"><span>声音模型 ID</span><code>{voice.providerVoiceId}</code></div>
          <em className={voice.status}>{voice.status === "ready" ? "可使用" : voice.status === "unavailable" ? "需重新同步" : voice.status}</em>
          {voice.sampleAssetId ? <audio controls preload="none" src={`/api/admin/voices/${encodeURIComponent(voice.id)}/sample`} /> : <small className="admin-voice-no-sample">暂无试听样本</small>}
        </article>)}</div> : <div className="admin-empty">暂无克隆声音，会员完成声音克隆后会自动同步。</div>}
      </section> : tab === "invites" ? <>
        <section className="admin-editor admin-invitation-editor">
          <header><h2>生成会员邀请码</h2><span>完整邀请码只显示一次，后台仅保存安全摘要</span></header>
          <form onSubmit={(event) => void generateInvitationCodes(event)}>
            <label><span>生成数量</span><input type="number" min="1" max="50" value={invitationForm.count} onChange={(event) => setInvitationForm({ ...invitationForm, count: Number(event.target.value) })} /></label>
            <label><span>每个码可用次数</span><input type="number" min="1" max="100" value={invitationForm.maxUses} onChange={(event) => setInvitationForm({ ...invitationForm, maxUses: Number(event.target.value) })} /></label>
            <label><span>有效期（天）</span><input type="number" min="0" max="365" value={invitationForm.validityDays} onChange={(event) => setInvitationForm({ ...invitationForm, validityDays: Number(event.target.value) })} /></label>
            <label><span>注册赠送积分</span><input type="number" min="0" value={invitationForm.giftPoints} onChange={(event) => setInvitationForm({ ...invitationForm, giftPoints: Number(event.target.value) })} /></label>
            <label><span>会员等级</span><select value={invitationForm.memberLevel} onChange={(event) => setInvitationForm({ ...invitationForm, memberLevel: event.target.value })}><option value="basic">基础会员</option><option value="growth">成长会员</option><option value="business">商家会员</option><option value="vip">VIP 会员</option></select></label>
            <label className="wide"><span>渠道或备注</span><input maxLength={100} value={invitationForm.note} onChange={(event) => setInvitationForm({ ...invitationForm, note: event.target.value })} placeholder="例如：首批内测会员" /></label>
            <button className="admin-primary" type="submit" disabled={busy}>{busy ? "正在生成…" : "生成邀请码"}</button>
          </form>
          {generatedCodes.length ? <div className="admin-generated-codes">
            <div><b>本次生成的邀请码</b><span>关闭或刷新页面后将无法查看完整号码</span></div>
            <textarea readOnly value={generatedCodes.join("\n")} aria-label="本次生成的邀请码" />
            <button type="button" onClick={() => void copyGeneratedCodes()}>复制全部邀请码</button>
          </div> : null}
        </section>
        <section className="admin-list admin-invitation-list">
          <header><h2>邀请码记录</h2><span>{invitations.length} 个邀请码</span></header>
          {invitations.length ? <div className="admin-invite-table">
            {invitations.map((item) => {
              const expired = item.availability === "expired";
              const exhausted = item.availability === "exhausted";
              const stateLabel = item.availability === "disabled" ? "已停用" : expired ? "已过期" : exhausted ? "已用完" : "可使用";
              return <article key={item.id}>
                <div className="admin-invite-code"><b>{item.codeHint}</b><span>{item.note || "未填写备注"}</span></div>
                <div><small>使用次数</small><b>{item.usedCount} / {item.maxUses}</b></div>
                <div><small>注册权益</small><b>{item.memberLevel} · {item.giftPoints.toLocaleString()} 积分</b></div>
                <div><small>有效期</small><b>{item.expiresAt ? new Date(item.expiresAt * 1000).toLocaleDateString("zh-CN") : "长期有效"}</b></div>
                <div><small>最近使用</small><b>{item.lastUsedBy || "尚未使用"}</b></div>
                <em className={stateLabel === "可使用" ? "is-active" : ""}>{stateLabel}</em>
                <button type="button" disabled={busy || expired || exhausted} onClick={() => void changeInvitationStatus(item)}>{item.status === "active" ? "停用" : "启用"}</button>
              </article>;
            })}
          </div> : <div className="admin-empty">还没有邀请码，可以先生成一个用于注册测试。</div>}
        </section>
      </> : <section className="admin-list admin-user-section">
        <header><h2>会员、权限与积分</h2><div className="admin-user-heading-actions"><span>{users.length} 个账号</span><button className="admin-add" onClick={() => setMemberForm({ ...emptyMember })}>＋ 新增会员</button></div></header>
        {memberForm ? <form className="admin-member-editor" onSubmit={(event) => void saveMemberAccount(event)}>
          <header><div><b>{memberForm.id ? "编辑会员资料" : "新增会员账号"}</b><span>{memberForm.id ? "密码留空表示不修改" : "创建后会员可立即登录"}</span></div><button type="button" onClick={() => setMemberForm(null)}>取消</button></header>
          <label><span>登录账号</span><input value={memberForm.username} onChange={(event) => setMemberForm({ ...memberForm, username: event.target.value })} placeholder="3–32 位字母或数字" minLength={3} maxLength={32} required /></label>
          <label><span>会员名称</span><input value={memberForm.displayName} onChange={(event) => setMemberForm({ ...memberForm, displayName: event.target.value })} placeholder="会员或商家名称" maxLength={40} required /></label>
          <label><span>{memberForm.id ? "重置密码（可选）" : "初始密码"}</span><input type="password" value={memberForm.password} onChange={(event) => setMemberForm({ ...memberForm, password: event.target.value })} placeholder={memberForm.id ? "不修改请留空" : "至少 8 个字符"} minLength={memberForm.id ? undefined : 8} maxLength={72} required={!memberForm.id} /></label>
          <label><span>会员等级</span><select value={memberForm.level} onChange={(event) => setMemberForm({ ...memberForm, level: event.target.value })}><option value="basic">基础会员</option><option value="growth">成长会员</option><option value="business">商家会员</option><option value="vip">VIP 会员</option></select></label>
          {!memberForm.id ? <label><span>初始积分</span><input type="number" min="0" value={memberForm.points} onChange={(event) => setMemberForm({ ...memberForm, points: Number(event.target.value) })} /></label> : null}
          <button className="admin-primary" disabled={busy} type="submit">{busy ? "正在保存…" : memberForm.id ? "保存会员资料" : "创建会员账号"}</button>
        </form> : null}
        <div className="admin-user-list">{users.map((item) => <article key={item.id}><i>{item.displayName.slice(0, 1) || "会"}</i><div className="admin-user-main"><h3>{item.displayName}</h3><p>@{item.username} · {item.level}</p></div><label><span>权限</span><select value={item.role} disabled={busy || item.id === member.id} onChange={(event) => void updateUser(item, { role: event.target.value })}><option value="member">普通会员</option><option value="admin">管理员</option><option value="super_admin">超级管理员</option></select></label><label><span>状态</span><select value={item.status} disabled={busy || item.id === member.id} onChange={(event) => void updateUser(item, { status: event.target.value })}><option value="active">正常</option><option value="disabled">停用</option></select></label><div className="admin-user-points"><strong>{item.points.toLocaleString()} 积分</strong><input type="number" value={pointEdits[item.id] || ""} onChange={(event) => setPointEdits((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="输入增减值" /><button disabled={busy || !pointEdits[item.id]} onClick={() => void updateUser(item, { pointDelta: Number(pointEdits[item.id]) })}>调整</button></div><button className="admin-user-edit" disabled={busy} onClick={() => editMember(item)}>编辑资料</button></article>)}</div>
      </section>}
    </section>
  </main>;
}

function RechargeEditor({ item, pointsPerYuan, onChange, onDelete }: { item: RechargePackage; pointsPerYuan: number; onChange: (item: RechargePackage) => void; onDelete: () => void }) {
  const basePoints = Math.max(1, Math.floor(Number(item.priceYuan) * Math.max(1, Math.floor(Number(pointsPerYuan) || 10))));
  const totalPoints = basePoints + Math.max(0, Math.floor(Number(item.bonus) || 0));
  const bonusRate = basePoints > 0 ? Math.max(0, Number(item.bonus) || 0) / basePoints : 0;
  return <article className={bonusRate > 0.3 ? "is-pricing-risk" : ""}><header><input value={item.name} aria-label="套餐名称" onChange={(event) => onChange({ ...item, name: event.target.value })} /><button className={`admin-switch ${item.enabled ? "is-on" : ""}`} onClick={() => onChange({ ...item, enabled: !item.enabled })}>{item.enabled ? "上架" : "下架"}</button></header><div><label><span>售价（元）</span><input type="number" min="0.01" step="0.01" value={item.priceYuan} onChange={(event) => onChange({ ...item, priceYuan: Number(event.target.value) })} /></label><label><span>按比例积分</span><input type="number" value={basePoints} readOnly aria-readonly="true" /></label><label><span>赠送积分</span><input type="number" min="0" value={item.bonus} onChange={(event) => onChange({ ...item, bonus: Number(event.target.value) })} /></label></div><footer><div><b>{totalPoints.toLocaleString()} 积分</b><small>{(totalPoints / Math.max(0.01, Number(item.priceYuan) || 0.01)).toFixed(1)} 积分 / 元</small></div><span>¥{Number(item.priceYuan || 0).toFixed(2)}</span>{bonusRate > 0.3 ? <em>赠送比例过高</em> : null}<button onClick={onDelete}>删除</button></footer></article>;
}
