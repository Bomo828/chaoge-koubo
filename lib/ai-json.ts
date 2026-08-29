type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function candidateScore(record: JsonRecord) {
  const captions = Array.isArray(record.captions) ? record.captions.length : 0;
  const items = Array.isArray(record.items) ? record.items.length : 0;
  return Math.max(captions, items) * 20
    + (typeof record.title === "string" && record.title.trim() ? 10 : 0)
    + (Array.isArray(record.title_lines) && record.title_lines.length ? 4 : 0)
    + (typeof record.summary === "string" && record.summary.trim() ? 1 : 0);
}

function valueIsEmpty(value: unknown) {
  return value === undefined
    || value === null
    || value === ""
    || (Array.isArray(value) && value.length === 0);
}

function mergeRecords(records: JsonRecord[]) {
  const ranked = [...records].sort((left, right) => candidateScore(right) - candidateScore(left));
  const merged: JsonRecord = { ...(ranked[0] || {}) };
  for (const record of ranked.slice(1)) {
    for (const [key, value] of Object.entries(record)) {
      const current = merged[key];
      if (valueIsEmpty(current) && !valueIsEmpty(value)) {
        merged[key] = value;
      } else if (Array.isArray(value) && Array.isArray(current) && value.length > current.length) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function extractCompleteJsonValues(source: string) {
  const values: unknown[] = [];
  let start = -1;
  let stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (start < 0) {
      if (character !== "{" && character !== "[") continue;
      start = index;
      stack = [character];
      inString = false;
      escaped = false;
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      stack.push(character);
      continue;
    }
    if (character !== "}" && character !== "]") continue;

    const expected = character === "}" ? "{" : "[";
    if (stack[stack.length - 1] !== expected) {
      start = -1;
      stack = [];
      inString = false;
      escaped = false;
      continue;
    }
    stack.pop();
    if (stack.length) continue;

    const candidate = source.slice(start, index + 1);
    try {
      values.push(JSON.parse(candidate));
    } catch {
      // A later complete JSON value may still be usable.
    }
    start = -1;
  }
  return values;
}

/**
 * Parses structured model output without requiring the provider to return one
 * perfectly isolated JSON object. Some OpenAI-compatible gateways occasionally
 * append prose or emit title and caption data as adjacent JSON objects. Keep
 * all complete values, select the most useful plan, and fill its missing fields
 * from the remaining objects.
 */
export function parseAiJsonObject(content: string, errorMessage = "AI 没有返回可用的结构化结果。") {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");

  try {
    const parsed = JSON.parse(cleaned);
    if (isRecord(parsed)) return parsed;
  } catch {
    // Fall through to tolerant extraction.
  }

  const values = extractCompleteJsonValues(cleaned);
  const records = values.flatMap((value) => (
    isRecord(value)
      ? [value]
      : Array.isArray(value)
        ? value.filter(isRecord)
        : []
  ));
  if (!records.length) throw new Error(errorMessage);
  return mergeRecords(records);
}
