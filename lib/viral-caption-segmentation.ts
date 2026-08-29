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

function endsSentence(value: string) {
  return /[.!?。！？]$/.test(value.trim());
}

function mergeEnglishCaptionWords(captions: ViralCaptionSegment[]) {
  if (viralSpeechLanguage(captions.map((caption) => caption.text).join(" ")) !== "en") return captions;
  const output: ViralCaptionSegment[] = [];
  let current: ViralCaptionSegment | null = null;
  const flush = () => {
    if (current?.text) output.push(current);
    current = null;
  };
  captions.forEach((caption, index) => {
    const text = normalizeSpeechText(caption.text);
    if (!text) return;
    if (!current) current = { ...caption, text };
    else {
      const gap = Math.max(0, caption.start - current.end);
      const combinedWords = unitCount(`${current.text} ${text}`);
      if (gap > 0.72 || endsSentence(current.text) || combinedWords > 12) {
        flush();
        current = { ...caption, text };
      } else {
        current.text = `${current.text} ${text}`.replace(/\s+/g, " ").trim();
        current.end = Math.max(current.end, caption.end);
      }
    }
    const next = captions[index + 1];
    const nextGap = next ? Math.max(0, next.start - caption.end) : 0;
    if (current && (endsSentence(text) || unitCount(current.text) >= 8 || nextGap > 0.72 || !next)) flush();
  });
  flush();

  const balanced = output.map((caption) => ({ ...caption }));
  for (let index = 0; index < balanced.length; index += 1) {
    const caption = balanced[index];
    const currentWords = unitCount(caption.text);
    if (currentWords >= 4) continue;
    const previous = balanced[index - 1];
    const next = balanced[index + 1];
    const previousGap = previous ? Math.max(0, caption.start - previous.end) : Infinity;
    const nextGap = next ? Math.max(0, next.start - caption.end) : Infinity;
    if (
      previous
      && previousGap <= 1.25
      && unitCount(previous.text) + currentWords <= 14
      && !endsSentence(previous.text)
    ) {
      previous.text = `${previous.text} ${caption.text}`.replace(/\s+/g, " ").trim();
      previous.end = caption.end;
      balanced.splice(index, 1);
      index -= 1;
      continue;
    }
    if (
      next
      && nextGap <= 1.25
      && currentWords + unitCount(next.text) <= 14
      && !endsSentence(caption.text)
    ) {
      next.text = `${caption.text} ${next.text}`.replace(/\s+/g, " ").trim();
      next.start = caption.start;
      balanced.splice(index, 1);
      index -= 1;
    }
  }
  return balanced;
}

const CHINESE_DANGLING_END = /(?:的|地|得|和|与|及|或|而|但|却|就|都|也|还|再|又|把|被|让|给|向|从|在|到|为|对|比|像|是|有|要|想|能|会|可|可以|如果|因为|所以|无论|不管|不论|不仅|以及|还是)$/u;
const CHINESE_DANGLING_START = /^(?:的|地|得|了|着|过|就|才|更|和|与|及|或|把|被|让|给|其中|以及|还是|想念的|属于)/u;
const CHINESE_OPENING_CLAUSE = /^(?:无论|不管|不论|如果|只要|因为|虽然|不仅|不是|当|每当)/u;
const CHINESE_CLAUSE_RESOLUTION = /^(?:都|也|就|才|所以|但是|而且|还是|便|那么|却)/u;
const CHINESE_OPEN_PREDICATE = /^(?:想|想要|想吃|想喝|想找|想学|想看|想买|想了解|想体验|希望|需要)/u;
const CHINESE_PARALLEL_ACTION = /^(?:来|点|选|加|买|吃|喝|看|学|做|试)/u;

function mergeCaptionPair(left: ViralCaptionSegment, right: ViralCaptionSegment) {
  return {
    start: left.start,
    end: Math.max(left.end, right.end),
    text: `${normalizeSpeechText(left.text)}${normalizeSpeechText(right.text)}`,
  };
}

/**
 * Tencent ASR often returns fluent Chinese as several 5–8 character timing
 * fragments.  A subtitle should follow meaning rather than those transport
 * chunks, so join fragments that are visibly unfinished or form one short
 * spoken phrase.  The original first/last timestamps are retained.
 */
export function rebalanceChineseViralCaptions(captions: ViralCaptionSegment[]) {
  if (viralSpeechLanguage(captions.map((caption) => caption.text).join("")) !== "zh") return captions;
  const merged: ViralCaptionSegment[] = [];
  const maxUnits = 20;
  const maxDuration = 3.9;
  for (const raw of captions) {
    // Keep terminal punctuation until the merge decision has been made.  It is
    // timing evidence: a full stop is a hard boundary and must not be crossed
    // merely because the ASR fragments are close together.
    const current = { ...raw, text: normalizeSpeechText(raw.text).replace(/^[，。！？；：、]+/gu, "") };
    if (!current.text) continue;
    const previous = merged[merged.length - 1];
    if (!previous) {
      merged.push(current);
      continue;
    }
    const gap = Math.max(0, current.start - previous.end);
    const previousUnits = unitCount(previous.text);
    const currentUnits = unitCount(current.text);
    const combinedUnits = previousUnits + currentUnits;
    const combinedDuration = current.end - previous.start;
    const hardBoundary = /[。！？!?；;]$/u.test(previous.text);
    const unfinished = !hardBoundary && (CHINESE_DANGLING_END.test(previous.text) || CHINESE_DANGLING_START.test(current.text));
    const pairedClause = CHINESE_OPENING_CLAUSE.test(previous.text)
      && (CHINESE_CLAUSE_RESOLUTION.test(current.text) || current.text.includes("还是"));
    const openPredicate = CHINESE_OPEN_PREDICATE.test(previous.text) && previousUnits <= 9 && currentUnits <= 9;
    const parallelAction = CHINESE_PARALLEL_ACTION.test(previous.text)
      && CHINESE_PARALLEL_ACTION.test(current.text)
      && previousUnits <= 7
      && currentUnits <= 7;
    const shouldJoin = gap <= 0.5
      && combinedUnits <= maxUnits
      && combinedDuration <= maxDuration
      && !hardBoundary
      && (unfinished || pairedClause || (gap <= 0.22 && (openPredicate || parallelAction)));
    if (shouldJoin) merged[merged.length - 1] = mergeCaptionPair(previous, current);
    else merged.push(current);
  }

  // Remove isolated micro-captions left by recognition jitter. Prefer the
  // closest neighbour without creating an overlong on-screen sentence.
  for (let index = 0; index < merged.length; index += 1) {
    const item = merged[index];
    if (unitCount(item.text) >= 4) continue;
    const previous = merged[index - 1];
    const next = merged[index + 1];
    const previousFits = previous
      && item.start - previous.end <= 0.5
      && !/[。！？!?；;]$/u.test(previous.text)
      && unitCount(previous.text) + unitCount(item.text) <= maxUnits;
    const nextFits = next
      && next.start - item.end <= 0.5
      && unitCount(item.text) + unitCount(next.text) <= maxUnits;
    if (previousFits && (!nextFits || item.start - previous.end <= next.start - item.end)) {
      merged[index - 1] = mergeCaptionPair(previous, item);
      merged.splice(index, 1);
      index -= 1;
    } else if (nextFits) {
      merged[index + 1] = mergeCaptionPair(item, next);
      merged.splice(index, 1);
      index -= 1;
    }
  }
  return merged.map((caption) => ({
    ...caption,
    text: caption.text.replace(/^[，。！？；：、]+|[，。！？；：、]+$/gu, ""),
  })).filter((caption) => caption.text);
}

export function segmentViralCaptions(captions: ViralCaptionSegment[]) {
  // A confirmed ASR/lip-sync timeline is evidence.  Never manufacture new
  // timestamps by splitting text proportionally: that caused semantic breaks
  // such as “华为激励商 / 家入驻机会” and visible subtitle drift.  We may join
  // adjacent unfinished ASR units, but the resulting start/end always come
  // from the first and last real source units.
  const segmented = mergeEnglishCaptionWords(repairEnglishWordFragments(captions))
    .filter((caption) => caption.text)
    .sort((left, right) => left.start - right.start);
  return rebalanceChineseViralCaptions(segmented);
}
