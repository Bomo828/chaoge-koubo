import React, {useEffect, useMemo, useState} from "react";
import {
  AbsoluteFill,
  Audio,
  cancelRender,
  continueRender,
  delayRender,
  Easing,
  Freeze,
  interpolate,
  OffthreadVideo,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type {CaptionCue, InfoCardCue, ViralTimeline} from "./types";

const fontFamily = '"Merchant Sans", "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';

const secondsToFrames = (seconds: number, fps: number) => Math.max(0, Math.round(seconds * fps));

const normalizeWords = (caption: CaptionCue) => {
  if (caption.words?.length) return caption.words;
  const highlightPattern = /(\d+(?:\.\d+)?(?:元|折|次|分钟|小时)?|免费|优惠|限时|专业|自然|真实|重点|一定|必须)/g;
  const highlightToken = /^(\d+(?:\.\d+)?(?:元|折|次|分钟|小时)?|免费|优惠|限时|专业|自然|真实|重点|一定|必须)$/;
  return caption.text.split(highlightPattern).filter(Boolean).map((text) => ({
    text,
    start: caption.start,
    end: caption.end,
    highlight: highlightToken.test(text),
  }));
};

const kineticFontFamily = '"Songti SC", "STSong", "Noto Serif CJK SC", serif';
const brushFontFamily = '"Merchant Brush", "Weibei SC", "Kaiti SC", "STKaiti", "Songti SC", serif';
const englishSerifFontFamily = 'Georgia, "Times New Roman", serif';
const editorialTitleFontFamily = '"Merchant Serif", "Songti SC", "STSong", serif';
const editorialHumanistFontFamily = '"Merchant Humanist", "Kaiti SC", serif';
const editorialNumberFontFamily = '"Merchant Condensed", "Arial Narrow", sans-serif';
const template10BrushTitleFontFamily = '"Merchant Template10 Brush", "Merchant Brush", serif';
const template11SansFontFamily = '"Merchant Template11 Sans", "Merchant Sans", sans-serif';
const template12SansFontFamily = '"Merchant Template12 Sans", "Merchant Sans", sans-serif';

let bundledFontsPromise: Promise<void> | null = null;

const loadBundledFonts = () => {
  if (bundledFontsPromise) return bundledFontsPromise;
  bundledFontsPromise = Promise.all([
    new FontFace("Merchant Brush", `url(${staticFile("fonts/MaShanZheng-Regular.ttf")})`, {weight: "400"}).load(),
    new FontFace("Merchant Sans", `url(${staticFile("fonts/NotoSansSC-Variable.ttf")})`, {weight: "100 900"}).load(),
    new FontFace("Merchant Serif", `url(${staticFile("fonts/template-9/NotoSerifSC-Variable.ttf")})`, {weight: "200 900"}).load(),
    new FontFace("Merchant Humanist", `url(${staticFile("fonts/template-9/LXGWWenKai-Medium.ttf")})`, {weight: "500"}).load(),
    new FontFace("Merchant Condensed", `url(${staticFile("fonts/template-9/Oswald-Variable.ttf")})`, {weight: "200 700"}).load(),
    new FontFace("Merchant Template10 Brush", `url(${staticFile("fonts/template-10/WenYueHuiMoShouShu.otf")})`, {weight: "400"}).load(),
    new FontFace("Merchant Template11 Sans", `url(${staticFile("fonts/template-11/NotoSansSC-Variable.ttf")})`, {weight: "100 900"}).load(),
    new FontFace("Merchant Template12 Sans", `url(${staticFile("fonts/template-12/NotoSansSC-Variable.ttf")})`, {weight: "100 900"}).load(),
  ]).then((fonts) => {
    fonts.forEach((font) => {
      (document.fonts as FontFaceSet & {add: (face: FontFace) => void}).add(font);
    });
  });
  return bundledFontsPromise;
};

const useBundledFonts = () => {
  const [handle] = useState(() => delayRender("加载商装工坊开源字体"));
  useEffect(() => {
    loadBundledFonts()
      .then(() => document.fonts.ready)
      .then(() => continueRender(handle))
      .catch((error) => cancelRender(error));
  }, [handle]);
};

const fallbackKeyword = (text: string) => {
  const candidates = text
    .replace(/[，。！？；：、]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const preferred = ["免费", "优惠", "技能", "培训", "岗位", "基础", "实用", "咨询", "开始", "老师", "钟智联"];
  const exact = preferred.find((item) => text.includes(item));
  if (exact) return exact;
  const compact = candidates.join("");
  if (compact.length <= 4) return compact;
  const length = compact.length >= 10 ? 4 : 3;
  return compact.slice(Math.max(0, Math.floor((compact.length - length) / 2)), Math.max(0, Math.floor((compact.length - length) / 2)) + length);
};

const compactCaptionText = (text: string) => text
  .replace(/[\s，。！？；：、,.!?;:]/g, "")
  .trim();

const resolvedKeyword = (caption: CaptionCue, compact: string) => {
  if (caption.keyword && compact.includes(caption.keyword)) return caption.keyword;
  // The AI director may explicitly decide that a transition or filler sentence
  // should stay visually quiet. Do not manufacture a midpoint fragment after
  // that decision has been locked by the video worker.
  if (caption.keywordLocked) return "";
  return fallbackKeyword(compact);
};

const splitTwoRowCaption = (text: string, keyword: string) => {
  const characters = Array.from(text);
  if (characters.length <= 4) return [text];
  const keywordIndex = keyword ? text.indexOf(keyword) : -1;
  const midpoint = Math.max(2, Math.min(characters.length - 2, Math.ceil(characters.length / 2)));
  if (keywordIndex > 1 && keywordIndex < characters.length - 1) {
    return [characters.slice(0, keywordIndex).join(""), characters.slice(keywordIndex).join("")];
  }
  return [characters.slice(0, midpoint).join(""), characters.slice(midpoint).join("")];
};

const kineticGroups = (caption: CaptionCue) => {
  const compact = compactCaptionText(caption.text);
  const keyword = resolvedKeyword(caption, compact);
  const before = keyword ? compact.slice(0, compact.indexOf(keyword)) : "";
  const after = keyword ? compact.slice(compact.indexOf(keyword) + keyword.length) : "";
  const groups = [before, keyword, after].filter(Boolean);
  if (groups.length > 1) return {groups, keyword};
  const size = compact.length >= 10 ? 4 : Math.max(2, Math.ceil(compact.length / 2));
  return {
    groups: Array.from({length: Math.ceil(compact.length / size)}, (_, index) => compact.slice(index * size, (index + 1) * size)).filter(Boolean),
    keyword,
  };
};

const splitOpeningTitle = (value: string) => {
  const explicitLines = value
    .split(/[|｜]/)
    .map((line) => line.replace(/[，。！？；：]/g, "").trim())
    .filter(Boolean);
  if (explicitLines.length >= 2) {
    return [explicitLines[0], explicitLines.slice(1).join("")];
  }
  const compact = explicitLines[0] ?? value.replace(/[，。！？；：]/g, "").trim();
  if (compact.length <= 9) return [compact];
  const middle = compact.length / 2;
  const candidates = new Set<number>();
  const markers = ["如何", "怎么", "为什么", "从哪", "从哪里", "坚持", "就是", "让", "更", "培训", "一定", "千万"];
  markers.forEach((marker) => {
    let cursor = compact.indexOf(marker);
    while (cursor > 0) {
      if (cursor >= 4 && compact.length - cursor >= 4) candidates.add(cursor);
      cursor = compact.indexOf(marker, cursor + 1);
    }
  });
  const fallback = Math.max(5, Math.min(compact.length - 4, Math.round(middle)));
  const splitAt = [...candidates].sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))[0] ?? fallback;
  return [compact.slice(0, splitAt), compact.slice(splitAt)];
};

const splitCaptionLines = (value: string, maxChars: number) => {
  const characters = Array.from(value);
  if (characters.length <= maxChars) return [value];
  // Never clip spoken content to fit a layout. Older code sliced to two lines
  // and silently dropped all remaining characters, which caused the visible
  // subtitles to disagree with the actual voice track.
  const lineCount = Math.ceil(characters.length / maxChars);
  const baseSize = Math.floor(characters.length / lineCount);
  const extra = characters.length % lineCount;
  const lines: string[] = [];
  let cursor = 0;
  for (let index = 0; index < lineCount; index += 1) {
    const size = baseSize + (index < extra ? 1 : 0);
    lines.push(characters.slice(cursor, cursor + size).join(""));
    cursor += size;
  }
  return lines.filter(Boolean);
};

const adaptiveCaptionLines = (caption: CaptionCue, value: string, maxChars: number) => {
  const directed = (caption.captionLines ?? [])
    .map((line) => line.replace(/\s+/g, "").trim())
    .filter(Boolean);
  if (
    caption.captionLineMode === "two-line"
    && directed.length === 2
    && directed.join("") === value
  ) return directed;
  if (value.length <= maxChars) return [value];

  const characters = Array.from(value);
  const keyword = (caption.keyword ?? "").replace(/\s+/g, "");
  const keywordStart = keyword ? value.indexOf(keyword) : -1;
  const keywordEnd = keywordStart >= 0 ? keywordStart + keyword.length : -1;
  const midpoint = characters.length / 2;
  const minimumSide = Math.max(2, Math.min(4, Math.floor(characters.length / 3)));
  const positions = Array.from(
    {length: Math.max(1, characters.length - minimumSide * 2 + 1)},
    (_, index) => index + minimumSide,
  ).filter((position) => !(keywordStart >= 0 && keywordStart < position && position < keywordEnd));
  const splitAt = positions.sort((a, b) => {
    const overflowA = Math.max(0, a - maxChars) + Math.max(0, characters.length - a - maxChars);
    const overflowB = Math.max(0, b - maxChars) + Math.max(0, characters.length - b - maxChars);
    return overflowA - overflowB || Math.abs(a - midpoint) - Math.abs(b - midpoint);
  })[0] ?? Math.round(midpoint);
  return [characters.slice(0, splitAt).join(""), characters.slice(splitAt).join("")].filter(Boolean);
};

type StudioStyle = {
  id: number;
  accent: string;
  accent2: string;
  foreground: string;
  panel: string;
};

const studioStyleFor = (rendererKey = ""): StudioStyle | null => {
  const match = rendererKey.match(/^template-(\d+)-/);
  if (!match) return null;
  return {
    1: {id: 1, accent: "#ff287f", accent2: "#f3ddc7", foreground: "#fffdf8", panel: "rgba(15,10,14,.86)"},
    2: {id: 2, accent: "#904565", accent2: "#f0d2df", foreground: "#fffdfb", panel: "rgba(34,15,26,.78)"},
    3: {id: 3, accent: "#ffd64f", accent2: "#78d9ff", foreground: "#f9fbff", panel: "rgba(7,26,43,.84)"},
    4: {id: 4, accent: "#ff7849", accent2: "#fff0c7", foreground: "#fffdf7", panel: "rgba(29,17,11,.86)"},
    5: {id: 5, accent: "#77e6bd", accent2: "#d9fff0", foreground: "#ffffff", panel: "rgba(8,33,27,.74)"},
    6: {id: 6, accent: "#d8b36a", accent2: "#f6ead1", foreground: "#fffaf0", panel: "rgba(47,17,28,.84)"},
    7: {id: 7, accent: "#ff5a36", accent2: "#fff1df", foreground: "#fffdf8", panel: "rgba(24,18,16,.84)"},
    8: {id: 8, accent: "#ffffff", accent2: "#bfc4ca", foreground: "#ffffff", panel: "rgba(6,6,7,.80)"},
    9: {id: 9, accent: "#a52b26", accent2: "#f1e5dc", foreground: "#fffdf9", panel: "rgba(31,12,17,.72)"},
    10: {id: 10, accent: "#fff300", accent2: "#fffdf8", foreground: "#fffdf8", panel: "transparent"},
    11: {id: 11, accent: "#79f4e4", accent2: "#ffffff", foreground: "#ffffff", panel: "transparent"},
    12: {id: 12, accent: "#fff000", accent2: "#ffffff", foreground: "#ffffff", panel: "rgba(7,7,7,.52)"},
  }[Number(match[1])] ?? null;
};

const StudioOpeningTitle: React.FC<{timeline: ViralTimeline; style: StudioStyle; opacity: number; entrance: number}> = ({timeline, style, opacity, entrance}) => {
  const lines = splitOpeningTitle(timeline.title);
  const [eyebrow, ...rest] = lines;
  const headline = rest.join("") || eyebrow || timeline.title;
  const firstLine = rest.length ? eyebrow : "";
  const titleVariant = timeline.theme.titleVariant ?? "primary";
  const base: React.CSSProperties = {
    position: "absolute",
    top: timeline.theme.headlineTop ?? 154,
    left: 62,
    right: 62,
    zIndex: 4,
    opacity,
    transform: `translateY(${(1 - entrance) * 28}px) scale(${.96 + entrance * .04})`,
    fontFamily,
  };
  if (style.id === 12) {
    const titleParts = [firstLine, headline].filter(Boolean);
    const whiteLine = titleParts[0] ?? headline;
    const yellowLine = titleParts[1] ?? "";
    const whiteSize = Math.max(112, Math.min(140, 940 / Math.max(5, Array.from(whiteLine).length)));
    const yellowSize = Math.max(118, Math.min(146, 950 / Math.max(5, Array.from(yellowLine || whiteLine).length)));
    return <div style={{...base, top: 68, left: 36, right: 36, height: 365, transform: `translateY(${(1 - entrance) * 10}px)`, transformOrigin: "center top"}}>
      <svg width="100%" height="365" viewBox="0 0 1008 365" textRendering="geometricPrecision" shapeRendering="geometricPrecision" style={{display: "block", overflow: "visible"}}>
        <defs>
          <filter id="template12-title-shadow" x="-8%" y="-10%" width="120%" height="135%">
            <feDropShadow dx="2.5" dy="4.5" stdDeviation="1.2" floodColor="rgba(0,0,0,.92)" />
          </filter>
        </defs>
        <rect x="0" y="0" width="1008" height="365" rx="0" fill={style.panel} />
        <text x="504" y="163" textAnchor="middle" fill={style.foreground} stroke="rgba(0,0,0,.98)" strokeWidth="6.8" strokeLinejoin="round" strokeLinecap="round" paintOrder="stroke fill" fontFamily={template12SansFontFamily} fontSize={whiteSize} fontWeight="900" letterSpacing="-5.2" filter="url(#template12-title-shadow)">{whiteLine}</text>
        {yellowLine ? <text x="504" y="318" textAnchor="middle" fill={style.accent} stroke="rgba(0,0,0,.98)" strokeWidth="7.2" strokeLinejoin="round" strokeLinecap="round" paintOrder="stroke fill" fontFamily={template12SansFontFamily} fontSize={yellowSize} fontWeight="900" letterSpacing="-5.8" filter="url(#template12-title-shadow)">{yellowLine}</text> : null}
      </svg>
    </div>;
  }
  if (style.id === 11) {
    const titleParts = [firstLine, headline].filter(Boolean);
    const cyanLine = titleParts[0] ?? headline;
    const whiteLine = titleParts[1] ?? "";
    const cyanSize = Math.max(88, Math.min(112, 760 / Math.max(5, Array.from(cyanLine).length)));
    const whiteSize = Math.max(68, Math.min(84, 690 / Math.max(5, Array.from(whiteLine || cyanLine).length)));
    return <div style={{...base, top: 18, left: 54, right: 46, height: 248, transform: `translateY(${(1 - entrance) * 12}px)`, transformOrigin: "left top"}}>
      <svg width="100%" height="248" viewBox="0 0 980 248" style={{display: "block", overflow: "visible"}}>
        <defs>
          <filter id="template11-title-shadow" x="-10%" y="-12%" width="126%" height="145%">
            <feDropShadow dx="3" dy="7" stdDeviation="1.8" floodColor="rgba(0,0,0,.88)" />
          </filter>
        </defs>
        <text x="0" y="112" fill={style.accent} stroke="rgba(0,0,0,.94)" strokeWidth="3.2" strokeLinejoin="round" paintOrder="stroke fill" fontFamily={template11SansFontFamily} fontSize={cyanSize} fontWeight="900" letterSpacing="-4.2" filter="url(#template11-title-shadow)">{cyanLine}</text>
        {whiteLine ? <text x="2" y="208" fill={style.foreground} stroke="rgba(0,0,0,.92)" strokeWidth="2.6" strokeLinejoin="round" paintOrder="stroke fill" fontFamily={template11SansFontFamily} fontSize={whiteSize} fontWeight="480" letterSpacing="-4" filter="url(#template11-title-shadow)">{whiteLine}</text> : null}
      </svg>
    </div>;
  }
  if (style.id === 10) {
    const titleParts = [firstLine, headline].filter(Boolean);
    const whiteLine = titleParts[0] ?? headline;
    const yellowLine = titleParts[1] ?? "";
    return <div style={{...base, top: 22, left: 28, right: 28, height: 332, textAlign: "center", transform: `translateY(${(1 - entrance) * 18}px) scale(${.975 + entrance * .025})`}}>
      <svg width="100%" height="332" viewBox="0 0 1024 332" style={{display: "block", overflow: "visible"}}>
        <defs>
          <filter id="template10-brush-shadow" x="-12%" y="-18%" width="124%" height="145%">
            <feDropShadow dx="0" dy="8" stdDeviation="3.2" floodColor="rgba(34,28,23,.62)" />
          </filter>
          <filter id="template10-block-shadow" x="-12%" y="-18%" width="124%" height="145%">
            <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="10" result="texture" />
            <feDisplacementMap in="SourceGraphic" in2="texture" scale="1.2" xChannelSelector="R" yChannelSelector="G" result="roughened" />
            <feDropShadow in="roughened" dx="0" dy="8" stdDeviation="3.6" floodColor="rgba(34,28,23,.68)" />
          </filter>
        </defs>
        <text x="512" y="151" textAnchor="middle" fill={style.foreground} stroke="rgba(27,22,18,.24)" strokeWidth="1.4" strokeLinejoin="round" paintOrder="stroke fill" fontFamily={template10BrushTitleFontFamily} fontSize="154" fontWeight="400" letterSpacing="-2.8" filter="url(#template10-brush-shadow)">{whiteLine}</text>
        {yellowLine ? <text x="512" y="272" textAnchor="middle" fill={style.accent} stroke="rgba(31,25,20,.32)" strokeWidth="2.2" strokeLinejoin="round" paintOrder="stroke fill" fontFamily={template10BrushTitleFontFamily} fontSize="138" fontWeight="400" letterSpacing="-4.8" filter="url(#template10-block-shadow)">{yellowLine}</text> : null}
      </svg>
    </div>;
  }
  if (style.id === 9) {
    const titleParts = [firstLine, headline].filter(Boolean);
    const mainTitle = titleParts.length > 1
      ? [...titleParts].sort((a, b) => Array.from(b).length - Array.from(a).length)[0]
      : headline;
    const smallTitle = titleParts.length > 1 ? titleParts.find((item) => item !== mainTitle) ?? "" : "";
    const headlineLength = Array.from(mainTitle).length;
    const headlineSize = headlineLength <= 4 ? 128 : headlineLength <= 7 ? 142 : 124;
    const titleOffset = Math.round((1 - entrance) * 24);
    return <div style={{...base, top: 96, left: 38, right: 38, height: 300, transform: titleOffset ? `translateY(${titleOffset}px)` : "none"}}>
      <svg
        width="100%"
        height="300"
        viewBox="0 0 1004 300"
        textRendering="geometricPrecision"
        shapeRendering="geometricPrecision"
        style={{display: "block", overflow: "visible", filter: "drop-shadow(3px 5px 0 rgba(21,8,9,.48))"}}
      >
        {smallTitle ? <text
          x="970"
          y="82"
          textAnchor="end"
          fill="rgba(255,255,255,.99)"
          stroke={style.accent}
          strokeWidth="4"
          strokeLinejoin="round"
          strokeLinecap="round"
          strokeMiterlimit="2"
          paintOrder="stroke fill"
          fontFamily={editorialTitleFontFamily}
          fontSize="78"
          fontWeight="900"
          letterSpacing="-4"
        >{smallTitle}</text> : null}
        <text
          x="970"
          y={smallTitle ? 232 : 166}
          textAnchor="end"
          fill={style.accent}
          stroke="rgba(255,255,255,.99)"
          strokeWidth="5.2"
          strokeLinejoin="round"
          strokeLinecap="round"
          strokeMiterlimit="2"
          paintOrder="stroke fill"
          fontFamily={editorialTitleFontFamily}
          fontSize={headlineSize}
          fontWeight="900"
          letterSpacing="-8"
        >{mainTitle}</text>
      </svg>
    </div>;
  }
  if (style.id === 1) {
    const secondary = titleVariant === "secondary";
    return <div style={{...base, left: secondary ? 72 : 54, right: secondary ? 54 : 72, transform: `${base.transform} rotate(${secondary ? .3 : -.3}deg)`}}>
      <div style={{display: "flex", flexDirection: "column", alignItems: secondary ? "flex-start" : "flex-end"}}>
        <div style={{position: "relative", minWidth: 620, maxWidth: 930, padding: firstLine ? "24px 30px 27px" : "21px 30px 25px", background: "rgba(12,10,12,.87)", borderLeft: secondary ? `9px solid ${style.accent}` : undefined, borderRight: secondary ? undefined : `9px solid ${style.accent}`, boxShadow: "0 16px 34px rgba(0,0,0,.32)"}}>
          {firstLine ? <div style={{color: style.accent, fontFamily: brushFontFamily, fontSize: 55, lineHeight: .92, fontWeight: 400, letterSpacing: 1.2, WebkitTextStroke: "1.2px rgba(255,255,255,.92)", paintOrder: "stroke fill", textShadow: "0 4px 8px rgba(0,0,0,.72)"}}>{firstLine}</div> : null}
          <div style={{marginTop: firstLine ? 8 : 0, color: style.foreground, fontFamily, fontSize: 91, lineHeight: .98, fontWeight: 900, letterSpacing: -3.6, WebkitTextStroke: "3.2px rgba(0,0,0,.98)", paintOrder: "stroke fill", textShadow: "0 5px 10px rgba(0,0,0,.56)"}}>{headline}</div>
          <div style={{position: "absolute", left: secondary ? 28 : 120, right: secondary ? 120 : 28, bottom: -6, height: 6, background: style.accent}} />
        </div>
      </div>
    </div>;
  }
  if (style.id === 2) {
    const secondary = titleVariant === "secondary";
    return <div style={{...base, left: secondary ? 56 : 155, right: secondary ? 155 : 56, textAlign: secondary ? "left" : "right"}}>
      <div style={{display: "flex", justifyContent: secondary ? "flex-start" : "flex-end"}}><span style={{width: 92 * entrance, height: 2, background: style.accent2}} /></div>
      <div style={{marginTop: 13, padding: "18px 24px 21px", borderRadius: secondary ? "4px 38px 4px 38px" : "38px 4px 38px 4px", background: style.panel, borderRight: secondary ? undefined : `9px solid ${style.accent}`, borderLeft: secondary ? `9px solid ${style.accent}` : undefined, boxShadow: "0 20px 46px rgba(0,0,0,.34)"}}>
        {firstLine ? <div style={{color: style.accent2, fontFamily: kineticFontFamily, fontSize: 44, lineHeight: 1, fontWeight: 850}}>{firstLine}</div> : null}
        <div style={{marginTop: 7, color: style.foreground, fontSize: 79, lineHeight: 1.02, fontWeight: 900, letterSpacing: -3, textShadow: "0 6px 18px rgba(0,0,0,.6)"}}>{headline}</div>
      </div>
    </div>;
  }
  if (style.id === 3) {
    const secondary = titleVariant === "secondary";
    return <div style={{...base, left: 66, right: 80}}>
      {firstLine ? <div style={{display: "inline-flex", alignItems: "center", padding: "6px 15px", background: style.accent, color: "#10202b", fontSize: 29, fontWeight: 950, letterSpacing: 2}}>{firstLine}</div> : null}
      <div style={{marginTop: 8, padding: "15px 24px 20px", background: secondary ? style.panel : "rgba(248,251,255,.93)", color: secondary ? style.foreground : "#142b3c", border: secondary ? `2px solid ${style.accent2}` : undefined, fontSize: 78, lineHeight: 1.01, fontWeight: 950, letterSpacing: -3, boxShadow: `${secondary ? -12 : 12}px 12px 0 ${secondary ? style.accent : style.accent2}, 0 18px 44px rgba(0,0,0,.28)`, transform: `rotate(${secondary ? .6 : -.5}deg)`}}>{headline}</div>
      <div style={{marginTop: 11, width: 270 * entrance, height: 6, background: style.accent}} />
    </div>;
  }
  if (style.id === 4) {
    const secondary = titleVariant === "secondary";
    return <div style={{...base, left: 58, right: 58, display: "grid", gridTemplateColumns: "18px 1fr", alignItems: "stretch", transform: `${base.transform} rotate(.6deg)`}}>
      <div style={{background: secondary ? style.accent2 : style.accent}} />
      <div style={{padding: "15px 25px 20px", background: style.panel, borderTop: `5px solid ${style.accent2}`, borderBottom: `5px solid ${style.accent2}`, boxShadow: "0 20px 46px rgba(0,0,0,.34)"}}>
        {firstLine ? <div style={{color: style.accent, fontSize: 28, fontWeight: 950, letterSpacing: 3}}>{firstLine}</div> : null}
        <div style={{marginTop: 6, color: style.foreground, fontSize: 78, lineHeight: 1, fontWeight: 950, letterSpacing: -3, WebkitTextStroke: "2px #111", paintOrder: "stroke fill"}}>{headline}</div>
      </div>
    </div>;
  }
  if (style.id === 5) {
    return <div style={{...base, textAlign: "center"}}>
      {firstLine ? <div style={{color: style.accent2, fontSize: 27, fontWeight: 800, letterSpacing: 6}}>{firstLine}</div> : null}
      <div style={{marginTop: 9, color: style.foreground, fontSize: 79, lineHeight: 1.04, fontWeight: 850, letterSpacing: -2, textShadow: "0 5px 16px rgba(0,0,0,.55)"}}>{headline}</div>
      <div style={{width: 190 * entrance, height: 8, margin: "17px auto 0", borderRadius: 99, background: style.accent, boxShadow: `0 0 24px ${style.accent}`}} />
    </div>;
  }
  if (style.id === 7) {
    const secondary = titleVariant === "secondary";
    return <div style={{...base, left: 58, right: 58}}>
      <div style={{display: "grid", gridTemplateColumns: firstLine ? "1fr auto" : "1fr", alignItems: "end", gap: 12}}>
        <div style={{padding: "16px 20px 19px", background: secondary ? style.panel : "rgba(255,248,237,.94)", color: secondary ? style.foreground : "#241813", border: secondary ? `2px solid ${style.accent2}` : undefined, fontSize: 77, lineHeight: .98, fontWeight: 950, letterSpacing: -3, boxShadow: "0 16px 42px rgba(0,0,0,.3)"}}>{headline}</div>
        {firstLine ? <div style={{padding: "10px 12px 13px", background: style.accent, color: "#fff", fontSize: 27, lineHeight: 1.05, fontWeight: 950, writingMode: "vertical-rl", letterSpacing: 3}}>{firstLine}</div> : null}
      </div>
    </div>;
  }
  if (style.id === 8) {
    const secondary = titleVariant === "secondary";
    return <div style={{...base, textAlign: "center"}}>
      {firstLine ? <div style={{display: "inline-block", padding: "7px 16px", border: `2px solid ${style.accent}`, background: secondary ? "#fff" : "transparent", color: secondary ? "#070708" : style.accent, fontSize: 23, fontWeight: 700, letterSpacing: 6}}>{firstLine}</div> : null}
      <div style={{marginTop: 17, display: "inline-block", padding: secondary ? "8px 18px 12px" : 0, background: secondary ? "rgba(0,0,0,.78)" : "transparent", color: style.foreground, fontSize: 76, lineHeight: 1.06, fontWeight: 760, letterSpacing: 1, textShadow: "0 5px 18px rgba(0,0,0,.76)"}}>{headline}{secondary ? <span style={{marginLeft: 7, color: style.accent2}}>_</span> : null}</div>
    </div>;
  }
  const secondary = titleVariant === "secondary";
  return <div style={{...base, left: secondary ? 122 : 72, right: secondary ? 52 : 72}}>
    <div style={{position: "relative", padding: "27px 38px 31px", background: secondary ? "rgba(24,15,18,.86)" : "rgba(61,20,34,.85)", border: `1.5px solid ${style.accent}aa`, borderTopWidth: secondary ? 7 : 1.5, boxShadow: "0 22px 52px rgba(0,0,0,.36)", backdropFilter: "blur(10px)"}}>
      <div style={{position: "absolute", left: 16, top: -29, color: style.accent, fontFamily: englishSerifFontFamily, fontSize: 92, lineHeight: 1}}>“</div>
      {firstLine ? <div style={{paddingLeft: 40, color: style.accent2, fontFamily: kineticFontFamily, fontSize: 31, fontWeight: 800, letterSpacing: 5}}>{firstLine}</div> : null}
      <div style={{marginTop: 10, paddingLeft: 40, color: style.foreground, fontFamily: kineticFontFamily, fontSize: 75, lineHeight: 1.04, fontWeight: 850, letterSpacing: -2, textShadow: "0 5px 18px rgba(0,0,0,.55)"}}>{headline}</div>
    </div>
  </div>;
};

const StudioSeriesSubtitle: React.FC<{caption: CaptionCue; timeline: ViralTimeline; index: number; style: StudioStyle}> = ({caption, timeline, index, style}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const durationFrames = Math.max(1, secondsToFrames((caption.displayEnd ?? caption.end) - caption.start, fps));
  const compact = compactCaptionText(caption.text);
  const keyword = resolvedKeyword(caption, compact);
  const keywordStart = keyword ? compact.indexOf(keyword) : -1;
  const lines = splitCaptionLines(compact, Math.max(6, Math.min(9, timeline.theme.captionLineMaxChars ?? 8)));
  const enter = spring({frame, fps, config: {damping: style.id === 4 ? 11 : 18, stiffness: style.id === 4 ? 280 : 180, mass: .58}});
  const fadeOut = interpolate(frame, [Math.max(4, durationFrames - 7), durationFrames], [1, 0], {extrapolateLeft: "clamp", extrapolateRight: "clamp"});
  const leftAligned = style.id === 3 || style.id === 7;
  const direction = index % 2 ? 1 : -1;
  const translateX = style.id === 7 ? (1 - enter) * 80 * direction : style.id === 3 ? (1 - enter) * -48 : 0;
  const rotate = style.id === 4 ? (1 - enter) * direction * 2.2 : 0;
  const panel = style.id === 3 || style.id === 6 || style.id === 7;
  if (style.id === 12) {
    const compactTranslation = String(caption.translation ?? "").trim();
    const captionLines = splitCaptionLines(compact, Math.max(6, Math.min(10, timeline.theme.captionLineMaxChars ?? 9)));
    const strong = caption.emphasis === "strong" || caption.role === "focus";
    const plain = caption.captionStyle === "plain" || caption.captionStyle === "focus-lower";
    const baseFontSize = strong ? 140 : 122;
    const keywordFontSize = Math.round(baseFontSize * 1.12);
    const svgHeight = captionLines.length * 154 + 16;
    const captionOffset = Math.round((1 - enter) * 13);
    const captionTop = caption.captionStyle === "focus-lower" ? 1370 : 1295;
    return <div style={{position: "absolute", top: captionTop, left: 36, right: 36, zIndex: 6, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", opacity: fadeOut * enter, transform: captionOffset ? `translateY(${captionOffset}px) scale(${.97 + enter * .03})` : "none"}}>
      <svg width="988" height={svgHeight} viewBox={`0 0 988 ${svgHeight}`} textRendering="geometricPrecision" shapeRendering="geometricPrecision" style={{display: "block", maxWidth: timeline.theme.captionMaxWidth ?? 930, overflow: "visible", filter: "drop-shadow(2px 4px 1px rgba(0,0,0,.78))"}}>
        {captionLines.map((line, lineIndex) => {
          const characterOffset = captionLines.slice(0, lineIndex).reduce((sum, item) => sum + Array.from(item).length, 0);
          const phraseHighlighted = strong;
          const lineCharacters = Array.from(line);
          const characterLayer = (outer: boolean) => lineCharacters.map((character, localIndex) => {
            const characterIndex = characterOffset + localIndex;
            const highlighted = phraseHighlighted || (!plain && keywordStart >= 0 && characterIndex >= keywordStart && characterIndex < keywordStart + (keyword?.length ?? 0));
            return <tspan key={`${outer ? "outer" : "main"}-${character}-${characterIndex}`} fill={outer ? "transparent" : highlighted ? style.accent : style.foreground} stroke={outer ? "rgba(255,255,255,.98)" : "rgba(0,0,0,.99)"} strokeWidth={outer ? 13.5 : 8.2} paintOrder="stroke fill" fontFamily={template12SansFontFamily} fontSize={highlighted && !phraseHighlighted ? keywordFontSize : baseFontSize} fontWeight="900" letterSpacing={highlighted ? "-5.2" : "-4.4"}>{character}</tspan>;
          });
          return <React.Fragment key={`${line}-${lineIndex}`}>
            <text x="494" y={132 + lineIndex * 154} textAnchor="middle" fill="transparent" stroke="rgba(255,255,255,.98)" strokeWidth="13.5" strokeLinejoin="round" strokeLinecap="round" paintOrder="stroke fill" fontFamily={template12SansFontFamily} fontSize={baseFontSize} fontWeight="900" letterSpacing="-4.4">{characterLayer(true)}</text>
            <text x="494" y={132 + lineIndex * 154} textAnchor="middle" fill={phraseHighlighted ? style.accent : style.foreground} stroke="rgba(0,0,0,.99)" strokeWidth="8.2" strokeLinejoin="round" strokeLinecap="round" paintOrder="stroke fill" fontFamily={template12SansFontFamily} fontSize={baseFontSize} fontWeight="900" letterSpacing="-4.4">
              {characterLayer(false)}
            </text>
          </React.Fragment>;
        })}
      </svg>
      {compactTranslation ? <div style={{marginTop: -2, color: "rgba(255,255,255,.99)", fontFamily: "Arial, Helvetica, sans-serif", fontSize: 48, lineHeight: 1.02, fontWeight: 800, letterSpacing: -1.1, WebkitTextStroke: "2.4px rgba(0,0,0,.98)", paintOrder: "stroke fill", textShadow: "1px 3px 1px rgba(0,0,0,.78)"}}>{compactTranslation}</div> : null}
    </div>;
  }
  if (style.id === 11) {
    const compactTranslation = String(caption.translation ?? "").trim();
    const captionLines = splitCaptionLines(compact, Math.max(8, Math.min(11, timeline.theme.captionLineMaxChars ?? 10)));
    const baseFontSize = 106;
    const keywordFontSize = 128;
    const svgHeight = captionLines.length * 132 + 12;
    return <div style={{position: "absolute", top: 1232, left: 38, right: 38, zIndex: 6, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", opacity: fadeOut}}>
      <svg width="984" height={svgHeight} viewBox={`0 0 984 ${svgHeight}`} style={{display: "block", maxWidth: timeline.theme.captionMaxWidth ?? 930, overflow: "visible", filter: "drop-shadow(2px 5px 2px rgba(0,0,0,.72))"}}>
        {captionLines.map((line, lineIndex) => {
          const characterOffset = captionLines.slice(0, lineIndex).reduce((sum, item) => sum + Array.from(item).length, 0);
          const lineCharacters = Array.from(line);
          return <text key={`${line}-${lineIndex}`} x="492" y={112 + lineIndex * 132} textAnchor="middle" fill={style.foreground} stroke="rgba(0,0,0,.88)" strokeWidth="2.6" strokeLinejoin="round" paintOrder="stroke fill" fontFamily={template11SansFontFamily} fontSize={baseFontSize} fontWeight="480" letterSpacing="-3.6">
            {lineCharacters.map((character, localIndex) => {
              const characterIndex = characterOffset + localIndex;
              const highlighted = keywordStart >= 0 && characterIndex >= keywordStart && characterIndex < keywordStart + (keyword?.length ?? 0);
              const delay = Math.min(24, characterIndex * 2.4);
              const reveal = interpolate(frame, [delay, delay + 4], [0, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"});
              return <tspan key={`${character}-${characterIndex}`} fill={highlighted ? style.accent : style.foreground} fillOpacity={reveal} stroke="rgba(0,0,0,.92)" strokeOpacity={reveal} strokeWidth={highlighted ? 4 : 2.6} paintOrder="stroke fill" fontFamily={template11SansFontFamily} fontSize={highlighted ? keywordFontSize : baseFontSize} fontWeight={highlighted ? 900 : 480} letterSpacing={highlighted ? "-4.8" : "-3.6"}>{character}</tspan>;
            })}
          </text>;
        })}
      </svg>
      {compactTranslation ? <div style={{marginTop: -6, color: "rgba(255,255,255,.98)", fontFamily: "Arial, Helvetica, sans-serif", fontSize: 44, lineHeight: 1.04, fontWeight: 500, letterSpacing: -.9, opacity: interpolate(frame, [5, 11], [0, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"}), textShadow: "-1px -1px 0 rgba(0,0,0,.9), 1px -1px 0 rgba(0,0,0,.9), -1px 1px 0 rgba(0,0,0,.9), 2px 4px 2px rgba(0,0,0,.72)"}}>{compactTranslation}</div> : null}
    </div>;
  }
  if (style.id === 10) {
    const compactTranslation = String(caption.translation ?? "").trim();
    const captionLines = lines;
    const baseFontSize = caption.emphasis === "strong" || caption.role === "focus" ? 76 : 72;
    const svgHeight = captionLines.length * 89 + 12;
    const calloutText = keyword || (caption.keywordLocked ? "" : compact.slice(0, 6));
    const captionOffset = Math.round((1 - enter) * 13);
    return <>
      {caption.sectionEmphasis && calloutText ? <div style={{position: "absolute", top: 92, left: 40, right: 40, zIndex: 4, textAlign: "center", opacity: fadeOut * enter * .72, transform: `translateY(${(1 - enter) * 16}px)`, color: "rgba(255,255,255,.88)", fontFamily: brushFontFamily, fontSize: Math.max(94, 146 - Math.max(0, Array.from(calloutText).length - 3) * 13), lineHeight: 1, fontWeight: 600, letterSpacing: 4, WebkitTextStroke: "2.2px rgba(16,12,9,.45)", paintOrder: "stroke fill", textShadow: "0 6px 13px rgba(0,0,0,.30)"}}>{calloutText}</div> : null}
      <div style={{position: "absolute", top: 1198, left: 72, right: 72, zIndex: 6, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", opacity: fadeOut * enter, transform: captionOffset ? `translateY(${captionOffset}px)` : "none"}}>
        <svg width="936" height={svgHeight} viewBox={`0 0 936 ${svgHeight}`} style={{display: "block", maxWidth: timeline.theme.captionMaxWidth ?? 896, overflow: "visible", filter: "drop-shadow(2px 5px 2px rgba(0,0,0,.58))"}}>
          {captionLines.map((line, lineIndex) => {
            const characterOffset = captionLines.slice(0, lineIndex).reduce((sum, item) => sum + Array.from(item).length, 0);
            return <text key={`${line}-${lineIndex}`} x="468" y={74 + lineIndex * 89} textAnchor="middle" fill={style.foreground} stroke="rgba(18,14,10,.94)" strokeWidth="4.4" strokeLinejoin="round" paintOrder="stroke fill" fontFamily={brushFontFamily} fontSize={baseFontSize} fontWeight="600" letterSpacing=".3">
              {Array.from(line).map((character, localIndex) => {
                const characterIndex = characterOffset + localIndex;
                const highlighted = keywordStart >= 0 && characterIndex >= keywordStart && characterIndex < keywordStart + (keyword?.length ?? 0);
                return <tspan key={`${character}-${characterIndex}`} fill={highlighted ? style.accent : style.foreground} stroke="rgba(18,14,10,.94)" strokeWidth={highlighted ? 5 : 4.4} paintOrder="stroke fill" fontFamily={highlighted ? kineticFontFamily : brushFontFamily} fontSize={highlighted ? Math.round(baseFontSize * 1.14) : baseFontSize} fontWeight={highlighted ? 950 : 600} letterSpacing={highlighted ? "-1.7" : ".3"}>{character}</tspan>;
              })}
            </text>;
          })}
        </svg>
        {compactTranslation ? <div style={{marginTop: 2, color: "rgba(255,255,255,.97)", fontFamily: englishSerifFontFamily, fontSize: 27, lineHeight: 1.06, fontWeight: 700, letterSpacing: .1, textShadow: "-1px -1px 0 rgba(0,0,0,.78), 1px 1px 1px rgba(0,0,0,.75)"}}>{compactTranslation}</div> : null}
      </div>
    </>;
  }
  if (style.id === 9) {
    const strong = caption.emphasis === "strong" || caption.role === "focus";
    const compactTranslation = String(caption.translation ?? "").trim();
    const captionLines = lines;
    const baseFontSize = strong ? 86 : 82;
    const keywordFontSize = Math.round(baseFontSize * 1.26);
    const svgHeight = captionLines.length * 104 + 18;
    const captionOffset = Math.round((1 - enter) * 14);
    return <div style={{
      position: "absolute",
      top: 1192,
      left: 76,
      right: 64,
      zIndex: 6,
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-start",
      textAlign: "left",
      opacity: fadeOut * enter,
      transform: captionOffset ? `translateY(${captionOffset}px)` : "none",
      transformOrigin: "left center",
    }}>
      <svg
        width="940"
        height={svgHeight}
        viewBox={`0 0 940 ${svgHeight}`}
        textRendering="geometricPrecision"
        shapeRendering="geometricPrecision"
        style={{display: "block", maxWidth: timeline.theme.captionMaxWidth ?? 850, overflow: "visible", filter: "drop-shadow(3px 4px 0 rgba(0,0,0,.55))"}}
      >
        {captionLines.map((line, lineIndex) => {
          const characterOffset = captionLines.slice(0, lineIndex).reduce((sum, item) => sum + Array.from(item).length, 0);
          return <text
            key={`${line}-${lineIndex}`}
            x="8"
            y={92 + lineIndex * 104}
            textAnchor="start"
            fill={style.foreground}
            stroke="rgba(13,9,10,.96)"
            strokeWidth="3.2"
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeMiterlimit="2"
            paintOrder="stroke fill"
            fontFamily={editorialTitleFontFamily}
            fontSize={baseFontSize}
            fontWeight={strong ? 900 : 880}
            letterSpacing="-3.6"
          >
            {Array.from(line).map((character, localIndex) => {
              const characterIndex = characterOffset + localIndex;
              const highlighted = keywordStart >= 0 && characterIndex >= keywordStart && characterIndex < keywordStart + (keyword?.length ?? 0);
              return <tspan
                key={`${character}-${characterIndex}`}
                fill={highlighted ? style.accent : style.foreground}
                stroke={highlighted ? "rgba(255,255,255,.99)" : "rgba(13,9,10,.96)"}
                strokeWidth={highlighted ? 4.2 : 3.2}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeMiterlimit="2"
                paintOrder="stroke fill"
                fontSize={highlighted ? keywordFontSize : baseFontSize}
                fontWeight={highlighted ? 900 : (strong ? 900 : 880)}
                letterSpacing={highlighted ? "-4.2" : "-3.6"}
              >{character}</tspan>;
            })}
          </text>;
        })}
      </svg>
      {compactTranslation ? <div style={{marginTop: -1, color: "rgba(255,255,255,.98)", fontFamily: "Arial, sans-serif", fontSize: 34, lineHeight: 1.02, fontWeight: 700, letterSpacing: -.4, WebkitTextStroke: ".8px rgba(0,0,0,.92)", paintOrder: "stroke fill", textShadow: "2px 3px 0 rgba(0,0,0,.58)"}}>{compactTranslation}</div> : null}
    </div>;
  }
  if (style.id === 1 || style.id === 2) {
    const twoRows = splitTwoRowCaption(compact, keyword);
    return <div style={{
      position: "absolute", top: style.id === 1 ? 1208 : 1210,
      left: timeline.theme.captionSafeInset ?? 82, right: timeline.theme.captionSafeInset ?? 82,
      zIndex: 6, display: "flex", flexDirection: "column", alignItems: "center",
      opacity: fadeOut * enter,
      transform: style.id === 1
        ? `translateY(${(1 - enter) * 18}px) scale(${.97 + enter * .03})`
        : `translateX(${(1 - enter) * 54}px) scale(${.97 + enter * .03})`,
    }}>
      <div style={{minWidth: 650, maxWidth: timeline.theme.captionMaxWidth ?? 900, display: "flex", flexDirection: "column", gap: style.id === 1 ? 7 : 6}}>
        {twoRows.map((line, lineIndex) => {
          const offset = twoRows.slice(0, lineIndex).reduce((sum, item) => sum + Array.from(item).length, 0);
          return <div key={`${line}-${lineIndex}`} style={{
            display: "flex",
            justifyContent: style.id === 1 ? (lineIndex === 0 ? "flex-start" : "flex-end") : "flex-end",
            paddingLeft: style.id === 1 && lineIndex === 0 ? 8 : 0,
            paddingRight: lineIndex === 1 ? 10 : 0,
            whiteSpace: "nowrap",
            fontFamily: style.id === 1 && lineIndex === 1 ? brushFontFamily : kineticFontFamily,
            fontSize: style.id === 1 ? (lineIndex === 0 ? 82 : 102) : (lineIndex === 0 ? 74 : 88),
            lineHeight: style.id === 1 ? .96 : .98,
            fontWeight: style.id === 1 && lineIndex === 1 ? 400 : style.id === 2 ? 850 : 900,
            letterSpacing: style.id === 1 && lineIndex === 1 ? .4 : -1.8,
            color: style.id === 1 ? (lineIndex === 1 ? style.accent : style.foreground) : (lineIndex === 0 ? style.accent2 : style.foreground),
            WebkitTextStroke: style.id === 1 && lineIndex === 1 ? "5px rgba(255,255,255,.98)" : "4.5px rgba(0,0,0,.96)",
            paintOrder: "stroke fill",
            textShadow: style.id === 1 && lineIndex === 1 ? "3px 6px 2px rgba(0,0,0,.82)" : "0 6px 12px rgba(0,0,0,.74)",
          }}>
            {Array.from(line).map((character, localIndex) => {
              const characterIndex = offset + localIndex;
              const highlighted = keywordStart >= 0 && characterIndex >= keywordStart && characterIndex < keywordStart + (keyword?.length ?? 0);
              const delay = Math.min(14, localIndex * (style.id === 1 ? .8 : 1.15) + lineIndex * (style.id === 1 ? 2.2 : 5));
              const charEnter = spring({frame: Math.max(0, frame - delay), fps, config: {damping: highlighted ? 11 : 17, stiffness: highlighted ? 285 : 205, mass: .5}});
              return <span key={`${character}-${characterIndex}`} style={{
                display: "inline-block",
                color: highlighted ? style.accent : undefined,
                opacity: frame >= delay ? charEnter : 0,
                filter: style.id === 2 ? `blur(${(1 - charEnter) * 7}px)` : undefined,
                clipPath: style.id === 1 ? `inset(${(1 - charEnter) * 32}% ${(1 - charEnter) * 20}% 0 0)` : undefined,
                transform: style.id === 1
                  ? `translate(${(1 - charEnter) * 22}px, ${(1 - charEnter) * 14}px) scale(${.9 + charEnter * (highlighted || lineIndex === 1 ? .12 : .1)})`
                  : `translateX(${(1 - charEnter) * -28}px) scale(${.96 + charEnter * .04})`,
                WebkitTextStroke: style.id === 1 && highlighted && lineIndex === 0 ? "4.5px rgba(255,255,255,.98)" : undefined,
                paintOrder: style.id === 1 && highlighted ? "stroke fill" : undefined,
              }}>{character}</span>;
            })}
          </div>;
        })}
      </div>
    </div>;
  }
  return <div style={{
    position: "absolute", top: style.id === 5 ? 1295 : style.id === 8 ? 1305 : 1240,
    left: timeline.theme.captionSafeInset ?? 84, right: timeline.theme.captionSafeInset ?? 84,
    zIndex: 6, display: "flex", flexDirection: "column", alignItems: leftAligned ? "flex-start" : "center",
    textAlign: leftAligned ? "left" : "center", opacity: fadeOut * enter,
    transform: `translate(${translateX}px, ${(1 - enter) * 22}px) rotate(${rotate}deg) scale(${.96 + enter * .04})`,
    fontFamily: style.id === 6 || style.id === 7 ? kineticFontFamily : fontFamily,
  }}>
    <div style={{
      position: "relative", maxWidth: timeline.theme.captionMaxWidth ?? 912,
      padding: panel ? (style.id === 7 ? "13px 23px 17px" : "15px 22px 18px") : "4px 10px 13px",
      background: panel ? style.panel : style.id === 4 ? "rgba(15,12,8,.68)" : "transparent",
      border: style.id === 6 ? `2px solid ${style.accent}` : style.id === 3 ? `1px solid ${style.accent}88` : "none",
      borderLeft: style.id === 7 ? `7px solid ${style.accent}` : undefined,
      borderRadius: style.id === 3 ? 14 : style.id === 6 ? 8 : style.id === 7 ? 2 : 0,
      boxShadow: panel ? "0 13px 32px rgba(0,0,0,.24)" : undefined,
    }}>
      {style.id === 3 ? <div style={{position: "absolute", left: 0, top: 0, width: `${Math.min(100, frame * 5)}%`, height: 3, background: `linear-gradient(90deg,${style.accent},${style.accent2})`}} /> : null}
      {lines.map((line, lineIndex) => {
        const offset = lines.slice(0, lineIndex).reduce((sum, item) => sum + Array.from(item).length, 0);
        return <div key={`${line}-${lineIndex}`} style={{
          display: "flex", justifyContent: leftAligned ? "flex-start" : "center", whiteSpace: "nowrap",
          fontSize: style.id === 4 ? 91 : style.id === 8 ? 72 : 80,
          lineHeight: style.id === 8 ? 1.14 : .99, fontWeight: style.id === 8 ? 720 : 900,
          letterSpacing: style.id === 8 ? 1 : -2,
          color: style.foreground,
          WebkitTextStroke: style.id === 8 ? "2px rgba(0,0,0,.9)" : "3px rgba(0,0,0,.92)",
          paintOrder: "stroke fill",
          textShadow: style.id === 4 ? `4px 5px 0 ${style.accent2}aa, 0 9px 20px rgba(0,0,0,.4)` : "0 7px 15px rgba(0,0,0,.72)",
        }}>
          {Array.from(line).map((character, localIndex) => {
            const characterIndex = offset + localIndex;
            const highlighted = keywordStart >= 0 && characterIndex >= keywordStart && characterIndex < keywordStart + (keyword?.length ?? 0);
            const delay = Math.min(13, localIndex * .72 + lineIndex * 2);
            const charEnter = spring({frame: Math.max(0, frame - delay), fps, config: {damping: 15, stiffness: 220, mass: .5}});
            const color = highlighted ? style.accent : style.foreground;
            return <span key={`${character}-${characterIndex}`} style={{
              display: "inline-block", color: style.id === 8 && highlighted ? "#fffdf8" : color,
              fontWeight: style.id === 8 && highlighted ? 900 : undefined,
              opacity: frame >= delay ? charEnter : 0,
              transform: style.id === 3
                ? `translateX(${(1 - charEnter) * -22}px)`
                : style.id === 4
                  ? `translateY(${(1 - charEnter) * 32}px) scale(${.72 + charEnter * (highlighted ? .38 : .28)})`
                  : style.id === 5
                    ? `translateY(${(1 - charEnter) * 14}px)`
                    : style.id === 6
                      ? `scale(${.9 + charEnter * .1})`
                      : style.id === 7
                        ? `translateX(${(1 - charEnter) * 26 * direction}px)`
                        : style.id === 8 && highlighted
                          ? `translateY(${(1 - charEnter) * 12}px) scale(${.88 + charEnter * .20})`
                          : `translateY(${(1 - charEnter) * 10}px)`,
              background: style.id === 8 && highlighted ? "transparent" : undefined,
              borderBottom: style.id === 8 && highlighted ? "5px solid rgba(255,255,255,.96)" : style.id === 5 && highlighted ? `7px solid ${style.accent}` : undefined,
              paddingBottom: style.id === 8 && highlighted ? 3 : style.id === 5 && highlighted ? 2 : undefined,
              WebkitTextStroke: style.id === 8 && highlighted ? "2px rgba(0,0,0,.92)" : undefined,
              paintOrder: style.id === 8 && highlighted ? "stroke fill" : undefined,
              textShadow: style.id === 8 && highlighted ? "0 6px 13px rgba(0,0,0,.68)" : undefined,
            }}>{character}</span>;
          })}
        </div>;
      })}
      {style.id === 4 ? <div style={{position: "absolute", left: 0, right: 0, bottom: -7, height: 7, background: `linear-gradient(90deg,${style.accent},${style.accent2})`}} /> : null}
      {style.id === 5 ? <div style={{height: 2, marginTop: 8, background: `linear-gradient(90deg,transparent,${style.accent},transparent)`, transform: `scaleX(${enter})`}} /> : null}
    </div>
  </div>;
};

const OpeningTitle: React.FC<{timeline: ViralTimeline}> = ({timeline}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const kinetic = timeline.theme.captionMode === "kinetic-red-white"
    || timeline.theme.captionMode === "kinetic-yellow-white"
    || timeline.theme.captionMode === "kinetic-mint-white"
    || timeline.theme.captionMode === "kinetic-bold-yellow-white";
  const yellowBrush = timeline.theme.captionMode === "kinetic-yellow-white";
  const redEditorial = timeline.theme.rendererKey === "high-red-editorial-v1";
  const mintKnowledge = timeline.theme.rendererKey === "warm-gold-mint-knowledge-v1";
  const boldImpact = timeline.theme.rendererKey === "bold-yellow-white-impact-v1";
  const viralPulse = timeline.theme.rendererKey === "viral-pulse-director-v1";
  const studioStyle = studioStyleFor(timeline.theme.rendererKey);
  const headlineDuration = Math.max(1.2, timeline.theme.headlineDuration ?? 2.6);
  const staggeredPunch = timeline.theme.headlineAnimation === "staggered-punch";
  const entrance = spring({frame, fps, config: {damping: 15, stiffness: 145, mass: .72}});
  const firstFrameCoverActive = frame === 0 && (timeline.coverTime ?? 0) > 0;
  const effectiveEntrance = firstFrameCoverActive ? 1 : entrance;
  const opacity = firstFrameCoverActive
    ? 1
    : timeline.theme.headlinePersistent
    ? interpolate(frame, [0, staggeredPunch ? 3 : 8], [0, 1], {
      easing: Easing.out(Easing.cubic),
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
    : interpolate(frame, [0, 8, fps * Math.max(.8, headlineDuration - .35), fps * headlineDuration], [0, 1, 1, 0], {
      easing: Easing.out(Easing.cubic),
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  const lines = splitOpeningTitle(timeline.title);
  const longestHeadlineLine = Math.max(1, ...lines.map((line) => Array.from(line).length));
  const requestedHeadlineSize = timeline.theme.headlineFontSize ?? (yellowBrush ? 148 : mintKnowledge ? 76 : kinetic ? 92 : 82);
  const headlineFontSize = yellowBrush && staggeredPunch
    ? Math.max(92, Math.min(requestedHeadlineSize, 900 / longestHeadlineLine))
    : requestedHeadlineSize;
  if (studioStyle) {
    return <StudioOpeningTitle timeline={timeline} style={studioStyle} opacity={opacity} entrance={effectiveEntrance} />;
  }
  if (viralPulse) {
    const hasSectionLine = lines.length > 1;
    const sectionLine = hasSectionLine ? lines[0] : "";
    const coreLine = hasSectionLine ? lines[1] : lines[0] ?? timeline.title;
    const coreCharacters = Array.from(coreLine);
    const accentCharacterCount = coreCharacters.length >= 4 ? 2 : 1;
    const accentStart = Math.max(1, coreCharacters.length - accentCharacterCount);
    const coreLead = coreCharacters.slice(0, accentStart).join("");
    const coreAccent = coreCharacters.slice(accentStart).join("");
    const sectionSize = Math.max(38, Math.min(50, 420 / Math.max(4, Array.from(sectionLine).length)));
    const coreSize = Math.max(66, Math.min(88, 650 / Math.max(5, coreCharacters.length)));
    const chipEnter = firstFrameCoverActive ? 1 : spring({
      frame,
      fps,
      config: {damping: 19, stiffness: 170, mass: .68},
    });
    const coreEnter = firstFrameCoverActive ? 1 : spring({
      frame: Math.max(0, frame - 3),
      fps,
      config: {damping: 18, stiffness: 150, mass: .72},
    });
    return (
      <div style={{
        position: "absolute",
        top: timeline.theme.headlineTop ?? 164,
        left: 64,
        right: 64,
        zIndex: 4,
        display: "flex",
        justifyContent: "center",
        opacity,
        transform: `translateY(${(1 - effectiveEntrance) * 24}px) scale(${.96 + effectiveEntrance * .04})`,
        transformOrigin: "center top",
        fontFamily,
      }}>
        <div style={{
          position: "relative",
          minWidth: 540,
          maxWidth: 860,
          padding: "22px 30px 27px 36px",
          overflow: "hidden",
          borderRadius: 22,
          background: "linear-gradient(135deg, rgba(11,11,11,.91) 0%, rgba(16,16,16,.76) 100%)",
          border: "1.5px solid rgba(255,255,255,.22)",
          boxShadow: "0 18px 44px rgba(0,0,0,.38)",
          backdropFilter: "blur(8px)",
        }}>
          <div style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 9,
            background: "#fff300",
          }} />
          {hasSectionLine ? <div style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "5px 17px 8px",
              borderRadius: 7,
              background: "#fff300",
              color: "#11110c",
              fontSize: sectionSize,
              lineHeight: 1,
              fontWeight: 850,
              letterSpacing: .5,
              whiteSpace: "nowrap",
              opacity: chipEnter,
              transform: `translateX(${(1 - chipEnter) * -30}px)`,
            }}>{sectionLine}</div> : null}
          <div style={{
            marginTop: hasSectionLine ? 15 : 0,
            color: "#fffdf7",
            fontSize: coreSize,
            lineHeight: 1.04,
            fontWeight: 900,
            letterSpacing: -2,
            whiteSpace: "nowrap",
            textShadow: "0 5px 16px rgba(0,0,0,.42)",
            opacity: coreEnter,
            transform: `translateY(${(1 - coreEnter) * 18}px)`,
          }}>
            <span>{coreLead}</span>
            <span style={{color: "#fff300"}}>{coreAccent}</span>
          </div>
          <div style={{
            marginTop: 14,
            width: 112 * coreEnter,
            height: 5,
            borderRadius: 99,
            background: "#fff300",
            boxShadow: "126px 0 0 rgba(255,243,0,.24)",
          }} />
        </div>
      </div>
    );
  }
  if (boldImpact) {
    return (
      <div style={{
        position: "absolute",
        top: timeline.theme.headlineTop ?? 172,
        left: 62,
        right: 62,
        zIndex: 4,
        opacity,
        textAlign: "center",
        fontFamily: kineticFontFamily,
        fontSize: Math.max(72, Math.min(headlineFontSize, 900 / longestHeadlineLine)),
        fontWeight: 950,
        fontStyle: "italic",
        lineHeight: .91,
        letterSpacing: -3.2,
        color: "#fffdf7",
        WebkitTextStroke: "3.2px rgba(0,0,0,.98)",
        paintOrder: "stroke fill",
        textShadow: "3px 5px 0 rgba(0,0,0,.96), 0 10px 18px rgba(0,0,0,.4)",
      }}>
        {lines.map((line, index) => {
          const delayedFrame = frame - index * 3;
          const lineEnter = firstFrameCoverActive ? 1 : spring({
            frame: Math.max(0, delayedFrame),
            fps,
            config: {damping: 12, stiffness: 250, mass: .54},
          });
          return (
            <div key={`${line}-${index}`} style={{
              marginTop: index ? (timeline.theme.headlineLineGap ?? -7) : 0,
              opacity: firstFrameCoverActive ? 1 : interpolate(delayedFrame, [0, 3], [0, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"}),
              transform: `translateY(${(1 - lineEnter) * (index ? 24 : -18)}px) scale(${.88 + lineEnter * .12}) rotate(${index ? -.35 : .25}deg)`,
              transformOrigin: "center",
            }}>{line}</div>
          );
        })}
      </div>
    );
  }
  return (
    <div style={{
      position: "absolute",
      top: timeline.theme.titlePosition === "top"
        ? (timeline.theme.headlineTop ?? (yellowBrush ? 102 : 138))
        : 640,
      left: mintKnowledge ? 58 : yellowBrush && staggeredPunch ? 36 : yellowBrush ? 42 : redEditorial ? 72 : 54,
      right: mintKnowledge ? 170 : yellowBrush && staggeredPunch ? 36 : redEditorial ? 72 : 54,
      opacity,
      transform: staggeredPunch
        ? "none"
        : `scale(${.82 + effectiveEntrance * .18}) translateY(${(1 - effectiveEntrance) * 42}px)`,
      transformOrigin: "center",
      textAlign: mintKnowledge ? "left" : yellowBrush && staggeredPunch ? "center" : yellowBrush ? "left" : "center",
      fontFamily: mintKnowledge ? fontFamily : yellowBrush ? brushFontFamily : kinetic ? kineticFontFamily : fontFamily,
      fontWeight: kinetic ? 900 : 950,
      fontSize: headlineFontSize,
      lineHeight: mintKnowledge ? 1.05 : yellowBrush ? .9 : .98,
      letterSpacing: mintKnowledge ? -1.5 : yellowBrush ? -3.2 : -3,
      color: redEditorial ? "#8b1e2d" : "#fffdf7",
      WebkitTextStroke: mintKnowledge
        ? "2px rgba(1,27,25,.94)"
        : yellowBrush
        ? "1.8px rgba(0,0,0,.76)"
        : redEditorial
          ? "5px rgba(255,252,244,.98)"
          : kinetic ? "4px rgba(16,9,8,.96)" : "6px rgba(0,0,0,.88)",
      paintOrder: "stroke fill",
      textShadow: mintKnowledge
        ? "0 4px 2px rgba(0,0,0,.92), 0 9px 18px rgba(0,0,0,.46)"
        : yellowBrush
        ? "0 4px 3px rgba(0,0,0,.88), 5px 8px 10px rgba(0,0,0,.68)"
        : redEditorial
        ? "2px 5px 0 rgba(41,8,12,.95), 0 12px 24px rgba(0,0,0,.34)"
        : kinetic
        ? "7px 7px 0 #7f1f28, 0 14px 28px rgba(0,0,0,.48)"
        : `0 8px 0 ${timeline.theme.accent}, 0 20px 35px rgba(0,0,0,.42)`,
    }}>
      {lines.map((line, index) => {
        const delayedFrame = frame - index * 3;
        const lineEnter = firstFrameCoverActive
          ? 1
          : spring({
            frame: Math.max(0, delayedFrame),
            fps,
            config: {damping: 16, stiffness: index ? 210 : 185, mass: .62},
          });
        const lineOpacity = staggeredPunch
          ? firstFrameCoverActive
            ? 1
            : interpolate(delayedFrame, [0, 3], [0, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"})
          : 1;
        const baseOffset = yellowBrush ? index * 12 : 0;
        const baseRotation = yellowBrush ? (index ? -.45 : .25) : 0;
        const animatedTranslate = staggeredPunch ? (1 - lineEnter) * (index ? 24 : -14) : 0;
        const animatedScale = staggeredPunch ? .9 + lineEnter * .1 : 1;
        return <div key={`${line}-${index}`} style={{
          marginTop: index ? (timeline.theme.headlineLineGap ?? -8) : 0,
          fontSize: mintKnowledge
            ? (index === 0 ? headlineFontSize : Math.round(headlineFontSize * .70))
            : undefined,
          color: mintKnowledge
            ? (index === 0 ? "#71efd0" : "#fffefa")
            : yellowBrush
            ? (index === lines.length - 1 ? "#fff36a" : "#fffefa")
            : redEditorial
              ? (index === lines.length - 1 ? "#8b1e2d" : "#fffdf8")
              : kinetic ? "#fffdf7" : index === lines.length - 1 ? timeline.theme.accent : timeline.theme.foreground,
          WebkitTextStroke: mintKnowledge
            ? (index === 0 ? "2px rgba(3,41,37,.95)" : "2px rgba(0,0,0,.92)")
            : redEditorial
            ? (index === lines.length - 1
              ? "5px rgba(255,252,244,.98)"
              : "4px rgba(61,13,17,.98)")
            : undefined,
          textShadow: mintKnowledge
            ? "0 4px 2px rgba(0,0,0,.94), 0 10px 20px rgba(0,0,0,.4)"
            : redEditorial
            ? (index === lines.length - 1
              ? "2px 5px 0 rgba(41,8,12,.95), 0 12px 24px rgba(0,0,0,.34)"
              : "2px 5px 0 rgba(118,19,34,.96), 0 12px 24px rgba(0,0,0,.42)")
            : undefined,
          opacity: lineOpacity,
          transform: `translateX(${baseOffset}px) translateY(${animatedTranslate}px) rotate(${baseRotation}deg) scale(${animatedScale})`,
          transformOrigin: "center",
        }}>{line}</div>;
      })}
    </div>
  );
};

const Subtitle: React.FC<{caption: CaptionCue; timeline: ViralTimeline}> = ({caption, timeline}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  // A component rendered inside Sequence receives a frame relative to that
  // sequence. Subtracting the cue start again made every cue after the first
  // stay transparent.
  const localFrame = frame;
  const absoluteTime = caption.start + frame / fps;
  const enter = spring({frame: localFrame, fps, config: {damping: 18, stiffness: 180, mass: .65}});
  const words = useMemo(() => normalizeWords(caption), [caption]);
  return (
    <div style={{
      position: "absolute",
      left: 54,
      right: 54,
      top: timeline.theme.subtitlePosition === "middle" ? 1360 : undefined,
      bottom: timeline.theme.subtitlePosition === "bottom" ? 170 : undefined,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 12,
      opacity: interpolate(localFrame, [0, 4], [0, 1], {extrapolateRight: "clamp"}),
      transform: `translateY(${(1 - enter) * 26}px) scale(${.93 + enter * .07})`,
      fontFamily,
      textAlign: "center",
    }}>
      <div style={{
        maxWidth: 940,
        padding: "10px 18px 14px",
        fontSize: 72,
        lineHeight: 1.16,
        fontWeight: 950,
        letterSpacing: 1,
        color: timeline.theme.foreground,
        WebkitTextStroke: "5px rgba(0,0,0,.92)",
        paintOrder: "stroke fill",
        filter: "drop-shadow(0 8px 12px rgba(0,0,0,.4))",
      }}>
        {words.map((word, index) => {
          const active = word.highlight || (absoluteTime >= word.start && absoluteTime <= word.end);
          return <span key={`${word.text}-${index}`} style={{color: active ? timeline.theme.accent : timeline.theme.foreground}}>{word.text}</span>;
        })}
      </div>
      {caption.translation ? <div style={{padding: "7px 16px", borderRadius: 999, background: "rgba(0,0,0,.48)", color: "#f1f3f2", fontSize: 28, fontWeight: 700, letterSpacing: .4}}>{caption.translation}</div> : null}
    </div>
  );
};

const KineticSubtitle: React.FC<{caption: CaptionCue; timeline: ViralTimeline; index: number}> = ({caption, timeline, index}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const durationFrames = Math.max(1, secondsToFrames((caption.displayEnd ?? caption.end) - caption.start, fps));
  const progress = Math.min(1, Math.max(0, frame / durationFrames));
  const {groups, keyword} = useMemo(() => kineticGroups(caption), [caption]);
  const layout = caption.layout ?? (["center", "split", "stack-left", "stack-right", "impact"] as const)[index % 5];
  const accent = timeline.theme.keywordColor ?? "#a51f2b";
  const yellowBrush = timeline.theme.captionMode === "kinetic-yellow-white";
  const redEditorial = timeline.theme.rendererKey === "high-red-editorial-v1";
  const mintKnowledge = timeline.theme.rendererKey === "warm-gold-mint-knowledge-v1";
  const boldImpact = timeline.theme.rendererKey === "bold-yellow-white-impact-v1";
  if (boldImpact) {
    const compact = caption.text.replace(/\s+/g, "").trim();
    const keywordStart = keyword ? compact.indexOf(keyword) : -1;
    const lineMaxChars = Math.max(5, Math.min(8, timeline.theme.captionLineMaxChars ?? 8));
    const captionLines = adaptiveCaptionLines(caption, compact, lineMaxChars);
    const fadeOutStart = Math.max(4, durationFrames - 6);
    const opacity = durationFrames <= 8
      ? 1
      : interpolate(frame, [0, 3, fadeOutStart, durationFrames], [0, 1, 1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
    const enter = spring({frame, fps, config: {damping: 12, stiffness: 255, mass: .52}});
    const wholePhraseYellow = caption.role === "focus" || compact.length <= 4;
    return (
      <div style={{
        position: "absolute",
        top: 1218 + (index % 2) * 42,
        left: timeline.theme.captionSafeInset ?? 104,
        right: timeline.theme.captionSafeInset ?? 104,
        zIndex: 5,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        opacity,
        transform: `translateY(${(1 - enter) * 28}px) scale(${.82 + enter * .18}) rotate(${index % 2 ? -.7 : .55}deg)`,
        transformOrigin: "center bottom",
      }}>
        {captionLines.map((line, lineIndex) => {
          const offset = captionLines.slice(0, lineIndex).reduce((sum, item) => sum + Array.from(item).length, 0);
          return (
            <div key={`${line}-${lineIndex}`} style={{
              maxWidth: timeline.theme.captionMaxWidth ?? 872,
              whiteSpace: "nowrap",
              fontFamily: kineticFontFamily,
              fontSize: captionLines.length > 1 ? 82 : compact.length <= 5 ? 106 : 94,
              lineHeight: .91,
              fontWeight: 950,
              fontStyle: "italic",
              letterSpacing: -2.4,
              color: wholePhraseYellow ? "#fff300" : "#fffdf7",
              WebkitTextStroke: "5px rgba(0,0,0,.98)",
              paintOrder: "stroke fill",
              textShadow: "4px 7px 0 rgba(0,0,0,.96), 0 12px 20px rgba(0,0,0,.42)",
            }}>
              {Array.from(line).map((character, localIndex) => {
                const characterIndex = offset + localIndex;
                const highlighted = wholePhraseYellow || (keywordStart >= 0
                  && characterIndex >= keywordStart
                  && characterIndex < keywordStart + (keyword?.length ?? 0));
                const delay = Math.min(9, localIndex * .75 + lineIndex * 1.8);
                const characterEnter = spring({
                  frame: Math.max(0, frame - delay),
                  fps,
                  config: {damping: highlighted ? 11 : 16, stiffness: highlighted ? 275 : 205, mass: .48},
                });
                return (
                  <span key={`${character}-${characterIndex}`} style={{
                    display: "inline-block",
                    color: highlighted ? "#fff300" : "#fffdf7",
                    opacity: frame >= delay ? characterEnter : 0,
                    transform: `translateY(${(1 - characterEnter) * 18}px) scale(${highlighted ? .84 + characterEnter * .2 : .9 + characterEnter * .1})`,
                    transformOrigin: "center bottom",
                  }}>{character}</span>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  }
  if (mintKnowledge) {
    const compact = caption.text.replace(/\s+/g, "").trim();
    const keywordStart = keyword ? compact.indexOf(keyword) : -1;
    const lineMaxChars = Math.max(5, Math.min(10, timeline.theme.captionLineMaxChars ?? 9));
    const captionLines = adaptiveCaptionLines(caption, compact, lineMaxChars);
    const durationFramesSafe = Math.max(1, durationFrames);
    const revealFrames = Math.max(6, Math.min(Math.round(fps * .62), durationFramesSafe - 2));
    const visibleCharacters = Math.ceil(interpolate(
      frame,
      [0, revealFrames],
      [0, Array.from(compact).length],
      {extrapolateLeft: "clamp", extrapolateRight: "clamp"},
    ));
    const opacity = durationFramesSafe <= 8
      ? 1
      : interpolate(frame, [0, 3, Math.max(4, durationFramesSafe - 6), durationFramesSafe], [0, 1, 1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
    const enter = spring({frame, fps, config: {damping: 22, stiffness: 190, mass: .68}});
    const caretVisible = frame <= revealFrames + 5 && Math.floor(frame / 4) % 2 === 0;
    return (
      <div style={{
        position: "absolute",
        top: 1260,
        left: timeline.theme.captionSafeInset ?? 112,
        right: timeline.theme.captionSafeInset ?? 112,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        opacity,
        transform: `translateY(${(1 - enter) * 14}px) scale(${.985 + enter * .015})`,
      }}>
        <div style={{
          maxWidth: timeline.theme.captionMaxWidth ?? 836,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 1,
        }}>
          {captionLines.map((line, lineIndex) => {
            const offset = captionLines.slice(0, lineIndex).reduce((sum, item) => sum + Array.from(item).length, 0);
            return (
              <div key={`${line}-${lineIndex}`} style={{
                minHeight: 73,
                display: "flex",
                justifyContent: "center",
                alignItems: "baseline",
                whiteSpace: "nowrap",
                fontFamily: kineticFontFamily,
                fontSize: captionLines.length > 1 ? 86 : 98,
                lineHeight: .98,
                fontWeight: 900,
                letterSpacing: -1.6,
                color: "#fffefa",
                WebkitTextStroke: "3px rgba(0,0,0,.94)",
                paintOrder: "stroke fill",
                textShadow: "0 4px 2px rgba(0,0,0,.98), 0 8px 14px rgba(0,0,0,.56)",
              }}>
                {Array.from(line).map((character, localIndex) => {
                  const characterIndex = offset + localIndex;
                  if (characterIndex >= visibleCharacters) return null;
                  const highlighted = keywordStart >= 0
                    && characterIndex >= keywordStart
                    && characterIndex < keywordStart + (keyword?.length ?? 0);
                  return (
                    <span key={`${character}-${characterIndex}`} style={{
                      display: "inline-block",
                      color: highlighted ? accent : "#fffefa",
                    }}>{character}</span>
                  );
                })}
                {caretVisible && visibleCharacters >= offset && visibleCharacters <= offset + Array.from(line).length ? (
                  <span style={{marginLeft: 3, color: accent, fontFamily, fontSize: 62, WebkitTextStroke: "0 transparent"}}>▌</span>
                ) : null}
              </div>
            );
          })}
        </div>
        {caption.translation ? (
          <div style={{
            marginTop: 3,
            maxWidth: timeline.theme.captionMaxWidth ?? 836,
            color: "rgba(255,255,255,.94)",
            fontFamily: englishSerifFontFamily,
            fontSize: 36,
            lineHeight: 1,
            fontWeight: 700,
            letterSpacing: .1,
            WebkitTextStroke: ".7px rgba(0,0,0,.9)",
            paintOrder: "stroke fill",
            textShadow: "0 3px 5px rgba(0,0,0,.94)",
            opacity: interpolate(frame, [5, 10], [0, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"}),
          }}>{caption.translation}</div>
        ) : null}
      </div>
    );
  }
  if (yellowBrush) {
    const compact = caption.text.replace(/\s+/g, "").trim();
    const role = caption.role ?? (index % 2 === 0 ? "anchor" : "focus");
    const isAnchor = role === "anchor";
    const keywordStart = keyword ? compact.indexOf(keyword) : -1;
    const fadeOutStart = Math.max(8, durationFrames - 7);
    const opacity = interpolate(frame, [0, 4, fadeOutStart, durationFrames], [0, 1, 1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    const rise = spring({frame, fps, config: {damping: 20, stiffness: 165, mass: .7}});
    // The reference keeps each Chinese/English pair very tight, and leaves only
    // about 26px of clear space before the second bilingual pair begins.
    const top = isAnchor ? 1218 : 1366;
    const safeInset = timeline.theme.captionSafeInset ?? 96;
    const captionMaxWidth = timeline.theme.captionMaxWidth ?? 888;
    const lineMaxChars = timeline.theme.captionLineMaxChars ?? 8;
    const captionLines = adaptiveCaptionLines(caption, compact, lineMaxChars);
    return (
      <>
        {caption.sectionEmphasis && !timeline.theme.headlinePersistent ? (
          <div style={{
            position: "absolute",
            top: 150,
            left: 38,
            right: 38,
            textAlign: "center",
            fontFamily: brushFontFamily,
            fontSize: 136,
            lineHeight: .92,
            fontWeight: 900,
            letterSpacing: -5,
            color: "rgba(255,255,255,.075)",
            WebkitTextStroke: "1px rgba(255,255,255,.09)",
            transform: `scale(${.94 + rise * .06})`,
            opacity: opacity * .9,
          }}>{compact}</div>
        ) : null}
        <div style={{
          position: "absolute",
          top,
          left: safeInset,
          right: safeInset,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          opacity,
          transform: `translateY(${(1 - rise) * 24}px) scale(${.97 + rise * .03})`,
          transformOrigin: "center bottom",
        }}>
          <div style={{
            maxWidth: captionMaxWidth,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 1,
          }}>
            {captionLines.map((line, lineIndex) => {
              const characterOffset = captionLines.slice(0, lineIndex).reduce((sum, item) => sum + Array.from(item).length, 0);
              return <div key={`${line}-${lineIndex}`} style={{
            display: "flex",
            justifyContent: "center",
            flexWrap: "wrap",
            fontFamily: brushFontFamily,
            fontSize: isAnchor ? 84 : 90,
            lineHeight: .96,
            fontWeight: 900,
            letterSpacing: -1.8,
            color: "#fffdf7",
            WebkitTextStroke: "1.5px rgba(0,0,0,.86)",
            paintOrder: "stroke fill",
            textShadow: "0 4px 3px rgba(0,0,0,.98), 5px 7px 10px rgba(0,0,0,.72)",
          }}>
            {Array.from(compact).map((character, characterIndex) => {
              if (characterIndex < characterOffset || characterIndex >= characterOffset + Array.from(line).length) return null;
              const delay = Math.min(12, characterIndex * 1.35);
              const characterEnter = spring({
                frame: Math.max(0, frame - delay),
                fps,
                config: {damping: 20, stiffness: 185, mass: .62},
              });
              const highlighted = keywordStart >= 0
                && characterIndex >= keywordStart
                && characterIndex < keywordStart + (keyword?.length ?? 0);
              return (
                <span key={`${character}-${characterIndex}`} style={{
                  display: "inline-block",
                  color: highlighted ? accent : "#fffdf7",
                  opacity: frame >= delay ? characterEnter : 0,
                  transform: `translateY(${(1 - characterEnter) * 16}px) scale(${.9 + characterEnter * .1})`,
                }}>{character}</span>
              );
            })}
          </div>;
            })}
          </div>
          {caption.translation ? (
            <div style={{
              marginTop: 1,
              maxWidth: captionMaxWidth,
              color: "rgba(255,255,255,.96)",
              fontFamily: englishSerifFontFamily,
              fontSize: isAnchor ? 34 : 36,
              lineHeight: 1,
              fontWeight: 700,
              letterSpacing: .15,
              WebkitTextStroke: ".65px rgba(0,0,0,.82)",
              paintOrder: "stroke fill",
              textShadow: "0 3px 5px rgba(0,0,0,.94)",
              opacity: interpolate(frame, [4, 9], [0, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"}),
            }}>{caption.translation}</div>
          ) : null}
        </div>
      </>
    );
  }
  if (redEditorial) {
    const compact = caption.text.replace(/\s+/g, "").trim();
    const role = caption.role ?? (index % 2 === 0 ? "anchor" : "focus");
    const isAnchor = role === "anchor";
    const pairIndex = Math.floor(index / 2);
    const reversed = pairIndex % 3 === 1;
    const centered = pairIndex % 3 === 2;
    const keywordStart = keyword ? compact.indexOf(keyword) : -1;
    const lineMaxChars = Math.max(5, Math.min(9, timeline.theme.captionLineMaxChars ?? 8));
    const captionLines = adaptiveCaptionLines(caption, compact, lineMaxChars);
    const fadeOutStart = Math.max(8, durationFrames - 6);
    const opacity = interpolate(frame, [0, 4, fadeOutStart, durationFrames], [0, 1, 1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    const enter = spring({frame, fps, config: {damping: 16, stiffness: 205, mass: .62}});
    const top = centered ? (isAnchor ? 1210 : 1375) : isAnchor ? 1168 : 1372;
    const left = centered ? 74 : reversed ? (isAnchor ? 240 : 60) : (isAnchor ? 60 : 250);
    const right = centered ? 74 : reversed ? (isAnchor ? 54 : 230) : (isAnchor ? 230 : 54);
    const alignItems = centered ? "center" : reversed ? (isAnchor ? "flex-end" : "flex-start") : (isAnchor ? "flex-start" : "flex-end");
    const textAlign = centered ? "center" : reversed ? (isAnchor ? "right" : "left") : (isAnchor ? "left" : "right");
    const editorialLabel = splitOpeningTitle(timeline.title).slice(-1)[0]?.slice(0, 6) || keyword || "核心观点";
    return (
      <>
        {index === 0 ? (
          <div style={{
            position: "absolute",
            top: 905,
            left: 64,
            opacity,
            transform: `translateX(${(1 - enter) * -22}px) scale(${.94 + enter * .06})`,
            fontFamily: kineticFontFamily,
            fontSize: 54,
            lineHeight: 1,
            fontWeight: 900,
            letterSpacing: -1,
            color: accent,
            WebkitTextStroke: "3px rgba(255,252,246,.98)",
            paintOrder: "stroke fill",
            textShadow: "2px 4px 0 rgba(42,8,12,.82)",
          }}>“ {editorialLabel} ”</div>
        ) : null}
        <div style={{
          position: "absolute",
          top,
          left,
          right,
          display: "flex",
          flexDirection: "column",
          alignItems,
          textAlign,
          opacity,
          transform: `translateY(${(1 - enter) * 24}px) scale(${.95 + enter * .05})`,
          transformOrigin: isAnchor ? "left bottom" : "right bottom",
        }}>
          <div style={{
            maxWidth: timeline.theme.captionMaxWidth ?? 850,
            display: "flex",
            flexDirection: "column",
            alignItems,
            gap: 0,
          }}>
            {captionLines.map((line, lineIndex) => {
              const lineCharacters = Array.from(line);
              const characterOffset = captionLines.slice(0, lineIndex).reduce((sum, item) => sum + Array.from(item).length, 0);
              return (
                <div key={`${line}-${lineIndex}`} style={{
                  display: "flex",
                  flexWrap: "nowrap",
                  justifyContent: centered ? "center" : reversed ? (isAnchor ? "flex-end" : "flex-start") : (isAnchor ? "flex-start" : "flex-end"),
                  fontFamily: kineticFontFamily,
                  fontSize: captionLines.length > 1 ? 72 : isAnchor ? 82 : 88,
                  lineHeight: .98,
                  fontWeight: 900,
                  letterSpacing: -2.5,
                }}>
                  {lineCharacters.map((character, localIndex) => {
                    const characterIndex = characterOffset + localIndex;
                    const highlighted = keywordStart >= 0
                      && characterIndex >= keywordStart
                      && characterIndex < keywordStart + (keyword?.length ?? 0);
                    const delay = Math.min(10, localIndex * .9 + lineIndex * 2);
                    const characterEnter = spring({
                      frame: Math.max(0, frame - delay),
                      fps,
                      config: {damping: highlighted ? 12 : 18, stiffness: highlighted ? 260 : 190, mass: highlighted ? .48 : .62},
                    });
                    return (
                      <span key={`${character}-${characterIndex}`} style={{
                        display: "inline-block",
                        color: highlighted ? accent : "#fffdf8",
                        WebkitTextStroke: highlighted
                          ? "4px rgba(255,253,248,.99)"
                          : "3px rgba(27,10,9,.96)",
                        paintOrder: "stroke fill",
                        textShadow: highlighted
                          ? "3px 5px 0 rgba(56,7,15,.82), 0 8px 14px rgba(0,0,0,.34)"
                          : "2px 4px 0 rgba(0,0,0,.88), 0 8px 14px rgba(0,0,0,.3)",
                        opacity: frame >= delay ? characterEnter : 0,
                        transform: `translateY(${(1 - characterEnter) * 20}px) scale(${highlighted ? .84 + characterEnter * .22 : .9 + characterEnter * .1})`,
                        transformOrigin: "center bottom",
                      }}>{character}</span>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {caption.translation ? (
            <div style={{
              marginTop: 5,
              maxWidth: 780,
              color: "rgba(255,255,255,.97)",
              fontFamily: englishSerifFontFamily,
              fontSize: 31,
              lineHeight: 1,
              fontWeight: 700,
              letterSpacing: .15,
              WebkitTextStroke: "1px rgba(0,0,0,.9)",
              paintOrder: "stroke fill",
              textShadow: "0 3px 5px rgba(0,0,0,.95)",
              opacity: interpolate(frame, [5, 10], [0, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"}),
            }}>{caption.translation}</div>
          ) : null}
        </div>
      </>
    );
  }
  const align = layout === "stack-left" ? "flex-start" : layout === "stack-right" ? "flex-end" : "center";
  const textAlign = layout === "stack-left" ? "left" : layout === "stack-right" ? "right" : "center";
  const y = layout === "impact" ? 1250 : layout === "split" ? 1305 : 1335;
  const settle = spring({frame, fps, config: {damping: 19, stiffness: 175, mass: .66}});
  const visibleUntil = durationFrames * (index % 3 === 1 ? .72 : .84);
  const cueOpacity = yellowBrush
    ? interpolate(frame, [0, 4, visibleUntil, Math.min(durationFrames, visibleUntil + 7)], [0, 1, 1, 0], {extrapolateLeft: "clamp", extrapolateRight: "clamp"})
    : 1;
  return (
    <div style={{
      position: "absolute",
      left: 58,
      right: 58,
      top: y,
      display: "flex",
      flexDirection: "column",
      alignItems: align,
      fontFamily: yellowBrush ? brushFontFamily : kineticFontFamily,
      textAlign,
      opacity: cueOpacity,
      transform: `translateY(${(1 - settle) * 22}px)`,
    }}>
      <div style={{
        width: "100%",
        minHeight: 126,
        display: "flex",
        flexWrap: "wrap",
        justifyContent: align === "flex-start" ? "flex-start" : align === "flex-end" ? "flex-end" : "center",
        alignItems: "baseline",
        columnGap: layout === "split" && progress < .56 ? 112 : 4,
        rowGap: 0,
        fontSize: layout === "impact" ? 94 : 76,
        lineHeight: 1.06,
        fontWeight: 900,
        letterSpacing: -1,
        color: "#fffdf7",
      }}>
        {groups.map((group, groupIndex) => {
          const delay = groupIndex * Math.max(3, Math.floor(durationFrames * .12));
          const enter = spring({frame: Math.max(0, frame - delay), fps, config: {damping: 16, stiffness: 210, mass: .58}});
          const visible = frame >= delay;
          const isKeyword = Boolean(keyword && group === keyword);
          const splitOffset = layout === "split" && progress < .56
            ? (groupIndex - (groups.length - 1) / 2) * 70
            : 0;
          const alternatingY = layout === "split" && progress < .56 ? (groupIndex % 2 ? 30 : -18) : 0;
          const impactScale = isKeyword ? 1.15 : 1;
          return (
            <span key={`${group}-${groupIndex}`} style={{
              display: "inline-block",
              opacity: visible ? enter : 0,
              color: isKeyword ? accent : "#fffdf7",
              fontSize: isKeyword ? "1.12em" : "1em",
              transform: `translate(${splitOffset * (1 - enter)}px, ${alternatingY * (1 - enter)}px) scale(${(.72 + enter * .28) * impactScale})`,
              transformOrigin: "center bottom",
              WebkitTextStroke: "4px rgba(18,9,8,.96)",
              paintOrder: "stroke fill",
              textShadow: isKeyword
                ? "5px 5px 0 rgba(105,11,22,.8), 0 10px 24px rgba(0,0,0,.38)"
                : "3px 4px 0 rgba(0,0,0,.72), 0 10px 22px rgba(0,0,0,.34)",
            }}>{group}</span>
          );
        })}
      </div>
      {caption.translation ? (
        <div style={{
          marginTop: 4,
          maxWidth: 900,
          color: "rgba(255,255,255,.92)",
          fontFamily,
          fontSize: 30,
          lineHeight: 1.1,
          fontWeight: 700,
          letterSpacing: .2,
          textShadow: "0 3px 6px rgba(0,0,0,.9)",
          opacity: interpolate(frame, [4, 10], [0, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"}),
        }}>{caption.translation}</div>
      ) : null}
    </div>
  );
};

const ViralPulseSubtitle: React.FC<{caption: CaptionCue; timeline: ViralTimeline; index: number}> = ({caption, timeline, index}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const durationFrames = Math.max(1, secondsToFrames((caption.displayEnd ?? caption.end) - caption.start, fps));
  const compact = compactCaptionText(caption.text);
  const keyword = resolvedKeyword(caption, compact);
  const keywordStart = keyword ? compact.indexOf(keyword) : -1;
  const role = caption.semanticRole ?? "steady";
  const node = caption.contentNode ?? "supporting";
  const animation = caption.animation ?? "steady";
  const captionStyle = caption.captionStyle ?? caption.materialRoute?.caption ?? "supporting-clean";
  const softRoseTemplate = timeline.theme.rendererKey === "template-2-soft-rose-v1";
  const a080TwoRow04 = softRoseTemplate && captionStyle === "a080-two-row-04";
  const a080TwoRow05 = softRoseTemplate && captionStyle === "a080-two-row-05";
  const a080TwoRow = a080TwoRow04 || a080TwoRow05;
  const accent = a080TwoRow04 ? "#ff287f" : a080TwoRow05 ? "#d75c92" : timeline.theme.keywordColor ?? "#fff300";
  const lineMax = Math.max(6, Math.min(9, timeline.theme.captionLineMaxChars ?? 8));
  const lines = a080TwoRow ? splitTwoRowCaption(compact, keyword) : splitCaptionLines(compact, lineMax);
  const enter = spring({
    frame,
    fps,
    config: animation === "hook-slam"
      ? {damping: 10, stiffness: 320, mass: .5}
      : animation === "steady"
        ? {damping: 24, stiffness: 150, mass: .72}
        : {damping: 14, stiffness: 230, mass: .56},
  });
  const fadeOut = interpolate(frame, [Math.max(4, durationFrames - 7), durationFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const strong = animation !== "steady";
  const baseTop = a080TwoRow ? 1205 : animation === "step-card" ? 1160 : animation === "hook-slam" ? 1210 : animation === "brand-tag" ? 1240 : 1270;
  const direction = index % 2 === 0 ? -1 : 1;
  const translateX = animation === "reversal-swap" ? (1 - enter) * 90 * direction : animation === "cta-push" ? (1 - enter) * 120 : 0;
  const translateY = animation === "conclusion-stamp" ? (1 - enter) * -42 : (1 - enter) * (strong ? 30 : 14);
  const rotation = animation === "conclusion-stamp" ? (1 - enter) * -8 : animation === "hook-slam" ? (1 - enter) * 2.4 : 0;
  const scale = animation === "hook-slam" ? .68 + enter * .32 : animation === "keyword-hit" || animation === "number-count" ? .82 + enter * .18 : .96 + enter * .04;
  const revealCount = animation === "steady"
    ? Math.ceil(interpolate(frame, [0, Math.min(durationFrames - 1, Math.round(fps * .32))], [0, Array.from(compact).length], {extrapolateLeft: "clamp", extrapolateRight: "clamp"}))
    : Array.from(compact).length;
  return (
    <div style={{
      position: "absolute",
      top: baseTop,
      left: timeline.theme.captionSafeInset ?? 92,
      right: timeline.theme.captionSafeInset ?? 92,
      zIndex: 6,
      display: "flex",
      flexDirection: "column",
      alignItems: a080TwoRow ? "center" : animation === "reversal-swap" ? (direction < 0 ? "flex-start" : "flex-end") : "center",
      textAlign: a080TwoRow ? "center" : animation === "reversal-swap" ? (direction < 0 ? "left" : "right") : "center",
      opacity: fadeOut,
      transform: `translate(${translateX}px, ${translateY}px) rotate(${rotation}deg) scale(${scale})`,
      transformOrigin: "center bottom",
      fontFamily,
    }}>
      {animation === "step-card" ? (
        <div style={{marginBottom: 12, padding: "7px 16px", borderRadius: 999, background: accent, color: "#111", fontSize: 28, fontWeight: 950, letterSpacing: 2}}>
          STEP {String(caption.stepNumber ?? 1).padStart(2, "0")}
        </div>
      ) : null}
      {animation === "brand-tag" ? (
        <div style={{marginBottom: 11, padding: "6px 15px", borderRadius: 10, background: "rgba(0,0,0,.72)", border: `2px solid ${accent}`, color: accent, fontSize: 25, fontWeight: 950, letterSpacing: 3}}>
          {node === "brand_entity" ? "品牌 / 人物 / 产品" : "信息主体"}
        </div>
      ) : null}
      <div style={{
        maxWidth: timeline.theme.captionMaxWidth ?? 896,
        padding: animation === "conclusion-stamp" ? "12px 24px 16px" : animation === "brand-tag" ? "10px 22px 13px" : "0",
        border: animation === "conclusion-stamp" ? `4px solid ${accent}` : animation === "brand-tag" ? "2px solid rgba(255,255,255,.82)" : "none",
        borderRadius: animation === "conclusion-stamp" ? 16 : animation === "brand-tag" ? 14 : 0,
        background: animation === "conclusion-stamp" ? "rgba(0,0,0,.7)" : animation === "brand-tag" ? "rgba(0,0,0,.56)" : "transparent",
      }}>
        {lines.map((line, lineIndex) => {
          const offset = lines.slice(0, lineIndex).reduce((sum, item) => sum + Array.from(item).length, 0);
          return (
            <div key={`${line}-${lineIndex}`} style={{
              display: "flex",
              justifyContent: a080TwoRow
                ? (lineIndex % 2 === 0 ? "flex-start" : "flex-end")
                : animation === "reversal-swap" ? (direction < 0 ? "flex-start" : "flex-end") : "center",
              whiteSpace: "nowrap",
              minWidth: a080TwoRow ? 650 : undefined,
              paddingLeft: a080TwoRow && lineIndex % 2 === 0 ? 12 : 0,
              paddingRight: a080TwoRow && lineIndex % 2 === 1 ? 12 : 0,
              fontSize: a080TwoRow04 ? (lineIndex === 0 ? 82 : 94) : a080TwoRow05 ? (lineIndex === 0 ? 78 : 88) : animation === "hook-slam" ? 104 : animation === "number-count" ? 98 : animation === "brand-tag" ? 82 : strong ? 88 : 76,
              lineHeight: a080TwoRow ? .94 : .98,
              fontWeight: a080TwoRow05 ? 850 : 950,
              letterSpacing: a080TwoRow ? -1 : strong ? -2.4 : -1.4,
              color: a080TwoRow05 && lineIndex === 0 ? "#efd2e0" : "#fffdf7",
              WebkitTextStroke: a080TwoRow05 ? "3px rgba(0,0,0,.92)" : a080TwoRow04 ? "2px rgba(0,0,0,.9)" : "4px rgba(0,0,0,.96)",
              paintOrder: "stroke fill",
              textShadow: a080TwoRow05
                ? "0 6px 18px rgba(0,0,0,.78)"
                : a080TwoRow04
                  ? "3px 5px 0 rgba(0,0,0,.78), 0 12px 22px rgba(0,0,0,.42)"
                  : strong ? `4px 6px 0 rgba(0,0,0,.92), 0 12px 22px rgba(0,0,0,.42)` : "0 6px 12px rgba(0,0,0,.92)",
            }}>
              {Array.from(line).map((character, localIndex) => {
                const characterIndex = offset + localIndex;
                if (characterIndex >= revealCount) return null;
                const highlighted = keywordStart >= 0 && characterIndex >= keywordStart && characterIndex < keywordStart + (keyword?.length ?? 0);
                const numeric = /[0-9一二三四五六七八九十百千万%折元]/.test(character);
                const emphasized = highlighted || (animation === "number-count" && numeric);
                const delay = a080TwoRow
                  ? Math.min(14, localIndex * (a080TwoRow05 ? 1.2 : .78) + lineIndex * (a080TwoRow05 ? 5 : 2.4))
                  : animation === "steady" ? 0 : Math.min(10, localIndex * .65 + lineIndex * 1.6);
                const charEnter = spring({frame: Math.max(0, frame - delay), fps, config: {damping: emphasized ? 10 : 17, stiffness: emphasized ? 300 : 210, mass: .48}});
                const a080Color = a080TwoRow04
                  ? (emphasized || lineIndex === 1 ? accent : "#fffdf7")
                  : a080TwoRow05
                    ? (emphasized ? accent : lineIndex === 0 ? "#efd2e0" : "#fffdf7")
                    : emphasized ? accent : "#fffdf7";
                const a080TranslateX = a080TwoRow04 ? (1 - charEnter) * 34 : a080TwoRow05 ? (1 - charEnter) * -26 : 0;
                const a080TranslateY = a080TwoRow04 ? (1 - charEnter) * 24 : a080TwoRow05 ? (1 - charEnter) * 12 : (1 - charEnter) * (emphasized ? 24 : 13);
                const a080Scale = a080TwoRow04 && (emphasized || lineIndex === 1)
                  ? .74 + charEnter * .32
                  : a080TwoRow05 ? .96 + charEnter * .04 : emphasized ? .72 + charEnter * .36 : .9 + charEnter * .1;
                return (
                  <span key={`${character}-${characterIndex}`} style={{
                    display: "inline-block",
                    color: a080Color,
                    opacity: frame >= delay ? charEnter : 0,
                    filter: a080TwoRow05 ? `blur(${(1 - charEnter) * 8}px)` : undefined,
                    clipPath: a080TwoRow04 ? `inset(${(1 - charEnter) * 55}% ${(1 - charEnter) * 45}% 0 0)` : undefined,
                    fontFamily: a080TwoRow04 && (emphasized || lineIndex === 1) ? brushFontFamily : a080TwoRow ? kineticFontFamily : undefined,
                    transform: `translate(${a080TranslateX}px, ${a080TranslateY}px) scale(${a080Scale})`,
                    transformOrigin: "center bottom",
                  }}>{character}</span>
                );
              })}
            </div>
          );
        })}
      </div>
      {animation === "cta-push" ? <div style={{marginTop: 15, color: accent, fontSize: 38, fontWeight: 950, letterSpacing: 5, opacity: enter}}>马上行动 →</div> : null}
    </div>
  );
};

const ChapterBadge: React.FC<{index: number; title: string; accent: string}> = ({index, title, accent}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const progress = spring({frame, fps, config: {damping: 16, stiffness: 150}});
  return (
    <div style={{position: "absolute", top: 82, left: 46, display: "flex", alignItems: "center", gap: 14, transform: `translateX(${(progress - 1) * 80}px)`, opacity: progress, fontFamily}}>
      <span style={{width: 54, height: 54, display: "grid", placeItems: "center", borderRadius: 16, background: accent, color: "#142119", fontSize: 24, fontWeight: 950}}>{String(index).padStart(2, "0")}</span>
      <b style={{maxWidth: 560, padding: "13px 18px", borderRadius: 16, background: "rgba(5,18,12,.78)", color: "white", fontSize: 32, lineHeight: 1.25, backdropFilter: "blur(14px)"}}>{title}</b>
    </div>
  );
};

const InfoCard: React.FC<{card: InfoCardCue; timeline: ViralTimeline}> = ({card, timeline}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({frame, fps, config: {damping: 17, stiffness: 140}});
  const items = card.items?.slice(0, 4) ?? [];
  return (
    <div style={{
      position: "absolute",
      left: 54,
      right: 54,
      bottom: 82,
      minHeight: 200,
      padding: "30px 34px",
      border: `2px solid ${timeline.theme.accentSoft}`,
      borderRadius: 34,
      background: "linear-gradient(135deg,rgba(7,24,16,.94),rgba(12,39,27,.84))",
      boxShadow: "0 28px 70px rgba(0,0,0,.38)",
      backdropFilter: "blur(18px)",
      color: "white",
      fontFamily,
      transform: `translateY(${(1 - enter) * 120}px) scale(${.96 + enter * .04})`,
      opacity: enter,
    }}>
      <small style={{display: "block", color: timeline.theme.accent, fontSize: 24, fontWeight: 900, letterSpacing: 3}}>{card.eyebrow || card.type.toUpperCase()}</small>
      <strong style={{display: "block", marginTop: 10, fontSize: 48, lineHeight: 1.15, fontWeight: 950}}>{card.title}</strong>
      {card.body ? <p style={{margin: "14px 0 0", color: "rgba(255,255,255,.8)", fontSize: 28, lineHeight: 1.45, fontWeight: 650}}>{card.body}</p> : null}
      {items.length ? <div style={{marginTop: 18, display: "grid", gridTemplateColumns: items.length > 2 ? "1fr 1fr" : "1fr", gap: 10}}>{items.map((item, index) => <span key={`${item}-${index}`} style={{padding: "10px 14px", borderRadius: 14, background: "rgba(255,255,255,.09)", fontSize: 26, fontWeight: 750}}><i style={{color: timeline.theme.accent, fontStyle: "normal"}}>0{index + 1}</i>　{item}</span>)}</div> : null}
    </div>
  );
};

const RedEditorialEnding: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const localFrame = frame - Math.max(0, durationInFrames - Math.round(fps * 1.45));
  if (localFrame < 0) return null;
  const enter = spring({frame: localFrame, fps, config: {damping: 13, stiffness: 205, mass: .58}});
  const pulse = .92 + Math.sin(localFrame / 3.4) * .08;
  return (
    <>
      <div style={{
        position: "absolute",
        left: 84,
        top: 1240,
        display: "flex",
        gap: 12,
        color: "#8b1e2d",
        fontFamily: kineticFontFamily,
        fontSize: 74,
        lineHeight: 1,
        fontWeight: 900,
        WebkitTextStroke: "4px rgba(255,252,246,.99)",
        paintOrder: "stroke fill",
        textShadow: "3px 5px 0 rgba(49,7,13,.86)",
        opacity: enter,
        transform: `translateY(${(1 - enter) * -34}px) scale(${pulse})`,
      }}>
        <span>↓</span><span style={{transform: "translateY(14px)"}}>↓</span><span>↓</span>
      </div>
      {[0, 1, 2, 3, 4].map((index) => {
        const angle = index * 1.24;
        const distance = 42 + index * 9;
        return <span key={index} style={{
          position: "absolute",
          left: 760 + Math.cos(angle) * distance,
          top: 1310 + Math.sin(angle) * distance,
          width: index % 2 ? 10 : 16,
          height: index % 2 ? 10 : 16,
          borderRadius: 999,
          background: index % 2 ? "#fffdf7" : "#8b1e2d",
          boxShadow: "0 0 0 3px rgba(255,253,248,.9), 0 4px 12px rgba(0,0,0,.35)",
          opacity: enter,
          transform: `scale(${.45 + enter * .75})`,
        }} />;
      })}
    </>
  );
};

export const MerchantViralVertical: React.FC<{timeline: ViralTimeline}> = ({timeline}) => {
  useBundledFonts();
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const currentTime = frame / fps;
  const kinetic = timeline.theme.captionMode === "kinetic-red-white"
    || timeline.theme.captionMode === "kinetic-yellow-white"
    || timeline.theme.captionMode === "kinetic-mint-white"
    || timeline.theme.captionMode === "kinetic-bold-yellow-white";
  const yellowBrush = timeline.theme.captionMode === "kinetic-yellow-white";
  const mintKnowledge = timeline.theme.captionMode === "kinetic-mint-white";
  const boldImpact = timeline.theme.captionMode === "kinetic-bold-yellow-white";
  const viralPulse = timeline.theme.captionMode === "kinetic-viral-pulse";
  const softRose = timeline.theme.captionMode === "kinetic-soft-rose";
  const studioStyle = studioStyleFor(timeline.theme.rendererKey);
  const cyanMinimal = studioStyle?.id === 11;
  const blackYellowFocus = studioStyle?.id === 12;
  const steppedStudioCamera = studioStyle?.id === 9 || studioStyle?.id === 10 || studioStyle?.id === 11 || blackYellowFocus;
  const activeCaptionIndex = Math.max(0, timeline.captions.findIndex((caption) => currentTime >= caption.start && currentTime < (caption.displayEnd ?? caption.end)));
  const cameraCueIndex = timeline.cameraCues?.findIndex((cue) => currentTime >= cue.start && currentTime < cue.end) ?? -1;
  const cameraCue = cameraCueIndex >= 0 ? timeline.cameraCues?.[cameraCueIndex] : undefined;
  const focusCue = blackYellowFocus ? timeline.focusCues?.find((cue) => currentTime >= cue.start && currentTime < cue.end) : undefined;
  const focusDuration = focusCue ? Math.max(.3, focusCue.end - focusCue.start) : 1;
  const focusLocalTime = focusCue ? currentTime - focusCue.start : 0;
  const focusEdge = Math.min(.28, focusDuration * .18);
  const focusRadius = focusCue
    ? focusLocalTime < focusEdge
      ? interpolate(focusLocalTime, [0, focusEdge], [86, focusCue.radius ?? 31], {extrapolateLeft: "clamp", extrapolateRight: "clamp"})
      : focusLocalTime > focusDuration - focusEdge
        ? interpolate(focusLocalTime, [focusDuration - focusEdge, focusDuration], [focusCue.radius ?? 31, 86], {extrapolateLeft: "clamp", extrapolateRight: "clamp"})
        : focusCue.radius ?? 31
    : 86;
  const transitionCue = timeline.transitionCues?.find((cue) => {
    const duration = Math.max(.18, cue.duration ?? .32);
    return currentTime >= cue.start && currentTime < cue.start + duration;
  });
  const transitionDuration = Math.max(.18, transitionCue?.duration ?? .32);
  const transitionProgress = transitionCue
    ? Math.max(0, Math.min(1, (currentTime - transitionCue.start) / transitionDuration))
    : 0;
  const transitionPulse = transitionCue ? Math.sin(Math.PI * transitionProgress) : 0;
  const transitionIntensity = transitionCue?.intensity ?? .72;
  const editorialCut = transitionCue?.style === "editorial-cut";
  const editorialWipe = transitionCue?.style === "editorial-wipe";
  const viralTransitionBoost = viralPulse ? .72 : 1;
  const transitionScale = transitionCue?.style === "soft-flash"
    ? 1 + transitionPulse * .024 * transitionIntensity * viralTransitionBoost
    : editorialCut
      ? 1 + transitionPulse * .075 * transitionIntensity * viralTransitionBoost
      : editorialWipe
        ? 1 + transitionPulse * .042 * transitionIntensity * viralTransitionBoost
        : 1 + transitionPulse * .048 * transitionIntensity * viralTransitionBoost;
  const transitionShift = transitionCue?.style === "drift-left"
    ? -transitionPulse * (viralPulse ? 2.4 : 2.1) * transitionIntensity
    : transitionCue?.style === "drift-right"
      ? transitionPulse * (viralPulse ? 2.4 : 2.1) * transitionIntensity
      : 0;
  const transitionRotation = transitionCue?.style === "drift-left"
    ? -transitionPulse * .22 * transitionIntensity
    : transitionCue?.style === "drift-right"
      ? transitionPulse * .22 * transitionIntensity
      : 0;
  const transitionBlur = transitionCue?.style === "drift-left" || transitionCue?.style === "drift-right"
    ? transitionPulse * (viralPulse ? 1.2 : 1.4) * transitionIntensity
    : 0;
  const editorialCutShift = editorialCut
    ? (transitionProgress < .5 ? -1 : 1) * transitionPulse * (viralPulse ? 2 : 1.65) * transitionIntensity
    : 0;
  const editorialWipeX = -118 + transitionProgress * 236;
  const automaticScale = mintKnowledge
    ? [1, 1.01, 1.018, 1.008][Math.floor(activeCaptionIndex / 2) % 4]
    : boldImpact ? [1, 1.026, 1.012, 1.034][activeCaptionIndex % 4]
      : yellowBrush ? [1, 1.018, 1.008, 1.026][Math.floor(activeCaptionIndex / 2) % 4] : kinetic ? 1 + (activeCaptionIndex % 3) * .018 : 1;
  const automaticOrigin = ["50% 44%", "46% 42%", "54% 43%"][activeCaptionIndex % 3];
  const previousCameraCue = cameraCueIndex > 0 ? timeline.cameraCues?.[cameraCueIndex - 1] : cameraCue;
  const semanticPairCamera = studioStyle?.id === 1;
  const cameraEaseEnd = cameraCue ? Math.min(cameraCue.end, cameraCue.start + (semanticPairCamera ? .46 : .34)) : currentTime;
  const easedCameraScale = steppedStudioCamera && cameraCue
    ? cameraCue.scale
    : cyanMinimal
    ? 1
    : (viralPulse || semanticPairCamera) && cameraCue
      ? interpolate(
      currentTime,
      [cameraCue.start, Math.max(cameraCue.start + .001, cameraEaseEnd)],
      [previousCameraCue?.scale ?? cameraCue.scale, cameraCue.scale],
      {extrapolateLeft: "clamp", extrapolateRight: "clamp"},
    )
      : cameraCue?.scale ?? automaticScale;
  const kineticCut = kinetic && !yellowBrush
    ? timeline.captions.reduce((maximum, caption, index) => {
      if (index === 0) return maximum;
      const distance = currentTime - caption.start;
      const value = distance >= 0 && distance <= .13 ? 1 - distance / .13 : 0;
      return Math.max(maximum, value);
    }, 0)
    : 0;
  const punch = timeline.chapters.reduce((maximum, chapter) => {
    const distance = currentTime - chapter.start;
    const value = distance >= 0 && distance <= .24 ? 1 - distance / .24 : 0;
    return Math.max(maximum, value);
  }, 0);
  const coverFrame = Math.min(
    Math.max(0, durationInFrames - 1),
    secondsToFrames(timeline.coverTime ?? 0.8, fps),
  );
  const firstFrameCoverActive = frame === 0 && coverFrame > 0;
  const fade = firstFrameCoverActive
    ? 1
    : interpolate(frame, [0, 7, durationInFrames - 18, durationInFrames - 1], [0, 1, 1, 0], {extrapolateLeft: "clamp", extrapolateRight: "clamp"});
  return (
    <AbsoluteFill style={{overflow: "hidden", background: blackYellowFocus ? "#000" : timeline.theme.background, opacity: fade}}>
      <AbsoluteFill style={{
        transform: cyanMinimal && !cameraCue
          ? "scale(1)"
          : steppedStudioCamera
          ? `scale(${easedCameraScale})`
          : `scale(${(easedCameraScale + punch * .045 + kineticCut * .028) * transitionScale}) translateX(${transitionShift + editorialCutShift}%) rotate(${transitionRotation}deg)`,
        transformOrigin: cameraCue?.origin ?? automaticOrigin,
        filter: steppedStudioCamera ? "none" : cyanMinimal ? "none" : `blur(${transitionBlur}px) contrast(${mintKnowledge ? 1.01 + punch * .02 : 1.02 + punch * .04 + kineticCut * .025}) saturate(${mintKnowledge ? .98 + punch * .03 : yellowBrush ? 1.0 + punch * .04 : 1.02 + punch * .08})`,
        WebkitMaskImage: focusCue ? `radial-gradient(ellipse ${focusRadius * 1.1}% ${focusRadius * .87}% at ${focusCue.x ?? 50}% ${focusCue.y ?? 51}%, #000 0%, #000 91%, rgba(0,0,0,.94) 95%, transparent 100%)` : undefined,
        maskImage: focusCue ? `radial-gradient(ellipse ${focusRadius * 1.1}% ${focusRadius * .87}% at ${focusCue.x ?? 50}% ${focusCue.y ?? 51}%, #000 0%, #000 91%, rgba(0,0,0,.94) 95%, transparent 100%)` : undefined,
      }}>
        <OffthreadVideo
          src={staticFile(timeline.sourceFile)}
          volume={timeline.sourceVolume ?? 1}
          style={{width: "100%", height: "100%", objectFit: "cover"}}
        />
        {firstFrameCoverActive ? (
          <Sequence from={0} durationInFrames={1}>
            <Freeze frame={coverFrame}>
              <OffthreadVideo
                src={staticFile(timeline.sourceFile)}
                volume={0}
                style={{width: "100%", height: "100%", objectFit: "cover"}}
              />
            </Freeze>
          </Sequence>
        ) : null}
      </AbsoluteFill>
      <AbsoluteFill style={{background: mintKnowledge ? "#d8fff5" : yellowBrush ? "#fff" : kinetic ? "#fff7e8" : timeline.theme.accent, opacity: punch * (mintKnowledge ? .025 : yellowBrush ? .045 : .09) + kineticCut * .04}} />
      <AbsoluteFill style={{
        background: transitionCue?.style === "soft-flash" ? "#fffaf0" : timeline.theme.accent,
        opacity: transitionCue
          ? transitionPulse * transitionIntensity * (transitionCue.style === "soft-flash" ? .16 : editorialCut ? .13 : .035)
          : 0,
      }} />
      {editorialWipe ? (
        <AbsoluteFill style={{
          background: "linear-gradient(90deg, transparent 0%, transparent 24%, rgba(139,30,45,.78) 42%, rgba(255,253,248,.94) 50%, rgba(139,30,45,.78) 58%, transparent 76%, transparent 100%)",
          opacity: Math.min(1, transitionIntensity * .92),
          transform: `translateX(${editorialWipeX}%) skewX(-8deg)`,
          mixBlendMode: "screen",
        }} />
      ) : null}
      <AbsoluteFill style={{background: cyanMinimal ? "linear-gradient(180deg,rgba(0,0,0,.06) 0%,transparent 28%,transparent 72%,rgba(0,0,0,.08) 100%)" : "linear-gradient(180deg,rgba(0,0,0,.2) 0%,transparent 22%,transparent 66%,rgba(0,0,0,.28) 100%)"}} />
      {!focusCue ? <OpeningTitle timeline={timeline} /> : null}
      {timeline.captions.map((caption, index) => {
        const from = secondsToFrames(caption.start, fps);
        const duration = Math.max(1, secondsToFrames((caption.displayEnd ?? caption.end) - caption.start, fps));
        return (
          <Sequence key={`caption-${index}`} from={from} durationInFrames={duration}>
            {studioStyle
              ? <StudioSeriesSubtitle caption={caption} timeline={timeline} index={index} style={studioStyle} />
              : viralPulse || softRose
              ? <ViralPulseSubtitle caption={caption} timeline={timeline} index={index} />
              : kinetic
              ? <KineticSubtitle caption={caption} timeline={timeline} index={index} />
              : <Subtitle caption={caption} timeline={timeline} />}
          </Sequence>
        );
      })}
      {timeline.chapters.map((chapter) => <Sequence key={`chapter-${chapter.index}`} from={secondsToFrames(chapter.start, fps)} durationInFrames={Math.max(1, secondsToFrames(chapter.end - chapter.start, fps))}><ChapterBadge index={chapter.index} title={chapter.title} accent={timeline.theme.accent} /></Sequence>)}
      {timeline.cards.map((card, index) => <Sequence key={`card-${index}`} from={secondsToFrames(card.start, fps)} durationInFrames={Math.max(1, secondsToFrames(card.end - card.start, fps))}><InfoCard card={card} timeline={timeline} /></Sequence>)}
      {timeline.theme.rendererKey === "high-red-editorial-v1" ? <RedEditorialEnding /> : null}
      {timeline.bgmFile ? (
        <Audio
          src={staticFile(timeline.bgmFile)}
          loop={timeline.bgmLoop ?? (studioStyle?.id !== 9)}
          volume={(audioFrame) => {
            const fadeFrames = Math.max(1, Math.round(fps * .8));
            const seconds = audioFrame / fps;
            const speaking = timeline.captions.some((caption) => seconds >= caption.start && seconds <= caption.end);
            const speechSafe = timeline.bgmVolume ?? .115;
            const phraseGapLift = Math.min(.18, speechSafe * 1.18);
            const envelope = interpolate(
              audioFrame,
              [0, fadeFrames, durationInFrames - fadeFrames, durationInFrames - 1],
              [0, 1, 1, 0],
              {extrapolateLeft: "clamp", extrapolateRight: "clamp"},
            );
            return envelope * (speaking ? speechSafe : phraseGapLift);
          }}
        />
      ) : null}
      {timeline.sfxFile ? <Audio src={staticFile(timeline.sfxFile)} volume={timeline.sfxVolume ?? 0.9} /> : null}
      {timeline.sfxCues?.map((cue, index) => (
        <Sequence key={`sfx-${index}-${cue.file}`} from={secondsToFrames(cue.start, fps)}>
          <Audio
            src={staticFile(cue.file)}
            volume={cue.volume ?? 0.24}
            playbackRate={cue.playbackRate ?? 1}
          />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
