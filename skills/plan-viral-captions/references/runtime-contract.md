# Runtime contract

## Providers

- Primary: DeepSeek OpenAI-compatible chat completions through `lib/deepseek.ts`.
- Short fallback: lk888 OpenAI-compatible chat completions through `lib/lk888.ts`.
- Response mode: non-streaming JSON object for one full-transcript planning pass.
- Provider selection, deadlines, and fallback behavior live in `lib/viral-caption-ai-provider.ts`.

Authentication is server-side only. Encrypted admin credentials and environment variables may override model or connection details without exposing keys to the browser, render worker, source code, logs, screenshots, or skill files.

## Input invariant

The server converts the full upstream transcript to a stable ordered token list:

```json
[[0, "first token"], [1, "second token"]]
```

Each token retains its real `start` and `end` on the server. Times are omitted from the model prompt because the model selects boundaries by token id and must never manufacture timing.

Word timestamps are preferred. If reliable word coverage is missing, each upstream sentence becomes one indivisible token: AI may join adjacent sentences but cannot split one or invent sub-sentence timing.

## Required output

```json
{
  "t": "完整标题",
  "tl": ["第一行", "第二行"],
  "c": [
    {
      "a": 0,
      "b": 4,
      "x": "这一屏校正后的完整字幕",
      "l": ["第一行", "第二行"],
      "k": "提亮词或空字符串",
      "p": "none|regular|primary",
      "z": "Short translation",
      "n": "hook",
      "w": 0.9
    }
  ]
}
```

`a` and `b` are inclusive token ids. Cues must start at zero and cover every token exactly once in increasing contiguous order.

## Validation

Reject a model plan unless all conditions hold:

1. Token coverage is complete, contiguous, ordered, non-overlapping, and within range.
2. Corrected cue text remains grounded in the selected source span.
3. Cue and line capacities comply with the selected template.
4. Visual lines reconstruct the corrected cue text.
5. Semantic boundaries do not strand function words, suffixes, step labels, or split a recognized word.
6. A highlight is a continuous informative phrase inside its cue and passes `sanitizeViralKeyword`.
7. Primary keywords remain sparse enough for sound effects.
8. Cue timing is copied from the selected first and last tokens.

On rejection, preserve the recognized transcript and return a deterministic safe layout with `planReady=false`. Do not discard prior user work or claim that AI planning succeeded.

An otherwise valid cue that only exceeds template capacity is locally repairable, not a whole-plan failure. Split it at confirmed word boundaries, strongly penalize boundaries that strand function words, suffixes or step labels, regenerate template-safe visual lines, retain the keyword only on the repaired cue containing it, and derive every repaired start/end from its first/last confirmed word. `Intl.Segmenter` or another Chinese dictionary tokenizer is advisory: prefer its boundaries, but never let disagreement with a real ASR token boundary veto the whole plan. Use a whole-cue search so an early split cannot leave an impossible tail. If the oversized source has only one sentence-level token, do not invent timing; return the explicit missing-word-timing error instead.

## Forward tests

Use unrelated scripts rather than matching one known sentence. Include long noun and verb-object phrases, causal and contrast clauses, numbered steps attached to the previous ASR sentence, mixed Chinese/Latin brands/numbers/units, malformed token coverage, and both word-level and sentence-level timing. Assert semantic and integrity invariants rather than one exact wording when several good plans exist.
