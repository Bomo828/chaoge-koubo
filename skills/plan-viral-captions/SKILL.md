---
name: plan-viral-captions
description: Plan and integrate AI-generated titles, grounded caption corrections and line breaks, semantic highlight phrases, and sparse primary keywords for Merchant Studio talking-head viral templates. Use when changing 一键网感 title/caption semantics or TT-5.5 caption planning; do not use for ASR timing, visual rendering, transitions, or media generation.
---

# Plan Viral Captions

Maintain one semantic source of truth for Merchant Studio templates 9–12.

## Boundaries

- Treat ASR or an imported manifest as the authority for `id`, `start`, `end`, and item count.
- Use AI only for grounded text correction, title planning, visual line breaks, highlight phrases, and sparse primary-keyword decisions.
- Never let the model modify the timeline, merge captions, invent claims, choose media files, or emit rendering coordinates.
- Keep ordinary highlights visually richer than the soundtrack. Only `primary` keywords may request a keyword sound effect.

## Runtime integration

- Use the shared runtime contract in `lib/viral-caption-ai-skill.ts`; do not duplicate the system prompt in API routes or rendering workers.
- Call the configured Open AI Platform through `lib/lk888.ts`. The default model is `tt-5.5` and the endpoint is `/v1/chat/completions`.
- Read the API key only through the encrypted admin credential or `LK888_API_KEY`. Never place a key in source, browser code, logs, screenshots, or skill files.
- Both original-video ASR and imported lip-sync timelines must call the same skill after the timeline is available.
- Validate every model field before saving. Reject ungrounded corrections and keywords that do not occur continuously in the corrected caption.
- On provider failure, preserve the locked timeline and show a retryable degraded state. Never label a local fallback as an AI result.

## Output semantics

- `title` is a complete natural-language promise, topic, or conclusion; it is not a greeting or the first two lines joined together.
- `caption_lines` contains one or two visually balanced lines whose concatenation equals the corrected caption.
- `keyword` is an optional continuous semantic phrase in that caption.
- `keyword_importance=regular` means visual highlight only.
- `keyword_importance=primary` means a rare key moment eligible for emphasis sound. Keep it to roughly one to three moments per minute and avoid adjacent triggers.
- `keyword_importance=none` requires an empty keyword.

Before changing the runtime contract or output fields, read [references/runtime-contract.md](references/runtime-contract.md).
