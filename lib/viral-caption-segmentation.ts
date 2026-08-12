export type ViralCaptionSegment = {
  start: number;
  end: number;
  text: string;
};

export function viralSpeechLanguage(value: string) {
  const cjk = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const latinWords = value.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || [];
  return latinWords.length * 2 > cjk ? "en" as const : "zh" as const;
}

const ENGLISH_SUFFIX_FRAGMENTS = new Set([
  "s", "es", "ed", "er", "ers", "ing", "ly", "ment", "ness", "tion", "tions",
  "able", "ible", "al", "ial", "ic", "ive", "ize", "ise", "ized", "ised",
]);

export function repairEnglishWordFragments(captions: ViralCaptionSegment[]) {
  const repaired: ViralCaptionSegment[] = [];
  captions.forEach((raw) => {
    const current = { ...raw, text: normalizeSpeechText(raw.text) };
    const previous = repaired[repaired.length - 1];
    if (!previous || viralSpeechLanguage(`${previous.text} ${current.text}`) !== "en") {
      if (current.text) repaired.push(current);
      return;
    }
    const gap = Math.max(0, current.start - previous.end);
    const firstMatch = current.text.match(/^([A-Za-z]+)(.*)$/);
    const lastMatch = previous.text.match(/^(.*?)([A-Za-z]{4,})$/);
    const suffix = firstMatch?.[1].toLowerCase() || "";
    const previousWord = lastMatch?.[2].toLowerCase() || "";
    const isPrefixFragment = !lastMatch?.[1].trim()
      && previousWord.length <= 6
      && /^[a-z]+$/.test(previousWord);
    if (
      gap <= 0.18
      && firstMatch
      && lastMatch
      && (ENGLISH_SUFFIX_FRAGMENTS.has(suffix) || isPrefixFragment)
      && !/[.!?]$/.test(previous.text)
    ) {
      previous.text = `${lastMatch[1]}${lastMatch[2]}${firstMatch[1]}${firstMatch[2]}`.replace(/\s+/g, " ").trim();
      previous.end = Math.max(previous.end, current.end);
      return;
    }
    if (current.text) repaired.push(current);
  });
  return repaired;
}

function normalizeSpeechText(value: string) {
  const text = value.trim();
  return viralSpeechLanguage(text) === "en"
    ? text.replace(/\s+/g, " ")
    : text.replace(/\s+/g, "");
}

function unitCount(value: string) {
  if (viralSpeechLanguage(value) === "en") {
    return (value.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
  }
  return [...value.replace(/[^\u3400-\u9fffA-Za-z0-9]/g, "")].length;
}

function englishChunks(value: string) {
  const words = normalizeSpeechText(value).split(" ").filter(Boolean);
  const output: string[] = [];
  const maxWords = 11;
  const minTailWords = 4;
  let cursor = 0;
  while (cursor < words.length) {
    const remaining = words.length - cursor;
    let size = Math.min(maxWords, remaining);
    if (remaining > maxWords && remaining - size < minTailWords) {
      size = Math.max(minTailWords, remaining - minTailWords);
    }
    const window = words.slice(cursor, cursor + size);
    const semanticBreak = window.findLastIndex((word, index) => (
      index >= 4 && /^(?:and|but|or|because|so|while|when|that|which|who|if|then|also)$/i.test(word)
    ));
    if (semanticBreak > 4 && remaining - semanticBreak >= minTailWords) size = semanticBreak;
    output.push(words.slice(cursor, cursor + size).join(" "));
    cursor += size;
  }
  return output;
}

function chineseChunks(value: string) {
  const chars = [...normalizeSpeechText(value)];
  const output: string[] = [];
  let cursor = 0;
  while (cursor < chars.length) {
    const remaining = chars.length - cursor;
    let size = Math.min(15, remaining);
    if (remaining > 15 && remaining - size < 5) size = Math.max(5, remaining - 5);
    output.push(chars.slice(cursor, cursor + size).join(""));
    cursor += size;
  }
  return output;
}

function captionChunks(value: string) {
  return normalizeSpeechText(value)
    .split(/[，,.。！？!?；;：:\n]+/u)
    .flatMap((part) => viralSpeechLanguage(part) === "en" ? englishChunks(part) : chineseChunks(part))
    .filter(Boolean);
}

function splitTimedCaption(caption: ViralCaptionSegment) {
  const parts = captionChunks(caption.text);
  if (parts.length <= 1) return parts.length ? [{ ...caption, text: parts[0] }] : [];
  const weights = parts.map((part) => Math.max(1, unitCount(part)));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const duration = Math.max(0.1, caption.end - caption.start);
  let cursor = caption.start;
  return parts.map((text, index) => {
    const end = index === parts.length - 1
      ? caption.end
      : Math.min(caption.end, cursor + duration * (weights[index] / total));
    const item = {
      start: Number(cursor.toFixed(2)),
      end: Number(Math.max(cursor + 0.05, end).toFixed(2)),
      text,
    };
    cursor = item.end;
    return item;
  });
}

export function segmentViralCaptions(captions: ViralCaptionSegment[]) {
  return repairEnglishWordFragments(captions)
    .flatMap(splitTimedCaption)
    .filter((caption) => caption.text)
    .sort((left, right) => left.start - right.start);
}
