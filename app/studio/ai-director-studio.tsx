"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  FloppyDisk,
  Image as ImageIcon,
  LinkSimple,
  MagicWand,
  Microphone,
  UploadSimple,
  VideoCamera,
  Waveform,
  X,
} from "@phosphor-icons/react";
import { loadAiDirectorDraft, saveAiDirectorDraft } from "../../lib/ai-director-draft";
import { generatedVideoPrompt } from "../../lib/ai-video-director-skills";

type Voice = { voiceId: string; name: string; language: "cn" | "en"; demoAudio: string };
type SourceMode = "original" | "reference";
type AssetKind = "image" | "video";

type DirectorAsset = {
  id: string;
  name: string;
  kind: AssetKind;
  file: File;
  previewUrl: string;
  duration: number;
  frames: string[];
  frameLabels: string[];
  state: "reading" | "ready" | "failed";
  error?: string;
};

type MaterialAnalysis = {
  contentSummary: string;
  contentStrategy?: {
    corePromise?: string;
    audienceTension?: string;
    hook?: string;
    narrativeArc?: string[];
    proofBoundary?: string;
    callToAction?: string;
  };
  coverage: string;
  gaps: string[];
  creativeOpportunities?: Array<{
    beat?: string;
    purpose?: string;
    anchorAssetId?: string;
    creationMode?: "preserve" | "extend" | "rebuild";
    permittedAdditions?: string[];
    visualDirection?: string;
  }>;
  assets: Array<{
    assetId: string;
    summary: string;
    identityAnchors?: string[];
    usableMoments: string[];
    quality: "high" | "medium" | "low";
    risk: string;
  }>;
};

type DirectorShot = {
  id: string;
  start: number;
  end: number;
  beat: string;
  purpose: string;
  narration: string;
  visual: string;
  assetId: string;
  referenceFrame: number;
  sourceIn: number;
  sourceOut: number;
  renderMode: "image-to-video" | "ai-generated-video" | "source-video";
  creationMode: "preserve" | "extend" | "rebuild";
  characters: string;
  environment: string;
  props: string;
  shotSize: string;
  cameraAngle: string;
  composition: string;
  cameraMotion: string;
  subjectAction: string;
  lighting: string;
  color: string;
  transition: string;
  soundDesign: string;
  continuity: string;
  negativePrompt: string;
  confidence: number;
};

type Storyboard = {
  projectTitle: string;
  creativeConcept?: string;
  directorNote: string;
  musicDirection: string;
  visualRhythm: string;
  duration: number;
  shots: DirectorShot[];
  qualityGate?: { passed?: boolean; score?: number; warnings?: string[] };
};

type WorkerJob = {
  id?: string;
  state?: "queued" | "running" | "success" | "failed";
  progress?: number;
  message?: string;
  transcript?: string;
  captions?: Array<{ text?: string }>;
  benchmark_title?: string;
  title?: string;
  error?: string;
};

type ProductionShot = {
  shotId: string;
  state: "waiting" | "submitting" | "generating" | "ready" | "failed";
  progress: number;
  requestId: string;
  taskId: string;
  mediaUrl: string;
  error: string;
};

type SeedanceTask = {
  error?: string;
  taskId?: string | null;
  requestId?: string;
  isFinal?: boolean;
  state?: string;
  progress?: string;
  resultUrl?: string;
  wallet?: { points?: number };
};

type MpsTask = {
  configured?: boolean;
  missing?: string[];
  jobId?: string;
  taskId?: string;
  state?: "running" | "success" | "failed";
  progress?: number;
  mediaUrl?: string;
  error?: string;
};

type DirectorDraftPayload = {
  sourceMode: SourceMode;
  industry: string;
  platform: string;
  goal: string;
  audience: string;
  brief: string;
  referenceUrl: string;
  referenceTitle: string;
  referenceTranscript: string;
  script: string;
  voiceId: string;
  speechSpeed: number;
  speechUrl: string;
  speechDuration: number;
  speechLocked: boolean;
  speechSource: "generate" | "upload";
  speechFile: File | null;
  assets: Array<Omit<DirectorAsset, "previewUrl">>;
  analysis: MaterialAnalysis | null;
  storyboard: Storyboard | null;
  productionShots: Record<string, ProductionShot>;
  mpsJobId: string;
  hadPreview: boolean;
  hadFinal: boolean;
};

type DraftSaveState = {
  kind: "loading" | "saving" | "saved" | "error";
  text: string;
};

const INDUSTRIES = ["本地生活", "餐饮美食", "美业健康", "教育培训", "零售电商", "企业服务", "个人IP", "其他"];
const PLATFORMS = ["抖音", "视频号", "小红书"];
const GOALS = ["获客转化", "产品讲解", "建立信任", "品牌曝光"];
const SPEEDS = [0.75, 1, 1.25, 1.5];

function waitFor(target: EventTarget, eventName: string) {
  return new Promise<void>((resolve, reject) => {
    const onDone = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("媒体文件无法读取")); };
    const cleanup = () => {
      target.removeEventListener(eventName, onDone);
      target.removeEventListener("error", onError);
    };
    target.addEventListener(eventName, onDone, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

function canvasFrame(source: CanvasImageSource, width: number, height: number) {
  const maxWidth = 960;
  const ratio = Math.min(1, maxWidth / Math.max(1, width));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法读取画面");
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", .76);
}

async function readImageFrame(url: string) {
  const image = new window.Image();
  image.decoding = "async";
  image.src = url;
  if (!image.complete) await waitFor(image, "load");
  return canvasFrame(image, image.naturalWidth, image.naturalHeight);
}

async function readVideoFrames(url: string) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.src = url;
  await waitFor(video, "loadedmetadata");
  if (video.readyState < 2) await waitFor(video, "loadeddata");
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const points = duration > 1 ? [.15, .5, .85] : [0];
  const frames: string[] = [];
  for (const point of points) {
    const seeked = waitFor(video, "seeked");
    video.currentTime = Math.max(.001, Math.min(Math.max(.001, duration - .05), duration * point || .001));
    await seeked;
    frames.push(canvasFrame(video, video.videoWidth, video.videoHeight));
  }
  video.removeAttribute("src");
  video.load();
  return { duration, frames };
}

function requestId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

async function runLimited<T>(items: T[], limit: number, action: (item: T, index: number) => Promise<void>) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await action(items[index], index);
    }
  }));
}

function savedTime(value: number) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value);
}

function seedanceDuration(shot: DirectorShot) {
  return Math.max(4, Math.min(15, Math.ceil(shot.end - shot.start)));
}

function seedancePrompt(shot: DirectorShot, projectTitle: string) {
  return generatedVideoPrompt({
    projectTitle,
    narration: shot.narration,
    purpose: shot.purpose,
    visual: shot.visual,
    creationMode: shot.creationMode,
    characters: shot.characters,
    environment: shot.environment,
    props: shot.props,
    shotSize: shot.shotSize,
    cameraAngle: shot.cameraAngle,
    composition: shot.composition,
    cameraMotion: shot.cameraMotion,
    subjectAction: shot.subjectAction,
    lighting: shot.lighting,
    color: shot.color,
    transition: shot.transition,
    soundDesign: shot.soundDesign,
    continuity: shot.continuity,
    negativePrompt: shot.negativePrompt,
  });
}

export function AiDirectorStudio({ onBack, onPointsChange, onOpenViralEditor }: { onBack: () => void; onPointsChange: (points: number) => void; onOpenViralEditor: (source: { name: string; mediaUrl: string }) => void }) {
  const [sourceMode, setSourceMode] = useState<SourceMode>("original");
  const [industry, setIndustry] = useState("本地生活");
  const [platform, setPlatform] = useState("抖音");
  const [goal, setGoal] = useState("获客转化");
  const [audience, setAudience] = useState("");
  const [brief, setBrief] = useState("突出真实体验与核心价值，内容自然可信，不夸大效果。 ");
  const [referenceUrl, setReferenceUrl] = useState("");
  const [referenceTitle, setReferenceTitle] = useState("");
  const [referenceTranscript, setReferenceTranscript] = useState("");
  const [referenceBusy, setReferenceBusy] = useState(false);
  const [referenceProgress, setReferenceProgress] = useState(0);
  const [script, setScript] = useState("");
  const [scriptBusy, setScriptBusy] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceId, setVoiceId] = useState("");
  const [speechSpeed, setSpeechSpeed] = useState(1);
  const [speechBusy, setSpeechBusy] = useState(false);
  const [speechUrl, setSpeechUrl] = useState("");
  const [speechDuration, setSpeechDuration] = useState(0);
  const [speechLocked, setSpeechLocked] = useState(false);
  const [speechSource, setSpeechSource] = useState<"generate" | "upload">("generate");
  const [speechFile, setSpeechFile] = useState<File | null>(null);
  const [assets, setAssets] = useState<DirectorAsset[]>([]);
  const [analysis, setAnalysis] = useState<MaterialAnalysis | null>(null);
  const [storyboard, setStoryboard] = useState<Storyboard | null>(null);
  const [directorBusy, setDirectorBusy] = useState<"analyze" | "storyboard" | "preview" | "produce" | "">("");
  const [directorProgress, setDirectorProgress] = useState(0);
  const [previewUrl, setPreviewUrl] = useState("");
  const [finalUrl, setFinalUrl] = useState("");
  const [productionShots, setProductionShots] = useState<Record<string, ProductionShot>>({});
  const [productionMessage, setProductionMessage] = useState("");
  const [mpsConfigured, setMpsConfigured] = useState<boolean | null>(null);
  const [mpsMissing, setMpsMissing] = useState<string[]>([]);
  const [mpsJobId, setMpsJobId] = useState("");
  const [draftReady, setDraftReady] = useState(false);
  const [draftState, setDraftState] = useState<DraftSaveState>({ kind: "loading", text: "正在读取草稿" });
  const [draftRecoveryNote, setDraftRecoveryNote] = useState("");
  const [error, setError] = useState("");
  const assetUrls = useRef<string[]>([]);
  const speechUploadUrl = useRef("");
  const previewObjectUrl = useRef("");
  const finalObjectUrl = useRef("");
  const productionShotsRef = useRef<Record<string, ProductionShot>>({});
  const restoringDraft = useRef(false);
  const automaticProductionRunning = useRef(false);
  const analysisFingerprint = useRef("");
  const resumingMps = useRef(false);

  useEffect(() => {
    let active = true;
    fetch("/api/ai/voices", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: { voices?: Voice[] }) => {
        if (!active) return;
        const loaded = Array.isArray(data.voices) ? data.voices : [];
        setVoices(loaded);
        setVoiceId((current) => current || loaded[0]?.voiceId || "");
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/ai/director/mps", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: MpsTask) => {
        if (!active) return;
        setMpsConfigured(Boolean(data.configured));
        setMpsMissing(Array.isArray(data.missing) ? data.missing : []);
      })
      .catch(() => {
        if (active) setMpsConfigured(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => () => {
    assetUrls.current.forEach((url) => URL.revokeObjectURL(url));
    if (speechUploadUrl.current) URL.revokeObjectURL(speechUploadUrl.current);
    if (previewObjectUrl.current) URL.revokeObjectURL(previewObjectUrl.current);
    if (finalObjectUrl.current) URL.revokeObjectURL(finalObjectUrl.current);
  }, []);

  useEffect(() => {
    let active = true;
    loadAiDirectorDraft<DirectorDraftPayload>()
      .then((record) => {
        if (!active || !record?.value) return;
        const draft = record.value;
        const restoredAssets = Array.isArray(draft.assets)
          ? draft.assets.filter((asset) => asset?.file instanceof File).slice(0, 12).map((asset) => {
            const previewUrl = URL.createObjectURL(asset.file);
            assetUrls.current.push(previewUrl);
            return {
              ...asset,
              previewUrl,
              frames: Array.isArray(asset.frames) ? asset.frames.filter((frame): frame is string => typeof frame === "string").slice(0, 3) : [],
              frameLabels: Array.isArray(asset.frameLabels) ? asset.frameLabels.filter((label): label is string => typeof label === "string").slice(0, 3) : [],
              state: asset.state === "ready" || asset.state === "failed" ? asset.state : "reading" as const,
            };
          })
          : [];
        const restoredSpeechFile = draft.speechFile instanceof File ? draft.speechFile : null;
        let restoredSpeechUrl = draft.speechSource === "generate" && typeof draft.speechUrl === "string" ? draft.speechUrl : "";
        if (draft.speechSource === "upload" && restoredSpeechFile) {
          restoredSpeechUrl = URL.createObjectURL(restoredSpeechFile);
          speechUploadUrl.current = restoredSpeechUrl;
        }
        const restoredDuration = Math.max(0, Math.min(300, Number(draft.speechDuration) || 0));
        const restoredAnalysis = draft.analysis && Array.isArray(draft.analysis.assets) ? draft.analysis : null;
        const restoredStoryboard = draft.storyboard && Array.isArray(draft.storyboard.shots) && draft.storyboard.shots.length ? draft.storyboard : null;
        const restoredProduction = draft.productionShots && typeof draft.productionShots === "object"
          ? Object.fromEntries(Object.entries(draft.productionShots).map(([shotId, shot]) => {
            const safe = shot && typeof shot === "object" ? shot : null;
            if (!safe) return [shotId, null];
            const needsRetry = safe.state === "submitting" && !safe.taskId;
            return [shotId, needsRetry ? { ...safe, state: "failed" as const, error: "页面刷新时任务尚未完成提交，请重试这个镜头。" } : safe];
          }).filter((entry): entry is [string, ProductionShot] => Boolean(entry[1])))
          : {};

        setSourceMode(draft.sourceMode === "reference" ? "reference" : "original");
        setIndustry(INDUSTRIES.includes(draft.industry) ? draft.industry : "本地生活");
        setPlatform(PLATFORMS.includes(draft.platform) ? draft.platform : "抖音");
        setGoal(GOALS.includes(draft.goal) ? draft.goal : "获客转化");
        setAudience(typeof draft.audience === "string" ? draft.audience : "");
        setBrief(typeof draft.brief === "string" ? draft.brief : "突出真实体验与核心价值，内容自然可信，不夸大效果。 ");
        setReferenceUrl(typeof draft.referenceUrl === "string" ? draft.referenceUrl : "");
        setReferenceTitle(typeof draft.referenceTitle === "string" ? draft.referenceTitle : "");
        setReferenceTranscript(typeof draft.referenceTranscript === "string" ? draft.referenceTranscript : "");
        setScript(typeof draft.script === "string" ? draft.script : "");
        setVoiceId(typeof draft.voiceId === "string" ? draft.voiceId : "");
        setSpeechSpeed(SPEEDS.includes(Number(draft.speechSpeed)) ? Number(draft.speechSpeed) : 1);
        setSpeechSource(draft.speechSource === "upload" ? "upload" : "generate");
        setSpeechFile(restoredSpeechFile);
        setSpeechUrl(restoredSpeechUrl);
        setSpeechDuration(restoredDuration);
        setSpeechLocked(Boolean(draft.speechLocked && restoredSpeechUrl && restoredDuration));
        setAssets(restoredAssets);
        setAnalysis(restoredAnalysis);
        restoringDraft.current = Boolean(restoredStoryboard);
        setStoryboard(restoredStoryboard);
        productionShotsRef.current = restoredProduction;
        setProductionShots(restoredProduction);
        setMpsJobId(typeof draft.mpsJobId === "string" ? draft.mpsJobId : "");
        const recoveryDetail = draft.hadFinal
          ? "上次成片和编辑步骤已恢复。"
          : draft.hadPreview
            ? "素材、口播和后台任务已恢复，可以继续生成成片。"
            : `已恢复到第 ${restoredStoryboard ? 3 : restoredAssets.length ? 2 : 1} 步。`;
        setDraftRecoveryNote(recoveryDetail);
        setDraftState({ kind: "saved", text: `已恢复 ${savedTime(record.updatedAt)}` });
      })
      .catch((cause) => {
        if (!active) return;
        setDraftState({ kind: "error", text: cause instanceof Error ? cause.message : "草稿无法读取" });
      })
      .finally(() => {
        if (active) setDraftReady(true);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!draftReady) return;
    setDraftState({ kind: "saving", text: "正在自动保存" });
    const timer = window.setTimeout(() => {
      const payload: DirectorDraftPayload = {
        sourceMode,
        industry,
        platform,
        goal,
        audience,
        brief,
        referenceUrl,
        referenceTitle,
        referenceTranscript,
        script,
        voiceId,
        speechSpeed,
        speechUrl: speechSource === "generate" ? speechUrl : "",
        speechDuration,
        speechLocked,
        speechSource,
        speechFile: speechSource === "upload" ? speechFile : null,
        assets: assets.map((asset) => ({
          id: asset.id,
          name: asset.name,
          kind: asset.kind,
          file: asset.file,
          duration: asset.duration,
          frames: asset.frames,
          frameLabels: asset.frameLabels,
          state: asset.state,
          error: asset.error,
        })),
        analysis,
        storyboard,
        productionShots,
        mpsJobId,
        hadPreview: Boolean(previewUrl),
        hadFinal: Boolean(finalUrl),
      };
      void saveAiDirectorDraft(payload)
        .then((updatedAt) => setDraftState({ kind: "saved", text: `已自动保存 ${savedTime(updatedAt)}` }))
        .catch((cause) => {
          const message = cause instanceof DOMException && cause.name === "QuotaExceededError"
            ? "素材较大，浏览器草稿空间不足"
            : cause instanceof Error ? cause.message : "草稿保存失败";
          setDraftState({ kind: "error", text: message });
        });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [analysis, assets, audience, brief, draftReady, finalUrl, goal, industry, mpsJobId, platform, previewUrl, productionShots, referenceTitle, referenceTranscript, referenceUrl, script, sourceMode, speechDuration, speechFile, speechLocked, speechSource, speechSpeed, speechUrl, storyboard, voiceId]);

  const readyAssets = useMemo(() => assets.filter((asset) => asset.state === "ready"), [assets]);
  const readyAssetFingerprint = useMemo(() => readyAssets.map((asset) => `${asset.id}:${asset.file.size}:${asset.frames.length}`).join("|"), [readyAssets]);
  const currentStep = finalUrl || directorBusy === "produce" || storyboard ? 3 : readyAssets.length ? 2 : 1;
  const projectReady = Boolean(industry && platform && goal && audience.trim() && brief.trim());

  useEffect(() => {
    if (!draftReady || !readyAssets.length || assets.some((asset) => asset.state === "reading") || analysis || directorBusy || analysisFingerprint.current === readyAssetFingerprint) return;
    analysisFingerprint.current = readyAssetFingerprint;
    const timer = window.setTimeout(() => {
      setDirectorBusy("analyze");
      setProductionMessage("正在自动理解素材");
      void requestMaterialAnalysis()
        .then((result) => {
          setAnalysis(result);
          setProductionMessage("素材已理解，确认口播后即可自动成片");
        })
        .catch((cause) => {
          setError(cause instanceof Error ? cause.message : "素材理解没有完成。");
          setProductionMessage("素材理解暂停，可在生成时重试");
        })
        .finally(() => setDirectorBusy(""));
    }, 700);
    return () => window.clearTimeout(timer);
    // 素材指纹是唯一触发源；函数读取这一轮已经稳定的素材快照。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, assets, directorBusy, draftReady, readyAssetFingerprint, readyAssets.length]);

  useEffect(() => {
    if (!draftReady || !mpsConfigured || !mpsJobId || finalUrl || directorBusy || resumingMps.current) return;
    resumingMps.current = true;
    setDirectorBusy("produce");
    setProductionMessage("正在恢复成片任务");
    void waitForMps(mpsJobId)
      .then((mediaUrl) => {
        setFinalUrl(mediaUrl);
        setDirectorProgress(100);
        setProductionMessage("成片已完成");
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "成片任务恢复失败。"))
      .finally(() => {
        resumingMps.current = false;
        setDirectorBusy("");
      });
  }, [directorBusy, draftReady, finalUrl, mpsConfigured, mpsJobId]);

  useEffect(() => {
    const isRestoring = restoringDraft.current;
    restoringDraft.current = false;
    if (!isRestoring && !automaticProductionRunning.current) {
      setProductionShots({});
      productionShotsRef.current = {};
      setProductionMessage("");
      setFinalUrl("");
      if (finalObjectUrl.current) {
        URL.revokeObjectURL(finalObjectUrl.current);
        finalObjectUrl.current = "";
      }
    }
  }, [storyboard]);

  function invalidateAfterScript() {
    setSpeechLocked(false);
    setSpeechDuration(0);
    setSpeechUrl("");
    setSpeechFile(null);
    setStoryboard(null);
    setPreviewUrl("");
  }

  async function extractReference() {
    if (!referenceUrl.trim() || referenceBusy) return setError("请先粘贴公开短视频链接。");
    setReferenceBusy(true);
    setReferenceProgress(1);
    setReferenceTranscript("");
    setError("");
    try {
      const response = await fetch("/api/ai/douyin-transcript", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shareUrl: referenceUrl.trim() }),
      });
      let job = await response.json() as WorkerJob;
      if (!response.ok || !job.id) throw new Error(job.error || "参考视频读取失败。");
      const jobId = job.id;
      const deadline = Date.now() + 10 * 60 * 1000;
      while (job.state !== "success" && job.state !== "failed") {
        if (Date.now() > deadline) throw new Error("读取时间较长，任务仍可能在后台继续。");
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        const status = await fetch(`/api/ai/douyin-transcript?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store" });
        job = await status.json() as WorkerJob;
        if (!status.ok) throw new Error(job.error || "读取参考视频进度失败。");
        setReferenceProgress(Math.max(1, Math.min(100, Number(job.progress) || 1)));
      }
      if (job.state === "failed") throw new Error(job.error || "参考视频读取失败。");
      const transcript = (job.transcript || "").trim() || (job.captions || []).map((item) => item.text?.trim()).filter(Boolean).join("，");
      if (transcript.length < 10) throw new Error("没有读取到清晰口播，请更换有人声的公开视频。");
      setReferenceTranscript(transcript);
      setReferenceTitle((job.benchmark_title || job.title || "参考视频").trim());
      setReferenceProgress(100);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "参考视频读取失败。");
      setReferenceProgress(0);
    } finally {
      setReferenceBusy(false);
    }
  }

  async function createScript() {
    if (!projectReady || scriptBusy) return setError("请先完整填写行业、受众和本次视频要求。");
    if (sourceMode === "reference" && referenceTranscript.length < 10) return setError("请先读取参考视频文案。");
    setScriptBusy(true);
    setError("");
    try {
      const response = await fetch("/api/ai/speech-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sourceMode === "reference" ? {
          mode: "benchmark",
          sourceScript: referenceTranscript,
          businessProfile: `行业：${industry}\n平台：${platform}\n目标：${goal}\n受众：${audience}\n真实资料与要求：${brief}`,
          requestId: requestId("director_benchmark"),
        } : {
          requirement: `请为以下项目写口播。行业：${industry}；平台：${platform}；目标：${goal}；受众：${audience}；真实资料与要求：${brief}`,
          requestId: requestId("director_script"),
        }),
      });
      const data = await response.json() as { error?: string; script?: string; wallet?: { points?: number } };
      if (!response.ok || !data.script?.trim()) throw new Error(data.error || "口播文案生成失败。");
      invalidateAfterScript();
      setScript(data.script.trim());
      if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "口播文案生成失败。");
    } finally {
      setScriptBusy(false);
    }
  }

  async function generateSpeech() {
    if (!voiceId || script.trim().length < 10 || speechBusy) return setError(voiceId ? "请先确认完整口播文案。" : "当前账号还没有可用声音，请先到对口型视频克隆声音。 ");
    setSpeechBusy(true);
    setSpeechLocked(false);
    setSpeechDuration(0);
    setSpeechUrl("");
    setError("");
    try {
      const voice = voices.find((item) => item.voiceId === voiceId);
      const response = await fetch("/api/ai/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voiceId, text: script.trim(), speed: speechSpeed, requestId: requestId("director_speech") }),
      });
      let data = await response.json() as { error?: string; taskId?: string; requestId?: string; state?: string; isFinal?: boolean; audioUrl?: string; duration?: number; estimatedPoints?: number; wallet?: { points?: number } };
      if (!response.ok) throw new Error(data.error || "口播音频生成失败。");
      if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);
      for (let attempt = 0; !data.isFinal && data.taskId && attempt < 120; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 3000));
        const params = new URLSearchParams({
          task_id: data.taskId,
          request_id: data.requestId || "",
          project_name: "AI导演成片",
          voice_name: voice?.name || "克隆声音",
          estimated_points: String(data.estimatedPoints || 1),
        });
        const status = await fetch(`/api/ai/speech?${params}`, { cache: "no-store" });
        data = await status.json() as typeof data;
        if (!status.ok) throw new Error(data.error || "口播音频状态读取失败。");
        if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);
      }
      if (!data.isFinal || data.state === "failed" || !data.audioUrl) throw new Error(data.error || "口播音频没有生成成功。");
      if (Number(data.duration) > 300) throw new Error("单条口播最长支持5分钟，请缩短文案或拆分为两条视频。");
      setSpeechUrl(data.audioUrl);
      setSpeechDuration(Math.max(0, Number(data.duration) || 0));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "口播音频生成失败。");
    } finally {
      setSpeechBusy(false);
    }
  }

  function uploadSpeech(file: File | null) {
    if (speechUploadUrl.current) URL.revokeObjectURL(speechUploadUrl.current);
    speechUploadUrl.current = "";
    setSpeechFile(file);
    setSpeechDuration(0);
    setSpeechLocked(false);
    setAnalysis(null);
    setStoryboard(null);
    setPreviewUrl("");
    if (!file) return setSpeechUrl("");
    const url = URL.createObjectURL(file);
    speechUploadUrl.current = url;
    setSpeechUrl(url);
  }

  async function addAssets(files: FileList | null) {
    if (!files?.length) return;
    const available = Math.max(0, 12 - assets.length);
    const selected = Array.from(files).filter((file) => file.type.startsWith("image/") || file.type.startsWith("video/")).slice(0, available);
    if (!selected.length) return setError(available ? "请选择图片或视频文件。" : "单个项目最多添加12项素材。");
    setError("");
    setAnalysis(null);
    setStoryboard(null);
    setPreviewUrl("");
    const items = selected.map((file) => {
      const previewUrl = URL.createObjectURL(file);
      assetUrls.current.push(previewUrl);
      return {
        id: `asset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        kind: file.type.startsWith("video/") ? "video" as const : "image" as const,
        file,
        previewUrl,
        duration: 0,
        frames: [],
        frameLabels: [],
        state: "reading" as const,
      };
    });
    setAssets((current) => [...current, ...items]);
    for (const item of items) {
      try {
        const result = item.kind === "image"
          ? { duration: 0, frames: [await readImageFrame(item.previewUrl)] }
          : await readVideoFrames(item.previewUrl);
        setAssets((current) => current.map((asset) => asset.id === item.id ? {
          ...asset,
          duration: result.duration,
          frames: result.frames,
          frameLabels: result.frames.map((_, index) => `${item.id} / ${item.kind === "image" ? "图片原图" : `关键帧${index + 1}`}`),
          state: "ready",
        } : asset));
      } catch (cause) {
        setAssets((current) => current.map((asset) => asset.id === item.id ? { ...asset, state: "failed", error: cause instanceof Error ? cause.message : "素材读取失败" } : asset));
      }
    }
  }

  function removeAsset(id: string) {
    const item = assets.find((asset) => asset.id === id);
    if (item) URL.revokeObjectURL(item.previewUrl);
    setAssets((current) => current.filter((asset) => asset.id !== id));
    setAnalysis(null);
    setStoryboard(null);
    setPreviewUrl("");
  }

  function directorPayload(stage: "analyze" | "storyboard", materialAnalysis: MaterialAnalysis | null = analysis) {
    return {
      stage,
      industry,
      platform,
      goal,
      audience,
      brief,
      script,
      speechDuration,
      referenceTitle,
      referenceTranscript,
      assets: readyAssets.map((asset) => ({ id: asset.id, name: asset.name, kind: asset.kind, duration: asset.duration, frameLabels: asset.frameLabels })),
      referenceImages: readyAssets.flatMap((asset) => asset.frames).slice(0, 18),
      materialAnalysis,
      requestId: requestId(`director_${stage}`),
    };
  }

  async function requestMaterialAnalysis() {
    const response = await fetch("/api/ai/director", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(directorPayload("analyze", null)) });
    const data = await response.json() as MaterialAnalysis & { error?: string; wallet?: { points?: number } };
    if (!response.ok || !Array.isArray(data.assets)) throw new Error(data.error || "素材理解没有完成。");
    if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);
    return {
      contentSummary: data.contentSummary || "素材已完成理解。",
      coverage: data.coverage || "",
      gaps: Array.isArray(data.gaps) ? data.gaps : [],
      assets: data.assets,
    } satisfies MaterialAnalysis;
  }

  async function requestStoryboard(materialAnalysis: MaterialAnalysis) {
    const response = await fetch("/api/ai/director", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(directorPayload("storyboard", materialAnalysis)) });
    const data = await response.json() as Storyboard & { error?: string; wallet?: { points?: number } };
    if (!response.ok || !Array.isArray(data.shots) || !data.shots.length) throw new Error(data.error || "分镜规划没有完成。");
    if (data.qualityGate?.passed === false) throw new Error(`分镜质量未达标：${data.qualityGate.warnings?.join("；") || "请重新生成"}。`);
    if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);
    return data;
  }

  function showProductionShot(next: ProductionShot) {
    productionShotsRef.current = { ...productionShotsRef.current, [next.shotId]: next };
    setProductionShots((current) => ({ ...current, [next.shotId]: next }));
  }

  async function generateSeedanceShot(
    shot: DirectorShot,
    index: number,
    existing?: ProductionShot,
    activeStoryboard: Storyboard | null = storyboard,
    onProgress?: (progress: number) => void,
  ) {
    const asset = readyAssets.find((item) => item.id === shot.assetId);
    const referenceFrame = asset?.frames[Math.max(0, Math.min((asset?.frames.length || 1) - 1, Math.round(shot.referenceFrame || 0)))];
    if (!asset || !referenceFrame) throw new Error(`镜头 ${index + 1} 没有可用的视觉参考帧。`);
    const shotLength = shot.end - shot.start;
    if (shotLength > 15) throw new Error(`镜头 ${index + 1} 长度为 ${shotLength.toFixed(1)} 秒，超过 Seedance 2.0 单镜头 15 秒上限。请重新导演，或为该镜头改用视频素材。`);

    let data: SeedanceTask | null = null;
    const needsFreshRequest = existing?.state === "failed" && !existing.taskId;
    let activeRequestId = needsFreshRequest
      ? requestId(`director_seedance_${index + 1}`)
      : existing?.requestId || requestId(`director_seedance_${index + 1}`);
    let taskId = existing?.taskId || "";

    if (taskId && existing?.requestId) {
      const statusResponse = await fetch(`/api/ai/videos?task_id=${encodeURIComponent(taskId)}&request_id=${encodeURIComponent(existing.requestId)}`, { cache: "no-store" });
      const statusData = await statusResponse.json() as SeedanceTask;
      if (statusResponse.ok && statusData.state !== "failed") data = statusData;
      if (!statusResponse.ok || statusData.state === "failed") {
        taskId = "";
        activeRequestId = requestId(`director_seedance_${index + 1}`);
      }
    }

    if (!data) {
      showProductionShot({ shotId: shot.id, state: "submitting", progress: 1, requestId: activeRequestId, taskId: "", mediaUrl: "", error: "" });
      const response = await fetch("/api/ai/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: seedancePrompt(shot, activeStoryboard?.projectTitle || "AI导演成片"),
          images: [referenceFrame],
          duration: seedanceDuration(shot),
          resolution: "720p",
          version: "快速",
          projectName: `${activeStoryboard?.projectTitle || "AI导演成片"} · 镜头${index + 1}`,
          requestId: activeRequestId,
        }),
      });
      data = await response.json() as SeedanceTask;
      if (!response.ok) throw new Error(data.error || `镜头 ${index + 1} 无法提交到 Seedance。`);
      taskId = data.taskId || "";
      activeRequestId = data.requestId || activeRequestId;
      if (typeof data.wallet?.points === "number") onPointsChange(data.wallet.points);
    }

    if (!data) throw new Error(`镜头 ${index + 1} 没有获得 Seedance 任务信息。`);
    let currentData: SeedanceTask = data;
    const pollingState = () => ({
      shotId: shot.id,
      state: "generating" as const,
      progress: Math.max(2, Math.min(99, Number.parseInt(currentData.progress || "", 10) || 2)),
      requestId: activeRequestId,
      taskId,
      mediaUrl: "",
      error: "",
    });
    showProductionShot(pollingState());
    onProgress?.(pollingState().progress);
    for (let attempt = 0; !currentData.isFinal && taskId && attempt < 120; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 5000));
      const statusResponse = await fetch(`/api/ai/videos?task_id=${encodeURIComponent(taskId)}&request_id=${encodeURIComponent(activeRequestId)}`, { cache: "no-store" });
      currentData = await statusResponse.json() as SeedanceTask;
      if (!statusResponse.ok) throw new Error(currentData.error || `镜头 ${index + 1} 的生成进度读取失败。`);
      if (typeof currentData.wallet?.points === "number") onPointsChange(currentData.wallet.points);
      showProductionShot(pollingState());
      onProgress?.(pollingState().progress);
    }
    if (!currentData.isFinal) throw new Error(`镜头 ${index + 1} 仍在平台生成中，稍后点击重试会继续查询原任务，不会重复扣费。`);
    if (currentData.state !== "success" || !currentData.resultUrl) throw new Error(currentData.error || `镜头 ${index + 1} 生成失败，本次积分会自动退回。`);

    const completed: ProductionShot = {
      shotId: shot.id,
      state: "ready",
      progress: 100,
      requestId: activeRequestId,
      taskId,
      mediaUrl: `/api/ai/videos?media=1&request_id=${encodeURIComponent(activeRequestId)}`,
      error: "",
    };
    showProductionShot(completed);
    return completed;
  }

  async function waitForMps(jobId: string) {
    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 3000));
      const response = await fetch(`/api/ai/director/mps?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store" });
      const task = await response.json() as MpsTask;
      if (!response.ok) throw new Error(task.error || "成片状态读取失败。");
      setDirectorProgress(Math.max(88, Math.min(100, Number(task.progress) || 90)));
      if (task.state === "failed") throw new Error(task.error || "成片合成失败。");
      if (task.state === "success" && task.mediaUrl) return task.mediaUrl;
    }
    throw new Error("成片仍在后台合成，任务已经保存，稍后重新进入可继续查看。");
  }

  async function assembleFinalVideo(completed: Record<string, ProductionShot>, activeStoryboard: Storyboard | null = storyboard) {
    if (!activeStoryboard || !speechUrl) throw new Error("云端合成所需的口播或分镜已经失效。");
    if (!mpsConfigured) throw new Error(`云端成片服务尚未配置${mpsMissing.length ? `：${mpsMissing.join("、")}` : ""}。`);
    setProductionMessage("正在上传镜头并准备合成");
    setDirectorProgress(86);
    const form = new FormData();
    const sources: Array<{ id: string; field: string; name: string; contentType: string }> = [];
    const sourceByKey = new Map<string, string>();

    for (let index = 0; index < activeStoryboard.shots.length; index += 1) {
      const shot = activeStoryboard.shots[index];
      const asset = readyAssets.find((item) => item.id === shot.assetId);
      if (!asset) throw new Error(`镜头 ${index + 1} 的素材已失效。`);
      const usesSourceVideo = shot.renderMode === "source-video" && asset.kind === "video";
      const sourceKey = usesSourceVideo ? `asset:${asset.id}` : `generated:${shot.id}`;
      if (sourceByKey.has(sourceKey)) continue;
      const field = `media_${sources.length}`;
      const sourceId = `source_${sources.length}`;
      let file: File;
      if (usesSourceVideo) {
        file = asset.file;
      } else {
        const generated = completed[shot.id];
        if (generated?.state !== "ready" || !generated.mediaUrl) throw new Error(`镜头 ${index + 1} 还没有完成动态素材生成。`);
        const response = await fetch(generated.mediaUrl, { cache: "no-store" });
        if (!response.ok) throw new Error(`镜头 ${index + 1} 的动态素材无法读取。`);
        file = new File([await response.blob()], `generated-${index + 1}.mp4`, { type: "video/mp4" });
      }
      form.set(field, file);
      sources.push({ id: sourceId, field, name: file.name, contentType: file.type || "video/mp4" });
      sourceByKey.set(sourceKey, sourceId);
    }

    const speechResponse = await fetch(speechUrl, { cache: "no-store" });
    if (!speechResponse.ok) throw new Error("口播音频无法读取。");
    const speechBlob = await speechResponse.blob();
    form.set("speech", speechFile || new File([speechBlob], "speech.mp3", { type: speechBlob.type || "audio/mpeg" }));
    form.set("manifest", JSON.stringify({
      title: activeStoryboard.projectTitle || "AI成片",
      duration: activeStoryboard.duration,
      sources,
      shots: activeStoryboard.shots.map((shot) => {
        const asset = readyAssets.find((item) => item.id === shot.assetId);
        const usesSourceVideo = shot.renderMode === "source-video" && asset?.kind === "video";
        const sourceId = sourceByKey.get(usesSourceVideo ? `asset:${asset?.id}` : `generated:${shot.id}`) || "";
        const duration = Math.max(.2, shot.end - shot.start);
        return { id: shot.id, sourceId, duration, sourceIn: usesSourceVideo ? Math.max(0, shot.sourceIn) : 0, sourceOut: usesSourceVideo ? Math.max(shot.sourceIn + .2, shot.sourceOut) : duration };
      }),
    }));
    const response = await fetch("/api/ai/director/mps", { method: "POST", body: form });
    const task = await response.json() as MpsTask;
    if (!response.ok || !task.jobId) throw new Error(task.error || "成片任务提交失败。");
    setMpsJobId(task.jobId);
    setProductionMessage("正在合成完整视频");
    const mediaUrl = await waitForMps(task.jobId);
    setFinalUrl(mediaUrl);
    setDirectorProgress(100);
    setProductionMessage("成片已完成");
    window.dispatchEvent(new CustomEvent("member-assets-updated"));
  }

  async function generateAutomaticVideo() {
    if (directorBusy) return;
    if (!speechLocked || !speechDuration || !speechUrl) return setError("请先生成口播并锁定真实时长。");
    if (!readyAssets.length || assets.some((asset) => asset.state === "reading")) return setError("请等待素材读取完成，并至少保留一项可用素材。");

    setDirectorBusy("produce");
    automaticProductionRunning.current = true;
    setDirectorProgress(2);
    setProductionMessage("正在理解图片与视频素材");
    setError("");
    try {
      let materialAnalysis = analysis;
      if (!materialAnalysis) {
        materialAnalysis = await requestMaterialAnalysis();
        setAnalysis(materialAnalysis);
      }
      setDirectorProgress(9);
      setProductionMessage("AI 导演正在规划口播对应镜头");

      let activeStoryboard = storyboard;
      if (!activeStoryboard) {
        activeStoryboard = await requestStoryboard(materialAnalysis);
        setStoryboard(activeStoryboard);
      }
      setDirectorProgress(16);

      const completed = { ...productionShotsRef.current };
      const generatedShots = activeStoryboard.shots
        .map((shot, index) => ({ shot, index }))
        .filter(({ shot }) => shot.renderMode !== "source-video");
      const shotProgress = new Map(generatedShots.map(({ shot }) => [shot.id, completed[shot.id]?.state === "ready" ? 100 : 0]));
      await runLimited(generatedShots, 3, async ({ shot, index }, position) => {
        if (completed[shot.id]?.state === "ready") return;
        setProductionMessage(`正在并行生成动态镜头（最多 3 个同时处理）`);
        completed[shot.id] = await generateSeedanceShot(shot, index, completed[shot.id], activeStoryboard, (progress) => {
          shotProgress.set(shot.id, progress);
          const total = [...shotProgress.values()].reduce((sum, value) => sum + value, 0);
          const overall = 16 + (total / Math.max(1, generatedShots.length) / 100) * 68;
          setDirectorProgress(Math.max(16, Math.min(84, Math.round(overall))));
          setProductionMessage(`正在并行生成动态镜头 ${Math.min(generatedShots.length, position + 1)}/${generatedShots.length}`);
        });
        shotProgress.set(shot.id, 100);
      });
      setDirectorProgress(86);
      await assembleFinalVideo(completed, activeStoryboard);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "完整视频生成没有完成。");
      setProductionMessage("生成已暂停，请处理提示后继续");
    } finally {
      automaticProductionRunning.current = false;
      setDirectorBusy("");
    }
  }

  return <section className="video-workspace ai-director-workspace">
    <header className="video-workspace-head ai-director-head">
      <button type="button" onClick={onBack}><ArrowLeft size={16} />返回短视频</button>
      <div><h1>AI成片</h1></div>
      <aside className="director-draft-meta" aria-live="polite"><span>{finalUrl ? "成片已完成" : directorBusy === "produce" ? "正在后台生成" : `进行到第 ${currentStep} 步`}</span><span className={draftState.kind}><FloppyDisk size={14} />{draftState.text}</span></aside>
    </header>

    <nav className="director-steps is-three" aria-label="AI成片制作进度">
      {["上传并理解素材", "确认内容与口播", "生成成片"].map((label, index) => {
        const step = index + 1;
        const complete = step < currentStep || Boolean(finalUrl);
        const active = step === currentStep && !finalUrl;
        return <span className={complete ? "complete" : active ? "active" : ""} aria-current={active ? "step" : undefined} key={label}><i>{complete ? <Check size={14} weight="bold" /> : step}</i><b>{label}</b></span>;
      })}
    </nav>
    {draftRecoveryNote ? <div className="director-draft-recovery" role="status"><Check size={16} weight="bold" /><span><b>上次草稿已恢复</b><small>{draftRecoveryNote}</small></span><button type="button" onClick={() => setDraftRecoveryNote("")} aria-label="关闭草稿恢复提示"><X size={14} /></button></div> : null}

    <div className="director-layout is-streamlined"><div className="director-main">
      <section className={`director-card ${currentStep === 1 ? "is-current" : ""}`}>
        <header><i>01</i><div><h2>先添加真实图片与视频素材</h2><p>上传后自动读取主体、场景和可用视频片段</p></div><em>{directorBusy === "analyze" ? "AI 正在理解" : analysis ? <><Check size={14} />已理解 {readyAssets.length} 项</> : `${readyAssets.length} 项可用`}</em></header>
        <label className="director-material-drop"><input type="file" accept="image/*,video/*" multiple onChange={(event) => void addAssets(event.target.files)} /><UploadSimple size={24} /><span><b>添加图片或视频</b><small>最多 12 项；上传完成后自动分析，不再显示冗长思考过程</small></span></label>
        {assets.length ? <div className="director-assets">{assets.map((asset) => <article className={asset.state} key={asset.id}>
          <div>{asset.kind === "image" ? <img src={asset.previewUrl} alt={asset.name} /> : <video src={asset.previewUrl} muted playsInline preload="metadata" />}</div>
          <button type="button" aria-label={`移除${asset.name}`} onClick={() => removeAsset(asset.id)}><X size={13} /></button>
          <span>{asset.kind === "image" ? <ImageIcon size={13} /> : <VideoCamera size={13} />}<b>{asset.name}</b></span>
          <small>{asset.state === "reading" ? "正在读取画面…" : asset.state === "failed" ? asset.error : asset.kind === "video" ? `${asset.duration.toFixed(1)} 秒 · 已读取关键帧` : "原图已读取"}</small>
        </article>)}</div> : null}
      </section>

      <section className={`director-card ${currentStep === 2 ? "is-current" : ""}`}>
        <header><i>02</i><div><h2>确认内容与口播</h2><p>先确认说什么，再用真实音频时长锁定全部镜头</p></div>{speechLocked ? <em><Check size={14} />已锁定 {speechDuration.toFixed(1)} 秒</em> : null}</header>
        <div className="director-choice" role="group" aria-label="内容来源">
          <button type="button" className={sourceMode === "original" ? "active" : ""} onClick={() => setSourceMode("original")}><MagicWand size={19} /><span><b>自主策划</b><small>根据行业和真实资料写口播</small></span></button>
          <button type="button" className={sourceMode === "reference" ? "active" : ""} onClick={() => setSourceMode("reference")}><LinkSimple size={19} /><span><b>参考短视频</b><small>读取文案后重新创作</small></span></button>
        </div>
        {sourceMode === "reference" ? <div className="director-reference"><label><span>公开短视频链接</span><div><input value={referenceUrl} onChange={(event) => setReferenceUrl(event.target.value)} placeholder="粘贴抖音公开分享链接" /><button type="button" disabled={referenceBusy} onClick={() => void extractReference()}>{referenceBusy ? `读取中 ${referenceProgress}%` : "读取文案"}</button></div></label>{referenceTranscript ? <article><b>{referenceTitle || "参考视频文案"}</b><p>{referenceTranscript}</p></article> : null}</div> : null}
        <div className="director-fields is-three">
          <label><span>行业</span><select value={industry} onChange={(event) => setIndustry(event.target.value)}>{INDUSTRIES.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label><span>发布平台</span><select value={platform} onChange={(event) => setPlatform(event.target.value)}>{PLATFORMS.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label><span>视频目标</span><select value={goal} onChange={(event) => setGoal(event.target.value)}>{GOALS.map((item) => <option key={item}>{item}</option>)}</select></label>
        </div>
        <div className="director-fields"><label><span>目标受众</span><input value={audience} onChange={(event) => setAudience(event.target.value)} placeholder="例如：准备提升门店业绩的本地商家" /></label><label><span>真实资料与内容要求</span><textarea value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="写清产品、服务、人物、优势和不能虚构的内容" /></label></div>
        <button type="button" className="director-primary" disabled={scriptBusy || !projectReady || (sourceMode === "reference" && !referenceTranscript)} onClick={() => void createScript()}>{scriptBusy ? "正在规划口播…" : script ? "重新规划口播" : "AI 规划口播"}</button>
        {script || scriptBusy ? <div className="director-script"><label><span><b>口播文本</b><small>{script.trim().length} 字 · 可直接修改</small></span><textarea value={script} onChange={(event) => { setScript(event.target.value); invalidateAfterScript(); }} placeholder="AI 生成后在这里确认最终口播" /></label></div> : null}
        <div className="director-speech-block">
          <div className="director-tabs"><button type="button" className={speechSource === "generate" ? "active" : ""} onClick={() => setSpeechSource("generate")}>使用克隆声音</button><button type="button" className={speechSource === "upload" ? "active" : ""} onClick={() => setSpeechSource("upload")}>上传已有口播</button></div>
          {speechSource === "generate" ? <div className="director-voice-row"><label><span>声音</span><select value={voiceId} onChange={(event) => setVoiceId(event.target.value)}><option value="">{voices.length ? "选择声音" : "暂无克隆声音"}</option>{voices.map((voice) => <option value={voice.voiceId} key={voice.voiceId}>{voice.name}</option>)}</select></label><label><span>语速</span><select value={speechSpeed} onChange={(event) => setSpeechSpeed(Number(event.target.value))}>{SPEEDS.map((speed) => <option value={speed} key={speed}>{speed === 1 ? "正常" : `${speed}×`}</option>)}</select></label><button type="button" disabled={speechBusy || !voiceId || script.trim().length < 10} onClick={() => void generateSpeech()}><Microphone size={18} />{speechBusy ? "生成中…" : "生成口播音频"}</button></div> : <label className="director-audio-drop"><input type="file" accept="audio/*" onChange={(event) => uploadSpeech(event.target.files?.[0] || null)} /><UploadSimple size={20} /><span><b>{speechFile?.name || "上传已录好的口播音频"}</b><small>MP3、WAV、M4A</small></span></label>}
          {speechUrl ? <div className={`director-audio ${speechLocked ? "is-locked" : "needs-lock"}`}><Waveform size={22} /><audio src={speechUrl} controls preload="metadata" onLoadedMetadata={(event) => { const measured = Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0; if (measured > 300) { setSpeechDuration(0); setSpeechLocked(false); setError("单条口播最长支持5分钟，请缩短文案或拆分为两条视频。"); return; } setSpeechDuration(measured); }} /><b>{speechDuration ? `${speechDuration.toFixed(1)} 秒` : "读取时长中"}</b><button type="button" className={speechLocked ? "is-locked" : "needs-lock"} aria-pressed={speechLocked} disabled={!speechDuration || speechBusy} onClick={() => { setSpeechLocked(true); setStoryboard(null); setPreviewUrl(""); }}><Check size={16} weight="bold" />{speechLocked ? "已锁定时间轴" : "请锁定时间轴"}</button></div> : null}
        </div>
      </section>

      <section className={`director-card ${currentStep === 3 ? "is-current" : ""}`}>
        <header><i>03</i><div><h2>AI成片</h2></div>{finalUrl ? <em><Check size={14} />已完成</em> : null}</header>
        <div className="director-auto-production">
          {(directorBusy === "produce" || finalUrl || productionMessage) ? <div className={`director-production-progress ${finalUrl ? "is-complete" : ""}`} role="status" aria-live="polite"><span style={{ width: `${finalUrl ? 100 : Math.max(2, directorProgress)}%` }} /><b>{finalUrl ? "成片已生成" : `${productionMessage || "正在准备生成"} · ${directorProgress}%`}</b></div> : null}
          <button type="button" className="director-primary director-final-action" disabled={!speechLocked || !readyAssets.length || assets.some((asset) => asset.state === "reading") || directorBusy !== "" || mpsConfigured !== true} onClick={() => void generateAutomaticVideo()}>{directorBusy === "produce" ? "正在生成成片" : finalUrl ? "重生成片" : "生成成片"}</button>
          {finalUrl ? <div className="director-preview director-final-result"><video src={finalUrl} controls playsInline preload="metadata" /><div><b>成片已完成</b><div className="director-result-actions"><a href={finalUrl} download={`${storyboard?.projectTitle || "AI成片"}.mp4`}>下载成片</a><button type="button" onClick={() => onOpenViralEditor({ name: `${storyboard?.projectTitle || "AI成片"}.mp4`, mediaUrl: finalUrl })}>进入一键网感包装</button></div></div></div> : null}
        </div>
      </section>
      {error ? <div className="director-error" role="alert" aria-live="assertive"><b>操作未完成</b><span>{error}</span><button type="button" aria-label="关闭错误提示" onClick={() => setError("")}><X size={15} /></button></div> : null}
    </div></div>
  </section>;
}
