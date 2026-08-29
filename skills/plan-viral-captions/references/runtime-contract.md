# Runtime contract

## Provider

- Base URL: `https://api.lk888.ai`
- Endpoint: `POST /v1/chat/completions`
- Model: `tt-5.5`
- Authentication: `Authorization: Bearer <server-side key>`
- Response mode: non-streaming JSON object for the short planning pass
- Request deadline: 55 seconds by default; `VIRAL_CAPTION_AI_TIMEOUT_MS` may override it between 30 and 90 seconds.

`LK888_API_BASE_URL` and the encrypted admin credential may override connection details. `VIRAL_CAPTION_AI_MODEL` is an emergency deployment override; the normal default remains `tt-5.5`.

## Input invariant

Each item has a fixed `id`, `start`, `end`, and source `text`. The model may return a grounded `corrected_text`, but the caller retains the original timing and item count.

## Required output

```json
{
  "skill": "talking-head-caption-director",
  "version": "2026-08-30-v1",
  "title": "完整标题",
  "title_lines": ["第一行", "第二行"],
  "summary": "一句规划说明",
  "items": [
    {
      "id": 0,
      "corrected_text": "校正后的原句",
      "caption_lines": ["第一行", "第二行"],
      "keyword": "提亮词或空字符串",
      "keyword_importance": "none|regular|primary",
      "translation": "Short translation",
      "content_node": "hook",
      "weight": 0.9
    }
  ]
}
```

The transcript route uses `captions` instead of `items` and one-based ids. This is only a transport difference; the semantics are identical.

## Validation

- Accept a correction only if it remains grounded in the source transcript.
- Accept a keyword only if it is a continuous substring of the accepted correction and passes `sanitizeViralKeyword`.
- Normalize missing or invalid importance to `regular` when a valid keyword exists, otherwise `none`.
- Map `primary` to `keywordSfx=true`. When the model returns only regular highlights, let the shared sparse emphasis selector promote the strongest, well-spaced candidates instead of rejecting the whole AI plan.
- Generate camera, transition, and sound-role intentions locally from the validated content node and weight. Do not ask the caption model to solve them.
