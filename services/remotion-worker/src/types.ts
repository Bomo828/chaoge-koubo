export type CaptionWord = {
  text: string;
  start: number;
  end: number;
  highlight?: boolean;
};

export type CaptionCue = {
  start: number;
  end: number;
  displayEnd?: number;
  text: string;
  captionLineMode?: "single" | "two-line";
  captionLines?: string[];
  translation?: string;
  words?: CaptionWord[];
  keyword?: string;
  keywordLocked?: boolean;
  keywordCategory?: string;
  keywordConfidence?: number;
  keywordSfx?: boolean;
  keywordImportance?: "primary" | "regular";
  cameraIntent?: "hold" | "push-in" | "pull-back" | "reframe" | "close-up" | "wide";
  transitionIntent?: "none" | "cut" | "matched-reframe" | "focus-bridge" | "foreground-occlusion";
  sfxRole?: "none" | "hook" | "reversal" | "viewpoint" | "number" | "step" | "brand" | "cta";
  contentNode?: "hook" | "pain_reversal" | "core_viewpoint" | "number_benefit" | "example_step" | "brand_entity" | "cta" | "supporting";
  effectLevel?: "normal" | "subtle";
  stepNumber?: number;
  semanticRole?: "steady" | "hook" | "keyword" | "number" | "reversal" | "step" | "conclusion" | "cta" | "warning" | "example" | "brand";
  materialRoute?: {
    caption?: string;
    camera?: string;
    sfx?: string;
    transition?: string;
  };
  captionStyle?: string;
  role?: "anchor" | "focus";
  sectionEmphasis?: boolean;
  layout?: "center" | "split" | "stack-left" | "stack-right" | "impact";
  blockId?: number;
  blockSlot?: number;
  blockSize?: number;
  emphasis?: "normal" | "strong";
  animation?: "pop" | "scatter" | "merge" | "slide-up" | "impact" | "fade-rise" | "word-reveal" | "spark-emphasis" | "steady" | "hook-slam" | "keyword-hit" | "number-count" | "reversal-swap" | "step-card" | "conclusion-stamp" | "brand-tag" | "cta-push";
};

export type CameraCue = {
  start: number;
  end: number;
  scale: number;
  origin?: string;
  style?: string;
  move?: "cut" | "snap" | "smooth";
  easeDuration?: number;
  reason?: string;
};

export type FocusCue = {
  start: number;
  end: number;
  style: "radial-spotlight";
  radius?: number;
  x?: number;
  y?: number;
};

export type TransitionCue = {
  start: number;
  duration?: number;
  style: "soft-punch" | "drift-left" | "drift-right" | "soft-flash" | "editorial-cut" | "editorial-wipe" | "source-cut" | "semantic-cut" | "depth-push" | "contrast-cut" | "clean-wipe" | "red-white-snap" | "yellow-brush-wipe" | "cyan-panel-slide" | "focus-iris-cut" | "camera-punch-in" | "closing-push" | "pullback-reset" | "jump-reframe" | "focus-rack" | "focus-lock" | "page-turn" | "reframe-cut";
  intensity?: number;
  reason?: string;
  trigger?: string;
};

export type SourceLayout = {
  sourceFit?: "cover" | "contain-blur";
  activity?: "static-talking-head" | "balanced-source" | "dynamic-source" | "legacy";
  aspectRatio?: number;
  sceneChangeCount?: number;
  sceneChangesPerMinute?: number;
  cameraStrength?: number;
  transitionDensity?: number;
  preserveSourceCuts?: boolean;
};

export type AudioMixProfile = {
  standard?: "speech-first-v1" | string;
  speechTargetLufs?: number;
  speechMeasuredLufs?: number | null;
  sourceVolume?: number;
  bgmReferenceLufs?: number;
  bgmMeasuredLufs?: number | null;
  bgmSpeechVolume?: number;
  bgmGapVolume?: number;
  sfxBusVolume?: number;
};

export type SfxCue = {
  start: number;
  file: string;
  volume?: number;
  playbackRate?: number;
};

export type ChapterCue = {
  start: number;
  end: number;
  index: number;
  title: string;
};

export type InfoCardCue = {
  start: number;
  end: number;
  type: "metric" | "list" | "steps" | "comparison" | "quote";
  eyebrow?: string;
  title: string;
  body?: string;
  items?: string[];
};

export type ViralTheme = {
  rendererKey?: string;
  name: string;
  background: string;
  foreground: string;
  accent: string;
  accentSoft: string;
  titlePosition: "top" | "center";
  subtitlePosition: "middle" | "bottom";
  captionMode?: "classic" | "kinetic-red-white" | "kinetic-yellow-white" | "kinetic-mint-white" | "kinetic-bold-yellow-white" | "kinetic-viral-pulse" | "kinetic-soft-rose" | "kinetic-studio-series";
  keywordColor?: string;
  headlineDuration?: number;
  headlineTop?: number;
  headlinePersistent?: boolean;
  headlineAnimation?: "fade-scale" | "staggered-punch";
  headlineFontSize?: number;
  headlineLineGap?: number;
  titleVariant?: "primary" | "secondary" | "compact";
  captionSafeInset?: number;
  captionMaxWidth?: number;
  captionLineMaxChars?: number;
};

export type ViralTimeline = {
  version: 1 | 2;
  sourceFile: string;
  sourceVolume?: number;
  sourceLayout?: SourceLayout;
  audioMix?: AudioMixProfile;
  bgmFile?: string;
  bgmTrackId?: string;
  bgmVolume?: number;
  bgmGapVolume?: number;
  bgmLoop?: boolean;
  sfxFile?: string;
  sfxVolume?: number;
  sfxCues?: SfxCue[];
  duration: number;
  fps: number;
  title: string;
  merchantName?: string;
  coverTime?: number;
  captions: CaptionCue[];
  cameraCues?: CameraCue[];
  focusCues?: FocusCue[];
  transitionCues?: TransitionCue[];
  chapters: ChapterCue[];
  cards: InfoCardCue[];
  theme: ViralTheme;
};
