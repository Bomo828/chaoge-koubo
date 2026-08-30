---
name: plan-viral-captions
description: Design, maintain, or diagnose Merchant Studio's runtime AI skill for full-transcript talking-head titles, semantic caption grouping, template-safe line breaks, highlight phrases, and sparse primary keywords. Use when changing 一键网感 caption meaning, ASR chunk ownership, or AI caption-planning responsibilities; do not use for typography rendering, transitions, or media generation alone.
---

# Plan Viral Captions

Maintain one full-transcript semantic source of truth for Merchant Studio templates 9–12. Treat this as one product runtime skill, not separate “AI recognition”, “AI layout”, and “AI planning” agents.

## Boundaries

- Treat ASR or an imported manifest as the authority for recognized words and real timestamps, not for final sentence boundaries.
- Convert the full transcript into ordered stable tokens. Prefer word timestamps; when word coverage is unavailable, use each upstream sentence as an indivisible token.
- Keep timestamps on the server and send only compact `[tokenId, text]` entries. AI selects contiguous `a..b` token spans and may regroup across upstream ASR sentences.
- Use AI for grounded text correction, title planning, full-transcript semantic cues, visual line breaks, highlight phrases, sparse primary keywords, translation, and content-role labels.
- Never let the model change token order, invent timing or claims, choose media files, or emit rendering coordinates.
- Keep ordinary highlights visually richer than the soundtrack. Only `primary` keywords may request a keyword sound effect.
- Templates supply capacity only: maximum lines, units per line, and units per cue. Do not add template-specific language rules or grow a phrase dictionary to fix individual examples.

## Runtime integration

- Use the shared runtime contract in `lib/viral-caption-ai-skill.ts`; do not duplicate the system prompt in API routes or rendering workers.
- Call providers through `lib/viral-caption-ai-provider.ts`. DeepSeek is primary and the OpenAI-compatible lk888 endpoint is the short fallback.
- Read API keys only through encrypted admin credentials or server environment variables. Never place a key in source, browser code, logs, screenshots, or skill files.
- Both original-video ASR and imported lip-sync timelines must call the same skill after the timeline is available.
- Derive camera, transition and SFX-role implementation after the call. AI may label content role and importance, but it does not prescribe rendering coordinates.
- The deterministic compiler must prove ordered full token coverage, no overlap, no omission, grounded corrections, real first/last-token timing, keyword containment, and template capacity before accepting a plan.
- If one otherwise grounded AI cue exceeds template capacity, repair only that cue at safe confirmed word boundaries and preserve the rest of the AI plan. Treat Chinese dictionary segmentation as a preferred quality signal, not a second timing authority: when it disagrees with confirmed ASR token timing, choose the least-risk confirmed boundary instead of rejecting the entire plan.
- On provider failure, preserve the locked timeline and show a retryable degraded state. Never label a local fallback as an AI result.

## Output semantics

- `title` is a complete natural-language promise, topic, or conclusion; it is not a greeting or the first two lines joined together.
- Each cue uses inclusive token ids `a` and `b`; all cues must cover token zero through the final token exactly once in increasing contiguous order.
- `l` contains one or two visually balanced lines whose concatenation equals the grounded corrected cue `x`.
- `keyword` is an optional continuous semantic phrase in that caption.
- `keyword_importance=regular` means visual highlight only.
- `keyword_importance=primary` means a rare key moment eligible for emphasis sound. Keep it to roughly one to three moments per minute and avoid adjacent triggers.
- `keyword_importance=none` requires an empty keyword.

Before changing the runtime contract or output fields, read [references/runtime-contract.md](references/runtime-contract.md).
