export const CHANJING_VOICE_CLONE_POINTS = 80;
export const CHANJING_SPEECH_POINTS_PER_SECOND = 0.15;
export const CHANJING_LIP_SYNC_BASE_POINTS = 80;
export const CHANJING_LIP_SYNC_BASIC_POINTS_PER_SECOND = 1;
export const CHANJING_LIP_SYNC_PRO_POINTS_PER_SECOND = 2;

export function speechPoints(durationSeconds: number) {
  return Math.max(1, Math.ceil(Math.max(0, durationSeconds) * CHANJING_SPEECH_POINTS_PER_SECOND));
}

export function estimatedSpeechPoints(text: string, speed: number) {
  const safeSpeed = Math.max(0.5, Math.min(2, Number(speed) || 1));
  const value = text.trim();
  const chineseCharacters = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const latinWords = (value.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length;
  const otherCharacters = Math.max(0, value.length - chineseCharacters);
  // Reserve conservatively, then settle against the provider's actual duration.
  // Chinese is typically 3–4 characters/s; English is typically 2–3 words/s.
  const estimatedSeconds = Math.max(
    1,
    (chineseCharacters / 2.5 + latinWords / 1.8 + otherCharacters / 20) / safeSpeed,
  );
  return speechPoints(estimatedSeconds);
}

export function lipSyncPoints(durationSeconds: number, highQuality = true) {
  const perSecond = highQuality
    ? CHANJING_LIP_SYNC_PRO_POINTS_PER_SECOND
    : CHANJING_LIP_SYNC_BASIC_POINTS_PER_SECOND;
  return Math.ceil(CHANJING_LIP_SYNC_BASE_POINTS + Math.max(0, durationSeconds) * perSecond);
}

export function wavDurationSeconds(bytes: ArrayBuffer) {
  const view = new DataView(bytes);
  if (view.byteLength < 44) return 0;
  const text = (offset: number, length: number) => Array.from(
    { length },
    (_, index) => String.fromCharCode(view.getUint8(offset + index)),
  ).join("");
  if (text(0, 4) !== "RIFF" || text(8, 4) !== "WAVE") return 0;

  let offset = 12;
  let byteRate = 0;
  let dataBytes = 0;
  while (offset + 8 <= view.byteLength) {
    const chunkId = text(offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    if (chunkId === "fmt " && chunkSize >= 12 && chunkStart + 12 <= view.byteLength) {
      byteRate = view.getUint32(chunkStart + 8, true);
    } else if (chunkId === "data") {
      dataBytes = Math.min(chunkSize, Math.max(0, view.byteLength - chunkStart));
    }
    if (byteRate > 0 && dataBytes > 0) break;
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }
  return byteRate > 0 && dataBytes > 0 ? dataBytes / byteRate : 0;
}
