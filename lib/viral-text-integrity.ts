function compact(value: string) {
  return value
    .replace(/[\s，。！？；：、,.!?;:'"“”‘’（）()【】\[\]《》<>—…·|｜-]/g, "")
    .toLowerCase();
}

function levenshtein(left: string, right: string) {
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const saved = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      diagonal = saved;
    }
  }
  return previous[right.length];
}

export function viralPlainText(value: unknown) {
  return typeof value === "string" ? compact(value) : "";
}

/**
 * AI may repair obvious homophones or punctuation, but it may not rewrite a
 * caption.  Returning the source text on failure keeps the confirmed timing
 * contract intact and makes the fallback deterministic.
 */
export function acceptViralCaptionCorrection(source: string, candidate: unknown) {
  if (typeof candidate !== "string") return source;
  const sourcePlain = compact(source);
  const candidatePlain = compact(candidate);
  if (!sourcePlain || !candidatePlain) return source;
  const ratio = candidatePlain.length / sourcePlain.length;
  if (ratio < 0.82 || ratio > 1.18) return source;
  const distance = levenshtein(sourcePlain, candidatePlain);
  const allowed = Math.max(2, Math.ceil(sourcePlain.length * 0.2));
  const similarity = 1 - distance / Math.max(sourcePlain.length, candidatePlain.length);
  return distance <= allowed && similarity >= 0.76 ? candidate.trim() : source;
}

export function viralCorrectionBatchIsGrounded(source: string[], corrected: string[]) {
  if (source.length !== corrected.length || !source.length) return false;
  const sourcePlain = compact(source.join(""));
  const correctedPlain = compact(corrected.join(""));
  if (!sourcePlain || !correctedPlain) return false;
  const ratio = correctedPlain.length / sourcePlain.length;
  const distance = levenshtein(sourcePlain, correctedPlain);
  const similarity = 1 - distance / Math.max(sourcePlain.length, correctedPlain.length);
  return ratio >= 0.9 && ratio <= 1.1 && similarity >= 0.82;
}
