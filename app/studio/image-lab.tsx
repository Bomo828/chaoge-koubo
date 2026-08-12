"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ArrowDown,
  Briefcase,
  Buildings,
  CheckCircle,
  DownloadSimple,
  Drop,
  ForkKnife,
  GraduationCap,
  Lightning,
  MapPin,
  TreePalm,
  ShieldCheck,
  ShoppingCart,
  Sparkle,
  UploadSimple,
  X,
} from "@phosphor-icons/react";

type Props = {
  onPointsChange: (points: number) => void;
};

type IndustryId = "restaurant" | "beauty" | "ecommerce" | "education" | "local" | "realestate" | "b2b" | "travel";
type ReferenceRole = "产品身份" | "门店环境" | "品牌氛围" | "构图参考";

type ReferenceImage = {
  id: string;
  name: string;
  url: string;
  role: ReferenceRole;
};

type Concept = {
  id: string;
  code: string;
  name: string;
  reaction: string;
  angle: string;
  visual: string;
  safeArea: string;
  image: string;
};

type ImageQuote = { estimatedPoints: number; note?: string };

type CopyLayoutStyle = "editorial-stack" | "compact-card" | "cinematic-band" | "open-type" | "split-level" | "poster-block" | "corner-caption";

type CopyLayout = {
  anchor: "top-left" | "top-center" | "top-right" | "center-left" | "center" | "center-right" | "bottom-left" | "bottom-center" | "bottom-right";
  xPct: number;
  yPct: number;
  widthPct: number;
  align: "left" | "center" | "right";
  style: CopyLayoutStyle;
  headlineSizeCqw: number;
  headlineLineHeight: number;
  headlineLetterSpacingEm: number;
  headlineWeight: 700 | 800 | 900;
  subtitleSizeCqw: number;
  textColor: string;
  accentColor: string;
  surface: "none" | "scrim" | "solid";
  surfaceOpacity: number;
};

type CopyVariant = {
  headline: string;
  headlineLines: string[];
  subheadline: string;
  cta: string;
  layout: CopyLayout;
  aiGenerated: boolean;
};

const industries = [
  { id: "restaurant" as const, label: "餐饮", sub: "Food", icon: ForkKnife },
  { id: "beauty" as const, label: "美业", sub: "Beauty", icon: Drop },
  { id: "ecommerce" as const, label: "零售电商", sub: "Retail", icon: ShoppingCart },
  { id: "education" as const, label: "教育培训", sub: "Education", icon: GraduationCap },
  { id: "local" as const, label: "本地服务", sub: "Local", icon: MapPin },
  { id: "realestate" as const, label: "房产家居", sub: "Property", icon: Buildings },
  { id: "b2b" as const, label: "B2B", sub: "Business", icon: Briefcase },
  { id: "travel" as const, label: "文旅活动", sub: "Travel", icon: TreePalm },
];

const concepts: Concept[] = [
  {
    id: "hero",
    code: "01 / HERO",
    name: "产品定场",
    reaction: "第一眼记住主推服务",
    angle: "以核心产品或服务结果作为唯一视觉主角，建立高级、可信、可识别的品牌第一印象。",
    visual: "单一主角、近景材质、强轮廓光、左侧标题安全区",
    safeArea: "左 34% 保持低细节，用于标题与权益信息",
    image: "/media/image-lab/product-hero.png",
  },
  {
    id: "scene",
    code: "02 / SCENE",
    name: "到店引力",
    reaction: "想象自己进入现场",
    angle: "让用户进入真实消费场景，用空间、人物动线与服务细节制造到店冲动。",
    visual: "广角空间、前景产品、人物活动、霓虹品牌色",
    safeArea: "左上预留主标题，右下避免重要信息",
    image: "/media/image-lab/store-scene.png",
  },
  {
    id: "editorial",
    code: "03 / EDITORIAL",
    name: "专业证据",
    reaction: "相信品质与专业度",
    angle: "用编辑式拼贴呈现材质、过程与细节证据，适合品牌种草和专业能力表达。",
    visual: "微距细节、玻璃材质、流程切片、杂志感留白",
    safeArea: "中心主体完整，底部 18% 可放证明点",
    image: "/media/image-lab/editorial-collage.png",
  },
];

const platformOptions = [
  { id: "xiaohongshu", label: "小红书", size: "960x1280", ratio: "3:4", layoutGuidance: "主体保持缩略图可读，保护上方与下方文案区，关键内容离边缘至少8%" },
  { id: "ecommerce", label: "电商主图", size: "1024x1024", ratio: "1:1", layoutGuidance: "保持中心层级和10%裁切安全区，使用一个清晰的文案簇" },
  { id: "douyin", label: "抖音竖版", size: "1088x1920", ratio: "9:16", layoutGuidance: "避开上下平台界面区域，主体和文案都进入中部安全区" },
  { id: "wechat", label: "公众号横版", size: "1920x1088", ratio: "16:9", layoutGuidance: "建立主体与文字的左右分区，保留35%至45%的低细节文案区域" },
];

const objectives = ["新品发布", "到店引流", "活动转化", "品牌种草", "销售线索"];
const referenceRoles: ReferenceRole[] = ["产品身份", "门店环境", "品牌氛围", "构图参考"];

function uid(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function walletPoints(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const points = Number((value as { points?: unknown }).points);
  return Number.isFinite(points) ? points : null;
}

function defaultCopyLayout(ratio: string): CopyLayout {
  const typography = { style: "compact-card" as const, headlineLineHeight: 1.02, headlineLetterSpacingEm: -0.03, headlineWeight: 800 as const, subtitleSizeCqw: 2.7 };
  if (ratio === "16:9") return { anchor: "center-left", xPct: 7, yPct: 50, widthPct: 42, align: "left", headlineSizeCqw: 8, textColor: "#FFFFFF", accentColor: "#F4C95D", surface: "scrim", surfaceOpacity: 0.58, ...typography };
  return { anchor: "bottom-left", xPct: 8, yPct: 92, widthPct: ratio === "9:16" ? 78 : 68, align: "left", headlineSizeCqw: ratio === "9:16" ? 11 : 9, textColor: "#FFFFFF", accentColor: "#F4C95D", surface: "scrim", surfaceOpacity: 0.58, ...typography };
}

function createCopyVariant(ratio: string, copy?: Partial<Pick<CopyVariant, "headline" | "headlineLines" | "subheadline" | "cta">>): CopyVariant {
  const headline = copy?.headline ?? "";
  return {
    headline,
    headlineLines: copy?.headlineLines?.length ? copy.headlineLines : headline ? [headline] : [],
    subheadline: copy?.subheadline ?? "",
    cta: copy?.cta ?? "",
    layout: defaultCopyLayout(ratio),
    aiGenerated: false,
  };
}

async function imageSourceForAi(source: string) {
  if (/^data:image\//i.test(source)) return source.length <= 12_000_000 ? source : "";
  if (/^https?:\/\//i.test(source)) return source;
  try {
    const response = await fetch(source);
    if (!response.ok) return "";
    const blob = await response.blob();
    if (!blob.type.startsWith("image/") || blob.size > 8_000_000) return "";
    return await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.onerror = () => resolve("");
      reader.readAsDataURL(blob);
    });
  } catch {
    return "";
  }
}

function buildPrompt(input: {
  industry: string;
  objective: string;
  audience: string;
  message: string;
  concept: Concept;
  platform: string;
  ratio: string;
  references: ReferenceImage[];
}) {
  const referenceDescription = input.references.length
    ? input.references.map((item, index) => `参考图${index + 1}“${item.name}”仅承担${item.role}角色`).join("；")
    : "无参考图，不得虚构真实门店、具体产品包装、证书、价格或人物身份";
  return [
    `角色与交付：你是中国市场的资深营销视觉总监，为${input.industry}行业制作一张可直接投放的${input.platform}营销主视觉，画幅${input.ratio}。`,
    `营销目标：${input.objective}。目标受众：${input.audience}。核心信息：${input.message}。`,
    `创意方向“${input.concept.name}”：${input.concept.angle} 期望用户反应：${input.concept.reaction}。`,
    `场景与主体：围绕本次核心信息“${input.message}”建立唯一明确的视觉主角；${input.concept.visual}。`,
    `构图与安全区：${input.concept.safeArea}；缩略图状态下主体仍清楚，视觉层级只保留主角、证明细节和后期文案区。`,
    "视觉锚点：专业、真实、清晰；色彩采用深海军蓝、电子青、品红与少量信号黄，强对比但不廉价。",
    `参考图角色：${referenceDescription}。参考只用于指定角色，不得把参考图中的无关文字、水印或人物身份带入。`,
    `真实约束：不得添加未提供的功效、资质、销量、折扣、成分、地标或服务承诺；人物肢体自然，产品结构正确，空间透视真实。`,
    `后期排版：严格按照“${input.concept.safeArea}”保留干净的视觉呼吸区；图片内严禁生成任何文字、字母、数字、价格、二维码或水印。`,
    "禁止：无关Logo、水印、二维码、随机英文、错误中文、过度磨皮、塑料质感、拥挤信息、低清晰度、重复肢体和变形产品。",
  ].join("\n");
}

export function IndustryImageLab({ onPointsChange }: Props) {
  const [industry, setIndustry] = useState<IndustryId>("local");
  const [objective, setObjective] = useState("到店引流");
  const [audience, setAudience] = useState("");
  const [message, setMessage] = useState("");
  const [platform, setPlatform] = useState(platformOptions[0].id);
  const [selectedConceptId, setSelectedConceptId] = useState(concepts[0].id);
  const [references, setReferences] = useState<ReferenceImage[]>([]);
  const [generatedUrls, setGeneratedUrls] = useState<string[]>([]);
  const [selectedResult, setSelectedResult] = useState(0);
  const [copyVariants, setCopyVariants] = useState<CopyVariant[]>(() => [createCopyVariant(platformOptions[0].ratio)]);
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [quote, setQuote] = useState<ImageQuote | null>(null);
  const [status, setStatus] = useState("等待发射");
  const [progress, setProgress] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [industryMenuOpen, setIndustryMenuOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const industryPickerRef = useRef<HTMLDivElement>(null);

  const selectedIndustry = industries.find((item) => item.id === industry) ?? industries[1];
  const SelectedIndustryIcon = selectedIndustry.icon;
  const selectedConcept = concepts.find((item) => item.id === selectedConceptId) ?? concepts[0];
  const selectedPlatform = platformOptions.find((item) => item.id === platform) ?? platformOptions[0];
  const stageImage = generatedUrls[selectedResult] || selectedConcept.image;
  const currentCopy = copyVariants[selectedResult] ?? copyVariants[0] ?? createCopyVariant(selectedPlatform.ratio);
  const copyHeadline = currentCopy.headline;
  const copySubheadline = currentCopy.subheadline;
  const copyCta = currentCopy.cta;
  const copyLayout = currentCopy.layout;
  const copyLayerStyle = useMemo(() => ({
    left: `${copyLayout.xPct}%`,
    top: `${copyLayout.yPct}%`,
    width: `${copyLayout.widthPct}%`,
    color: copyLayout.textColor,
    textAlign: copyLayout.align,
    background: copyLayout.surface === "none"
      ? "transparent"
      : copyLayout.surface === "solid"
        ? `rgba(14, 15, 19, ${copyLayout.surfaceOpacity})`
        : `rgba(9, 10, 13, ${copyLayout.surfaceOpacity})`,
    backdropFilter: copyLayout.surface === "none" ? "none" : "blur(8px)",
    "--copy-accent": copyLayout.accentColor,
    "--copy-headline-size": `${copyLayout.headlineSizeCqw}cqw`,
    "--copy-headline-line-height": copyLayout.headlineLineHeight,
    "--copy-headline-tracking": `${copyLayout.headlineLetterSpacingEm}em`,
    "--copy-headline-weight": copyLayout.headlineWeight,
    "--copy-subtitle-size": `${copyLayout.subtitleSizeCqw}cqw`,
  }) as CSSProperties, [copyLayout]);
  const prompt = useMemo(() => buildPrompt({
    industry: selectedIndustry.label,
    objective,
    audience,
    message,
    concept: selectedConcept,
    platform: selectedPlatform.label,
    ratio: selectedPlatform.ratio,
    references,
  }), [audience, message, objective, references, selectedConcept, selectedIndustry.label, selectedPlatform.label, selectedPlatform.ratio]);

  function updateCopyVariant(index: number, patch: Partial<CopyVariant>) {
    setCopyVariants((current) => {
      const next = [...current];
      const base = next[index] ?? createCopyVariant(selectedPlatform.ratio);
      next[index] = { ...base, ...patch };
      return next;
    });
  }

  function resetVisualOutput(ratio: string) {
    setSelectedResult(0);
    setCopyVariants((current) => [{ ...(current[0] ?? createCopyVariant(ratio)), layout: defaultCopyLayout(ratio), aiGenerated: false }]);
    if (generatedUrls.length) setGeneratedUrls([]);
  }

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      size: selectedPlatform.size,
      quality: "high",
      count: "3",
      references: String(references.length),
    });
    fetch(`/api/ai/pricing?${params}`, { signal: controller.signal, cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("quote unavailable")))
      .then((data: { quote?: ImageQuote }) => setQuote(data.quote ?? null))
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) setQuote(null);
      });
    return () => controller.abort();
  }, [references.length, selectedPlatform.size]);

  useEffect(() => {
    if (!industryMenuOpen) return;
    function closeIndustryMenu(event: PointerEvent) {
      if (industryPickerRef.current && !industryPickerRef.current.contains(event.target as Node)) setIndustryMenuOpen(false);
    }
    function closeIndustryMenuWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setIndustryMenuOpen(false);
    }
    window.addEventListener("pointerdown", closeIndustryMenu);
    window.addEventListener("keydown", closeIndustryMenuWithEscape);
    return () => {
      window.removeEventListener("pointerdown", closeIndustryMenu);
      window.removeEventListener("keydown", closeIndustryMenuWithEscape);
    };
  }, [industryMenuOpen]);

  async function addReferences(files: FileList | null) {
    if (!files?.length) return;
    const room = Math.max(0, 10 - references.length);
    const selected = [...files].filter((file) => file.type.startsWith("image/")).slice(0, room);
    const loaded = await Promise.all(selected.map((file, index) => new Promise<ReferenceImage>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({
        id: uid("ref"),
        name: file.name,
        url: String(reader.result),
        role: referenceRoles[Math.min(index, referenceRoles.length - 1)],
      });
      reader.onerror = reject;
      reader.readAsDataURL(file);
    })));
    setReferences((current) => [...current, ...loaded].slice(0, 10));
  }

  function updateReferenceRole(id: string, role: ReferenceRole) {
    setReferences((current) => current.map((item) => item.id === id ? { ...item, role } : item));
  }

  function removeReference(id: string) {
    setReferences((current) => current.filter((item) => item.id !== id));
  }

  async function generateMarketingCopy() {
    if (copyBusy) return;
    const targetResult = selectedResult;
    const targetImage = stageImage;
    setCopyBusy(true);
    setCopyError("");
    try {
      const image = await imageSourceForAi(targetImage);
      const response = await fetch("/api/ai/image-copy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          industry: selectedIndustry.label,
          objective,
          audience,
          message,
          concept: `${selectedConcept.name}：${selectedConcept.angle}`,
          platform: selectedPlatform.label,
          ratio: selectedPlatform.ratio,
          variantIndex: targetResult,
          siblingLayouts: copyVariants.flatMap((variant, index) => index !== targetResult && variant.aiGenerated ? [{
            index,
            style: variant.layout.style,
            anchor: variant.layout.anchor,
            align: variant.layout.align,
            surface: variant.layout.surface,
            linePattern: variant.headlineLines.map((line) => line.length).join("-"),
          }] : []),
          image,
          skillContext: {
            source: "industry-marketing-image",
            mode: "generate",
            concept: {
              id: selectedConcept.id,
              name: selectedConcept.name,
              marketingAngle: selectedConcept.angle,
              intendedReaction: selectedConcept.reaction,
              visualStructure: selectedConcept.visual,
              editableTextSafeArea: selectedConcept.safeArea,
            },
            platform: {
              id: selectedPlatform.id,
              label: selectedPlatform.label,
              size: selectedPlatform.size,
              ratio: selectedPlatform.ratio,
              layoutGuidance: selectedPlatform.layoutGuidance,
            },
            referenceRoles: references.map((item) => ({ name: item.name, role: item.role })),
            image2CompositionPlan: prompt,
          },
          requestId: uid("image_copy"),
        }),
      });
      const data = await response.json() as {
        error?: string;
        headline?: string;
        headlineLines?: string[];
        subheadline?: string;
        cta?: string;
        layout?: CopyLayout;
        wallet?: unknown;
      };
      if (!response.ok || !data.headline || !data.subheadline || !data.cta || !data.layout) throw new Error(data.error || "AI 没有返回完整文案与排版");
      updateCopyVariant(targetResult, {
        headline: data.headline,
        headlineLines: data.headlineLines?.length ? data.headlineLines : [data.headline],
        subheadline: data.subheadline,
        cta: data.cta,
        layout: data.layout,
        aiGenerated: true,
      });
      const points = walletPoints(data.wallet);
      if (points !== null) onPointsChange(points);
    } catch (cause) {
      setCopyError(cause instanceof Error ? cause.message : "AI 文案生成失败，请重试");
    } finally {
      setCopyBusy(false);
    }
  }

  async function generate() {
    if (generating) return;
    setGenerating(true);
    setError("");
    setGeneratedUrls([]);
    setSelectedResult(0);
    setCopyVariants(Array.from({ length: 3 }, () => createCopyVariant(selectedPlatform.ratio, currentCopy)));
    setProgress(8);
    setStatus("正在提交 3 个独立任务");
    const requestId = uid("marketing_image");
    try {
      const response = await fetch("/api/ai/images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          size: selectedPlatform.size,
          quality: "high",
          count: 3,
          images: references.map((item) => item.url),
          section: "营销海报",
          requestId,
        }),
      });
      const data = await response.json() as {
        error?: string;
        urls?: string[];
        taskIds?: string[];
        requestId?: string;
        state?: string;
        isFinal?: boolean;
        progress?: string;
        wallet?: unknown;
      };
      if (!response.ok) throw new Error(data.error || "图片任务发射失败");
      const points = walletPoints(data.wallet);
      if (points !== null) onPointsChange(points);
      let urls = data.urls ?? [];
      const taskIds = data.taskIds ?? [];
      let final = Boolean(data.isFinal);
      setProgress(Number.parseInt(data.progress || "12", 10) || 12);
      setStatus(final ? "三张成品已返回" : "Image2 正在生成");
      for (let attempt = 0; !final && taskIds.length && attempt < 40; attempt += 1) {
        await sleep(3000);
        const poll = await fetch(`/api/ai/images?task_ids=${encodeURIComponent(taskIds.join(","))}&request_id=${encodeURIComponent(data.requestId || requestId)}`, { cache: "no-store" });
        const polled = await poll.json() as typeof data;
        if (!poll.ok) throw new Error(polled.error || "查询图片任务失败");
        urls = polled.urls ?? urls;
        final = Boolean(polled.isFinal);
        setProgress(Number.parseInt(polled.progress || "0", 10) || Math.min(92, 18 + attempt * 3));
        setStatus(final ? "三张成品已返回" : `生成中 · ${Number.parseInt(polled.progress || "0", 10) || Math.min(92, 18 + attempt * 3)}%`);
        const wallet = walletPoints(polled.wallet);
        if (wallet !== null) onPointsChange(wallet);
      }
      if (!urls.length) throw new Error("任务仍在生成，请稍后再试");
      setGeneratedUrls(urls.slice(0, 3));
      setProgress(100);
      setStatus("已完成 · 选择一张继续使用");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "图片生成失败");
      setStatus("发射中断");
    } finally {
      setGenerating(false);
    }
  }

  /*
   * Direction contract — print proofing table.
   * Intent: make one marketing image job feel calm, tactile, and immediately operable.
   * Hierarchy: job ticket → proof canvas → contact sheet → generate.
   * Own-world cues: graphite stock, registration marks, restrained proofing inks.
   * Avoid: gamer HUDs, neon outlines, clipped panels, giant display type, decorative telemetry.
   * Seed: c3dedf8f.
   */
  return (
    <section
      className="proof-studio"
      data-design-seed="c3dedf8f"
      data-thesis="让一项营销图片任务像印刷打样一样冷静、具体、可立即操作"
      data-own-world="石墨工作台、套准标记、克制的品红青黄打样墨色"
      data-story="创作需求→画布预览→生成结果→生成或下载"
      data-first-viewport="先理解任务与主画布，再看到唯一主操作"
      data-form="工单、打样画布、联系表"
      data-finish="柔和表面层级、标准控件、无霓虹异形框"
    >
      <header className="proof-studio-header">
        <h1>图片创作</h1>
      </header>

      <div className="proof-workspace">
        <aside className="proof-ticket" aria-label="创作需求">
          <div className="proof-panel-heading"><div><h2>创作需求</h2></div></div>
          <div className="proof-ticket-fields">
            <div className="proof-field proof-industry-field" ref={industryPickerRef}>
              <span>营销行业</span>
              <button type="button" className="proof-industry-button" aria-haspopup="menu" aria-expanded={industryMenuOpen} onClick={() => setIndustryMenuOpen((open) => !open)}><i><SelectedIndustryIcon weight="fill" /></i><b>{selectedIndustry.label}</b><ArrowDown weight="bold" /></button>
              {industryMenuOpen ? <div className="proof-industry-menu" role="menu">{industries.map((item) => {
                const Icon = item.icon;
                return <button type="button" role="menuitemradio" aria-checked={industry === item.id} key={item.id} className={industry === item.id ? "active" : ""} onClick={() => { setIndustry(item.id); setIndustryMenuOpen(false); }}><Icon weight={industry === item.id ? "fill" : "regular"} /><span>{item.label}</span></button>;
              })}</div> : null}
            </div>
            <label className="proof-field"><span>营销目标</span><div className="proof-select-wrap"><select value={objective} onChange={(event) => setObjective(event.target.value)}>{objectives.map((item) => <option key={item}>{item}</option>)}</select><ArrowDown /></div></label>
            <label className="proof-field"><span>目标受众</span><textarea value={audience} onChange={(event) => setAudience(event.target.value)} rows={2} /></label>
            <label className="proof-field"><span>核心卖点</span><textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={3} /></label>
          </div>
          <div className="proof-size-field">
            <span>图片尺寸</span>
            <div className="proof-formats" aria-label="图片尺寸">{platformOptions.map((item) => <button type="button" key={item.id} aria-label={`${item.label} ${item.ratio}`} aria-pressed={platform === item.id} className={platform === item.id ? "active" : ""} onClick={() => { setPlatform(item.id); resetVisualOutput(item.ratio); }}>{item.ratio}</button>)}</div>
          </div>
        </aside>

        <main className="proof-build-panel">
          <div className="proof-visual-inputs">
            <section className="proof-materials-panel" aria-label="参考素材">
              <div className="proof-panel-heading"><div><h2>参考素材</h2></div><small>{references.length}/10</small></div>
              <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(event) => void addReferences(event.target.files)} />
              {references.length ? <div className="proof-reference-list">{references.map((item) => <div key={item.id}><img src={item.url} alt="" /><select aria-label={`${item.name}的用途`} value={item.role} onChange={(event) => updateReferenceRole(item.id, event.target.value as ReferenceRole)}>{referenceRoles.map((role) => <option key={role}>{role}</option>)}</select><button type="button" aria-label={`移除 ${item.name}`} onClick={() => removeReference(item.id)}><X /></button></div>)}</div> : null}
              <button type="button" className="proof-upload" onClick={() => fileInputRef.current?.click()} disabled={references.length >= 10}><UploadSimple /><b>添加参考图</b></button>
            </section>

            <section className="proof-directions" aria-label="创意方向">
              <div className="proof-section-label"><span>创意方向</span></div>
              <div>{concepts.map((item) => <button type="button" key={item.id} aria-pressed={selectedConceptId === item.id} className={selectedConceptId === item.id ? "active" : ""} onClick={() => { setSelectedConceptId(item.id); resetVisualOutput(selectedPlatform.ratio); }}><img src={item.image} alt="" /><span><b>{item.name}</b><i>{item.reaction}</i></span></button>)}</div>
            </section>
          </div>

          <section className="proof-copy-panel" aria-label="文案信息">
            <div className="proof-panel-heading"><div><h2>文案信息</h2></div><button type="button" className="proof-copy-generate" onClick={() => void generateMarketingCopy()} disabled={copyBusy}><Sparkle weight="fill" />{copyBusy ? "分析画面中" : copyHeadline ? "AI 重新排版" : "AI 文案与排版"}</button></div>
            <div className="proof-copy-fields">
              <label><span>主标题</span><input value={copyHeadline} maxLength={24} placeholder="由 AI 生成，可手动修改" onChange={(event) => updateCopyVariant(selectedResult, { headline: event.target.value, headlineLines: event.target.value ? [event.target.value] : [] })} /></label>
              <label><span>副标题</span><textarea value={copySubheadline} maxLength={48} rows={2} placeholder="补充卖点或使用场景" onChange={(event) => updateCopyVariant(selectedResult, { subheadline: event.target.value })} /></label>
              <label><span>行动文案</span><input value={copyCta} maxLength={12} placeholder="例如：立即预约" onChange={(event) => updateCopyVariant(selectedResult, { cta: event.target.value })} /></label>
            </div>
            {copyError ? <p className="proof-copy-error" role="alert">{copyError}</p> : null}
          </section>
        </main>

        <aside className="proof-preview-panel" aria-label="画布预览">
          <div className="proof-panel-heading proof-canvas-heading"><div><h2>{generatedUrls.length ? "成品预览" : "画布预览"}</h2></div></div>
          <div className="proof-stage">
            <span className="proof-register proof-register-a" aria-hidden="true" />
            <span className="proof-register proof-register-b" aria-hidden="true" />
            <div className="proof-frame" data-ratio={selectedPlatform.ratio}>
              <img key={stageImage} src={stageImage} alt={generatedUrls.length ? `生成结果 ${selectedResult + 1}` : selectedConcept.name} />
              {copyHeadline ? <div className="proof-preview-copy is-marketing-copy" data-layout-engine="adaptive-v3" data-anchor={copyLayout.anchor} data-surface={copyLayout.surface} data-style={copyLayout.style} style={copyLayerStyle}><h3>{currentCopy.headlineLines.length ? currentCopy.headlineLines.map((line, index) => <span key={`${line}-${index}`}>{line}</span>) : copyHeadline}</h3>{copySubheadline ? <p>{copySubheadline}</p> : null}{copyCta ? <b>{copyCta}</b> : null}</div> : null}
            </div>
          </div>

          {generatedUrls.length ? <section className="proof-result-switcher" aria-label="方案选择"><div className="proof-section-label"><span>方案选择</span></div><div className="proof-result-list">{generatedUrls.map((url, index) => {
            const active = selectedResult === index;
            return <button type="button" key={url} aria-label={`生成方案 ${index + 1}`} aria-pressed={active} className={active ? "active" : ""} onClick={() => setSelectedResult(index)}><img src={url} alt={`生成方案 ${index + 1}`} /><span className="proof-result-number">0{index + 1}</span><CheckCircle weight={active ? "fill" : "regular"} /></button>;
          })}</div></section> : null}

          <div className="proof-launch">
            <div className="proof-cost"><span>本次预计</span><b>{quote?.estimatedPoints ?? "—"}<small> PTS</small></b></div>
            <div className="proof-status" role="status" aria-live="polite"><ShieldCheck weight="fill" /><span>{error || (generating ? `${progress}% · ${status}` : "高质量生成 · 一次输出 3 张")}</span></div>
            <button type="button" className="proof-generate" onClick={() => void generate()} disabled={generating}><Lightning weight="fill" /><span>{generating ? "正在生成" : generatedUrls.length ? "重新生成 3 张" : "生成 3 张图片"}</span></button>
            {generatedUrls[selectedResult] ? <a className="proof-download" href={generatedUrls[selectedResult]} download target="_blank" rel="noreferrer"><DownloadSimple />下载当前底图</a> : null}
          </div>
          <details className="proof-prompt"><summary><span>查看生成细节</span><ArrowDown /></summary><pre>{prompt}</pre></details>
        </aside>
      </div>
    </section>
  );
}
