import unittest
import json
import tempfile
from pathlib import Path

try:
    import main as worker
except ModuleNotFoundError as import_error:
    try:
        from scripts.build_template9_local_review import load_worker

        worker = load_worker()
    except Exception as fallback_import_error:  # pragma: no cover - environment guard
        worker = None
        WORKER_IMPORT_ERROR = f"{import_error}; fallback: {fallback_import_error}"
    else:
        WORKER_IMPORT_ERROR = ""
else:
    WORKER_IMPORT_ERROR = ""


@unittest.skipIf(worker is None, f"video worker dependencies unavailable: {WORKER_IMPORT_ERROR}")
class SharedDirectorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.previous_key = worker.AI_API_KEY
        worker.AI_API_KEY = ""
        self.captions = [
            {"start": 0.0, "end": 2.5, "text": "很多人不知道怎么提升效率"},
            {"start": 4.0, "end": 6.5, "text": "但是成本降低了50%"},
            {"start": 8.0, "end": 10.5, "text": "第一步先检查资料"},
            {"start": 12.0, "end": 14.5, "text": "现在就联系我们"},
        ]

    def tearDown(self) -> None:
        worker.AI_API_KEY = self.previous_key

    def test_one_local_plan_routes_all_four_templates(self) -> None:
        for template_id in ("template-9", "template-10", "template-11", "template-12"):
            profile = worker.template_profile(template_id)
            planned, source = worker.ai_direct_shared_captions(
                self.captions,
                "效率提升方法",
                profile.get("content_director"),
            )

            self.assertEqual(source, "shared-local-director")
            self.assertEqual(len(planned), len(self.captions))
            self.assertTrue(all(item.get("keywordLocked") for item in planned))
            # When the AI plan is unavailable the renderer must preserve the
            # transcript without inventing emphasis.  A missing highlight is
            # safer than an incorrect one.
            self.assertEqual(
                sum(bool(str(item.get("keyword") or "").strip()) for item in planned),
                0,
            )
            key_sfx_items = [item for item in planned if item.get("keywordSfx") is True]
            self.assertEqual(len(key_sfx_items), 0)
            self.assertNotIn("你是酒", {str(item.get("keyword") or "") for item in planned})
            self.assertNotIn("年华为", {str(item.get("keyword") or "") for item in planned})
            self.assertEqual(planned[1].get("contentNode"), "pain_reversal")
            self.assertEqual(planned[2].get("contentNode"), "example_step")
            self.assertEqual(planned[3].get("contentNode"), "cta")

            cues = worker.build_adaptive_sfx_cues(
                Path(f"/tmp/{template_id}-shared-director-test"),
                profile,
                16.0,
                planned,
                [],
                "效率提升方法",
            )
            self.assertFalse(any(cue.get("role") not in {"opening", "ending"} for cue in cues))
            self.assertTrue(all(str(cue.get("file") or "").startswith(f"sfx/{template_id}/") for cue in cues))

    def test_generic_self_intro_words_are_never_highlighted(self) -> None:
        captions = [
            {"start": 0.0, "end": 1.6, "text": "大家好我是潮哥"},
            {"start": 1.6, "end": 3.2, "text": "我用codex做了一款"},
            {"start": 3.2, "end": 5.2, "text": "AI剪辑口播视频的工具"},
        ]
        directed_items = [
            {"content_node": "supporting", "keyword": "我是", "confidence": 0.99, "importance": 0.9},
            {"content_node": "supporting", "keyword": "codex", "confidence": 0.99, "importance": 0.9},
            {"content_node": "core_viewpoint", "keyword": "视频", "confidence": 0.99, "importance": 0.9},
        ]
        planned = worker.apply_shared_director_items(captions, directed_items, "AI超级剪辑")
        self.assertEqual([str(item.get("keyword") or "") for item in planned], ["", "", ""])
        self.assertFalse(any(item.get("keywordSfx") is True for item in planned))

    def test_all_four_templates_compile_long_captions_to_line_capacity(self) -> None:
        source = [{
            "start": 1.72,
            "end": 4.97,
            "text": "我用codex做了一款AI剪辑口播视频的工具",
            "words": [
                {"start": 1.72, "end": 2.10, "text": "我用"},
                {"start": 2.10, "end": 2.48, "text": "codex"},
                {"start": 2.48, "end": 2.78, "text": "做了"},
                {"start": 2.78, "end": 3.12, "text": "一款"},
                {"start": 3.12, "end": 3.55, "text": "AI剪辑"},
                {"start": 3.55, "end": 4.12, "text": "口播视频"},
                {"start": 4.12, "end": 4.34, "text": "的"},
                {"start": 4.34, "end": 4.97, "text": "工具"},
            ],
            "captionLines": ["我用codex做了一款", "AI剪辑口播视频的工具"],
            "translation": "I made an AI tool for editing talking head videos with codex",
            "keyword": "AI剪辑",
            "keywordOrigin": "ai",
            "keywordSfx": True,
            "contentNode": "core_viewpoint",
            "cameraIntent": "push-in",
            "transitionIntent": "focus-bridge",
            "sfxRole": "viewpoint",
        }]
        original_text = worker.caption_plain_text(source[0]["text"])
        for template_id in ("template-9", "template-10", "template-11", "template-12"):
            profile = worker.template_profile(template_id)
            compiled = worker.compile_caption_cues_for_template(source, profile)
            self.assertGreater(len(compiled), 1, template_id)
            self.assertEqual(
                worker.caption_plain_text("".join(item["text"] for item in compiled)),
                original_text,
                template_id,
            )
            self.assertEqual(compiled[0]["start"], source[0]["start"], template_id)
            self.assertEqual(compiled[-1]["end"], source[0]["end"], template_id)
            self.assertTrue(all(
                source[0]["start"] <= item["start"] < item["end"] <= source[0]["end"]
                for item in compiled
            ), template_id)
            self.assertTrue(all(
                left["end"] <= right["start"] + 0.001
                for left, right in zip(compiled, compiled[1:])
            ), template_id)
            self.assertTrue(all(
                worker.caption_plain_text("".join(str(word.get("text") or "") for word in item.get("words") or []))
                == worker.caption_plain_text(str(item.get("text") or ""))
                for item in compiled
            ), template_id)
            self.assertTrue(all(
                worker.caption_unit_count(item["text"]) <= int(profile["caption_max_chars"])
                for item in compiled
            ), template_id)
            laid_out = worker.plan_adaptive_caption_lines(
                compiled,
                int(profile["caption_line_max_chars"]),
            )
            self.assertTrue(all(
                len(item.get("captionLines") or []) <= int(profile["caption_max_lines"])
                and all(
                    worker.caption_unit_count(line) <= int(profile["caption_line_max_chars"])
                    for line in item.get("captionLines") or []
                )
                for item in laid_out
            ), template_id)
            keyword_cues = [item for item in compiled if item.get("keyword") == "AI剪辑"]
            self.assertEqual(len(keyword_cues), 1, template_id)
            self.assertEqual(
                " ".join(str(item.get("translation") or "") for item in compiled).split(),
                source[0]["translation"].split(),
                template_id,
            )

    def test_long_caption_without_words_never_invents_internal_timestamps(self) -> None:
        source = [{
            "start": 1.72,
            "end": 4.97,
            "text": "我用codex做了一款AI剪辑口播视频的工具",
        }]
        for template_id in ("template-9", "template-10", "template-11", "template-12"):
            compiled = worker.compile_caption_cues_for_template(
                source,
                worker.template_profile(template_id),
            )
            self.assertEqual(len(compiled), 1, template_id)
            self.assertEqual(compiled[0]["start"], source[0]["start"], template_id)
            self.assertEqual(compiled[0]["end"], source[0]["end"], template_id)
            self.assertEqual(compiled[0]["text"], source[0]["text"], template_id)
            self.assertEqual(
                compiled[0].get("captionCompileSource"),
                "template-capacity:timing-locked",
                template_id,
            )

    def test_phrase_timing_overrides_bad_ai_rows_and_caption_duration(self) -> None:
        source = [{
            "start": 4.97,
            "end": 8.04,
            "text": "最大的特点就是让口播脱离了死板的叙事",
            # These rows are visually balanced but grammatically wrong as
            # temporal cues: “脱离了” cannot lead the next object by itself.
            "captionLines": ["最大的特点就是让口播脱离了", "死板的叙事"],
            "translation": "The biggest feature is freeing talking-head videos from rigid narration",
            "words": [
                {"start": 4.97, "end": 5.35, "text": "最大的"},
                {"start": 5.37, "end": 5.78, "text": "特点"},
                {"start": 5.80, "end": 6.18, "text": "就是"},
                {"start": 6.20, "end": 6.38, "text": "让"},
                {"start": 6.40, "end": 6.76, "text": "口播"},
                {"start": 6.78, "end": 7.13, "text": "脱离了"},
                {"start": 7.15, "end": 7.52, "text": "死板的"},
                {"start": 7.54, "end": 8.04, "text": "叙事"},
            ],
        }]
        expected = ["最大的特点就是", "让口播脱离了死板的叙事"]
        for template_id in ("template-9", "template-10", "template-11", "template-12"):
            profile = worker.template_profile(template_id)
            compiled = worker.compile_caption_cues_for_template(source, profile)
            self.assertEqual([item["text"] for item in compiled], expected, template_id)
            self.assertEqual(compiled[0]["start"], 4.97, template_id)
            self.assertEqual(compiled[0]["end"], 6.18, template_id)
            self.assertEqual(compiled[1]["start"], 6.20, template_id)
            self.assertEqual(compiled[1]["end"], 8.04, template_id)
            self.assertTrue(all(
                worker.caption_plain_text("".join(str(word.get("text") or "") for word in item.get("words") or []))
                == worker.caption_plain_text(str(item.get("text") or ""))
                for item in compiled
            ), template_id)
            self.assertTrue(all(
                float(item["end"]) - float(item["start"]) <= float(profile["caption_max_seconds"]) + 0.001
                for item in compiled
            ), template_id)
            self.assertEqual(
                " ".join(str(item.get("translation") or "") for item in compiled).split(),
                source[0]["translation"].split(),
                template_id,
            )

    def test_final_media_asr_retimes_confirmed_copy_at_real_word_boundaries(self) -> None:
        confirmed = [
            {"start": 0.0, "end": 1.5, "text": "大家好我是潮哥"},
            {"start": 1.5, "end": 3.2, "text": "今天介绍AI剪辑工具"},
        ]
        asr = [{
            "start": 0.42,
            "end": 4.35,
            "text": "大家好我是潮哥今天介绍AI剪辑工具",
            "words": [
                {"start": 0.42, "end": 0.75, "text": "大家好"},
                {"start": 0.82, "end": 1.02, "text": "我是"},
                {"start": 1.06, "end": 1.42, "text": "潮哥"},
                {"start": 2.16, "end": 2.48, "text": "今天"},
                {"start": 2.55, "end": 2.92, "text": "介绍"},
                {"start": 3.08, "end": 3.34, "text": "AI"},
                {"start": 3.38, "end": 3.78, "text": "剪辑"},
                {"start": 3.84, "end": 4.35, "text": "工具"},
            ],
        }]
        retimed = worker.retime_confirmed_captions_from_asr(confirmed, asr)
        self.assertEqual([item["text"] for item in retimed], [item["text"] for item in confirmed])
        self.assertEqual(retimed[0]["start"], 0.42)
        self.assertEqual(retimed[0]["end"], 1.42)
        self.assertEqual(retimed[1]["start"], 2.16)
        self.assertEqual(retimed[1]["end"], 4.35)
        self.assertTrue(worker.captions_have_reliable_word_timing(retimed))
        self.assertEqual(worker.validate_caption_timing(retimed, 4.5), (True, ""))

    def test_tencent_sentence_relative_words_are_rebased_and_punctuation_is_not_a_word(self) -> None:
        payload = {
            "flash_result": [{
                "sentence_list": [
                    {
                        "start_time": 1720,
                        "end_time": 4970,
                        "text": "我用codeX做了一款AI剪辑口播视频的工具。",
                        # Tencent's current Flash word_list values restart at
                        # zero for every sentence instead of using media time.
                        "word_list": [
                            {"start_time": 0, "end_time": 240, "word": "我用"},
                            {"start_time": 240, "end_time": 650, "word": "codeX"},
                            {"start_time": 650, "end_time": 1080, "word": "做了一款"},
                            {"start_time": 1080, "end_time": 1600, "word": "AI剪辑"},
                            {"start_time": 1600, "end_time": 2320, "word": "口播视频"},
                            {"start_time": 2320, "end_time": 2500, "word": "的"},
                            {"start_time": 2500, "end_time": 3250, "word": "工具"},
                            {"start_time": 3250, "end_time": 3250, "word": "。"},
                        ],
                    },
                    {
                        "start_time": 4970,
                        "end_time": 8040,
                        "text": "最大的特点就是让口播脱离了死板的叙事。",
                        "word_list": [
                            {"start_time": 0, "end_time": 430, "word": "最大的"},
                            {"start_time": 430, "end_time": 820, "word": "特点"},
                            {"start_time": 820, "end_time": 1160, "word": "就是"},
                            {"start_time": 1160, "end_time": 1340, "word": "让"},
                            {"start_time": 1340, "end_time": 1760, "word": "口播"},
                            {"start_time": 1760, "end_time": 2160, "word": "脱离了"},
                            {"start_time": 2160, "end_time": 2580, "word": "死板的"},
                            {"start_time": 2580, "end_time": 3070, "word": "叙事"},
                        ],
                    },
                ],
            }],
        }
        segments = worker.normalize_tencent_flash_segments(payload)
        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[0]["words"][0]["start"], 1.72)
        self.assertEqual(segments[0]["words"][-1]["end"], 4.97)
        self.assertEqual(segments[1]["words"][0]["start"], 4.97)
        self.assertEqual(segments[1]["words"][-1]["end"], 8.04)
        self.assertNotIn("。", [word["text"] for word in segments[0]["words"]])
        self.assertTrue(all(
            left["end"] <= right["start"] + 0.001
            for segment in segments
            for left, right in zip(segment["words"], segment["words"][1:])
        ))

        confirmed = [
            {"start": 1.72, "end": 4.97, "text": "我用codeX做了一款AI剪辑口播视频的工具"},
            {"start": 4.97, "end": 6.13, "text": "最大的特点就是"},
            {"start": 6.13, "end": 8.04, "text": "让口播脱离了死板的叙事"},
        ]
        retimed = worker.retime_confirmed_captions_from_asr(confirmed, segments)
        self.assertEqual(retimed[0]["start"], 1.72)
        self.assertEqual(retimed[0]["end"], 4.97)
        self.assertEqual(retimed[1]["start"], 4.97)
        self.assertGreater(retimed[1]["end"], retimed[1]["start"])
        self.assertGreaterEqual(retimed[2]["start"], retimed[1]["end"])
        self.assertEqual(retimed[2]["end"], 8.04)
        self.assertTrue(worker.captions_have_reliable_word_timing(retimed))

    def test_collapsed_or_overlapping_word_timeline_is_not_reused(self) -> None:
        broken = [
            {
                "start": 0.12,
                "end": 0.89,
                "text": "大家好我是潮哥",
                "words": [
                    {"start": 0.12, "end": 0.55, "text": "大家"},
                    {"start": 0.55, "end": 0.75, "text": "好"},
                    {"start": 0.87, "end": 0.89, "text": "我是曹"},
                ],
            },
            {
                "start": 0.87,
                "end": 1.74,
                "text": "我用codeX",
                "words": [
                    {"start": 0.87, "end": 0.89, "text": "哥"},
                    {"start": 1.72, "end": 1.74, "text": "我用code"},
                ],
            },
        ]
        self.assertFalse(worker.captions_have_reliable_word_timing(broken))

    def test_ai_may_select_a_complete_meaningful_phrase(self) -> None:
        self.assertEqual(
            worker.validated_ai_keyword("AI剪辑口播视频的工具", "AI剪辑", "core_viewpoint", 0.88),
            "AI剪辑",
        )
        captions = [
            {"start": 0.0, "end": 2.0, "text": "AI剪辑口播视频的工具"},
            {"start": 2.0, "end": 4.0, "text": "可以让制作效率提升一倍"},
        ]
        directed_items = [
            {"content_node": "core_viewpoint", "keyword": "AI剪辑", "confidence": 0.94, "importance": 0.88},
            {"content_node": "number_benefit", "keyword": "效率提升", "confidence": 0.93, "importance": 0.9},
        ]
        planned = worker.apply_shared_director_items(captions, directed_items, "AI超级剪辑")
        self.assertEqual([str(item.get("keyword") or "") for item in planned], ["", "效率提升"])

    def test_all_four_templates_cut_to_visible_camera_sections(self) -> None:
        transition_points = [4.0, 8.0, 12.0]
        planned = [
            {**caption, "blockId": index // 2, "contentNode": node, "keywordLocked": True}
            for index, (caption, node) in enumerate(zip(
                self.captions,
                ("hook", "pain_reversal", "example_step", "cta"),
            ))
        ]
        for template_id in ("template-9", "template-10", "template-11", "template-12"):
            with tempfile.TemporaryDirectory(prefix=f"{template_id}-camera-") as temp_dir:
                folder = Path(temp_dir)
                timeline_path = worker.build_remotion_timeline(
                    folder,
                    folder / "source.mp4",
                    folder / "sfx.wav",
                    16.0,
                    "效率提升方法",
                    planned,
                    template_id,
                    {},
                    include_sfx=False,
                    include_bgm=False,
                    transition_points=transition_points,
                )
                timeline = json.loads(timeline_path.read_text("utf-8"))
                camera_cues = timeline.get("cameraCues") or []

                self.assertEqual(len(camera_cues), 4, template_id)
                self.assertEqual(
                    [round(float(item["start"]), 1) for item in camera_cues],
                    [0.0, 4.0, 8.0, 12.0],
                    template_id,
                )
                self.assertGreaterEqual(
                    max(float(item["scale"]) for item in camera_cues)
                    - min(float(item["scale"]) for item in camera_cues),
                    0.14,
                    template_id,
                )
                self.assertTrue(
                    all(str(item.get("move") or "") in {"cut", "snap", "smooth"} for item in camera_cues),
                    template_id,
                )
                self.assertTrue(
                    any(str(item.get("move") or "") == "cut" for item in camera_cues),
                    template_id,
                )
                self.assertTrue(all(float(item.get("easeDuration") or 0) <= .34 for item in camera_cues), template_id)

    def test_input_adaptation_preserves_dynamic_and_non_portrait_sources(self) -> None:
        static = worker.build_input_adaptation_profile(
            {"width": 1080, "height": 1920, "duration": 30.0},
            [15.0],
        )
        dynamic = worker.build_input_adaptation_profile(
            {"width": 1920, "height": 1080, "duration": 30.0},
            [2.0, 5.0, 8.0, 11.0, 14.0, 17.0],
        )
        self.assertEqual(static["activity"], "static-talking-head")
        self.assertEqual(static["sourceFit"], "cover")
        self.assertEqual(dynamic["activity"], "dynamic-source")
        self.assertEqual(dynamic["sourceFit"], "contain-blur")
        self.assertLess(dynamic["cameraStrength"], static["cameraStrength"])
        self.assertLess(dynamic["transitionDensity"], static["transitionDensity"])

    def test_semantic_transition_plan_keeps_reason_and_avoids_stacked_effects(self) -> None:
        profile = worker.template_profile("template-9")
        planned = [
            {**caption, "contentNode": node}
            for caption, node in zip(
                self.captions,
                ("hook", "pain_reversal", "example_step", "cta"),
            )
        ]
        adaptation = worker.build_input_adaptation_profile(
            {"width": 1080, "height": 1920, "duration": 16.0},
            [4.1],
        )
        cues = worker.plan_semantic_transition_cues(
            planned,
            [4.1],
            [],
            [],
            16.0,
            profile,
            adaptation,
        )
        self.assertTrue(cues)
        self.assertEqual(cues[0]["style"], "source-cut")
        self.assertEqual(cues[0]["reason"], "原片镜头切换")
        self.assertTrue(all(item.get("reason") and item.get("trigger") for item in cues))

    def test_precomputed_director_intents_override_generic_node_routing(self) -> None:
        profile = worker.template_profile("template-9")
        planned = [
            {
                **self.captions[0],
                "contentNode": "hook",
                "cameraIntent": "hold",
                "transitionIntent": "none",
                "sfxRole": "none",
            },
            {
                **self.captions[1],
                "contentNode": "pain_reversal",
                "cameraIntent": "reframe",
                "transitionIntent": "matched-reframe",
                "sfxRole": "reversal",
            },
            {
                **self.captions[2],
                "contentNode": "example_step",
                "cameraIntent": "close-up",
                "transitionIntent": "focus-bridge",
                "sfxRole": "step",
            },
            {
                **self.captions[3],
                "contentNode": "cta",
                "cameraIntent": "pull-back",
                "transitionIntent": "foreground-occlusion",
                "sfxRole": "cta",
            },
        ]
        routed = worker.semantic_caption_plan(planned, "效率提升方法", profile.get("content_director"))
        self.assertEqual(routed[1]["materialRoute"]["camera"], "reframe")
        self.assertEqual(routed[1]["materialRoute"]["transition"], "matched-reframe")
        self.assertEqual(routed[1]["semanticRole"], "reversal")

        cues = worker.plan_semantic_transition_cues(
            routed,
            [],
            [],
            [],
            16.0,
            profile,
            worker.build_input_adaptation_profile(
                {"width": 1080, "height": 1920, "duration": 16.0},
                [],
            ),
        )
        styles = {str(item["trigger"]): str(item["style"]) for item in cues}
        self.assertNotIn("none", styles)
        self.assertEqual(styles.get("matched-reframe"), "reframe-cut")
        self.assertEqual(styles.get("focus-bridge"), "focus-rack")
        self.assertEqual(styles.get("foreground-occlusion"), "focus-lock")

    def test_director_plan_contract_preserves_semantic_intents(self) -> None:
        confirmed = [
            {
                **caption,
                "contentNode": node,
                "contentWeight": .82,
                "keyword": "效率",
                "keywordOrigin": "ai",
                "cameraIntent": "push-in",
                "transitionIntent": "cut",
                "sfxRole": "hook",
            }
            for caption, node in zip(
                self.captions,
                ("hook", "pain_reversal", "example_step", "cta"),
            )
        ]
        plan = worker.normalized_director_plan(
            {
                "version": 1,
                "kind": "viral-director-plan",
                "promptVersion": "viral-director-fast-v1",
                "templateId": "template-9",
                "title": "效率提升方法",
                "captions": confirmed,
                "bgmMood": "professional",
                "source": "ai",
                "model": "test-director",
            },
            16.0,
            "template-9",
            worker.normalized_edited_captions(confirmed, 16.0),
        )
        self.assertIsNotNone(plan)
        self.assertEqual(plan["captions"][0]["cameraIntent"], "push-in")
        self.assertEqual(plan["captions"][0]["transitionIntent"], "cut")
        self.assertEqual(plan["captions"][0]["sfxRole"], "hook")

    def test_director_plan_contract_rejects_visual_takeover_and_transcript_drift(self) -> None:
        """AI may direct semantics, but cannot rewrite a locked template or transcript."""
        confirmed = [
            {
                **caption,
                "contentNode": node,
                "keyword": "效率" if index == 0 else "",
                "cameraIntent": "push-in",
                "transitionIntent": "cut",
                "sfxRole": "hook",
            }
            for index, (caption, node) in enumerate(zip(
                self.captions,
                ("hook", "pain_reversal", "example_step", "cta"),
            ))
        ]
        baseline = {
            "version": 1,
            "kind": "viral-director-plan",
            "templateId": "template-9",
            "title": "效率提升方法",
            "captions": confirmed,
            "source": "ai",
        }
        locked = worker.normalized_edited_captions(confirmed, 16.0)

        wrong_template = {**baseline, "templateId": "template-10"}
        self.assertIsNone(worker.normalized_director_plan(
            wrong_template, 16.0, "template-9", locked,
        ))

        rewritten = json.loads(json.dumps(baseline, ensure_ascii=False))
        rewritten["captions"][0]["text"] = "AI擅自改写了用户口播"
        self.assertIsNone(worker.normalized_director_plan(
            rewritten, 16.0, "template-9", locked,
        ))

        retimed = json.loads(json.dumps(baseline, ensure_ascii=False))
        retimed["captions"][1]["start"] = 4.3
        self.assertIsNone(worker.normalized_director_plan(
            retimed, 16.0, "template-9", locked,
        ))

        unsupported = json.loads(json.dumps(baseline, ensure_ascii=False))
        unsupported["captions"][0]["cameraIntent"] = "spin-and-wipe"
        unsupported["captions"][0]["transitionIntent"] = "random-sweep"
        unsupported["captions"][0]["sfxRole"] = "every-word-hit"
        sanitized = worker.normalized_director_plan(
            unsupported, 16.0, "template-9", locked,
        )
        self.assertIsNotNone(sanitized)
        self.assertNotIn("cameraIntent", sanitized["captions"][0])
        self.assertNotIn("transitionIntent", sanitized["captions"][0])
        self.assertNotIn("sfxRole", sanitized["captions"][0])

    def test_four_templates_use_mixed_director_shot_language(self) -> None:
        planned = [
            {**self.captions[0], "contentNode": "hook"},
            {**self.captions[1], "contentNode": "pain_reversal"},
            {**self.captions[2], "contentNode": "example_step"},
            {**self.captions[3], "contentNode": "cta"},
        ]
        adaptation = worker.build_input_adaptation_profile(
            {"width": 1080, "height": 1920, "duration": 16.0},
            [],
        )
        for template_id in ("template-9", "template-10", "template-11", "template-12"):
            cues = worker.plan_semantic_transition_cues(
                planned,
                [],
                [],
                [],
                16.0,
                worker.template_profile(template_id),
                adaptation,
            )
            self.assertTrue(cues, template_id)
            synthetic = [item["style"] for item in cues if item["style"] != "source-cut"]
            self.assertGreaterEqual(len(set(synthetic)), 3, template_id)
            self.assertTrue(
                set(synthetic)
                & {"camera-punch-in", "focus-rack", "jump-reframe", "reframe-cut", "pullback-reset"},
                template_id,
            )
            # A single static talking-head source has no genuine outgoing and
            # incoming scene for a page turn. Folding the same face over itself
            # looks like a decorative glitch, so this director profile must use
            # a real framing change instead. Page turns remain available only
            # when the input analysis reports an actual source scene change.
            self.assertNotIn("page-turn", synthetic, template_id)
            self.assertTrue(all(left != right for left, right in zip(synthetic, synthetic[1:])), template_id)

    def test_four_templates_expose_independent_director_dna(self) -> None:
        identities: set[str] = set()
        coverage_signatures: set[tuple[str, ...]] = set()
        for template_id in ("template-9", "template-10", "template-11", "template-12"):
            profile = worker.template_profile(template_id)
            typography = profile.get("typography_direction") or {}
            camera = profile.get("camera_language") or {}
            transition = profile.get("transition_direction") or {}
            mix = profile.get("mix_direction") or {}

            self.assertEqual(typography.get("policy"), "approved-style-locked", template_id)
            self.assertTrue(camera.get("protect_source_scene_changes"), template_id)
            self.assertGreaterEqual(len(camera.get("style_states") or {}), 6, template_id)
            self.assertGreaterEqual(
                max(float(item.get("scale") or 1) for item in (camera.get("style_states") or {}).values())
                - min(float(item.get("scale") or 1) for item in (camera.get("style_states") or {}).values()),
                .15,
                template_id,
            )
            self.assertIn("random-sweep", transition.get("forbidden") or [], template_id)
            self.assertEqual(mix.get("standard"), "speech-first-v2", template_id)

            identities.add(str(camera.get("identity") or ""))
            coverage_signatures.add(tuple(
                str(item.get("style") or "")
                for item in (transition.get("coverage_cycle") or [])
                if isinstance(item, dict)
            ))
        self.assertEqual(len(identities), 4)
        self.assertEqual(len(coverage_signatures), 4)

    def test_four_templates_share_one_speech_first_mix_standard(self) -> None:
        role_volumes: list[float] = []
        for template_id in ("template-9", "template-10", "template-11", "template-12"):
            profile = worker.template_profile(template_id)
            self.assertEqual(profile.get("sfx_profile", {}).get("mix_standard"), "speech-first-v2")
            cues = worker.build_adaptive_sfx_cues(
                Path(f"/tmp/{template_id}-mix-test"),
                profile,
                16.0,
                [
                    {**self.captions[0], "semanticRole": "hook", "contentNode": "hook", "keyword": "效率", "keywordConfidence": .9, "keywordSfx": False},
                    {**self.captions[1], "semanticRole": "number", "contentNode": "number_benefit", "keyword": "50%", "keywordConfidence": .9, "keywordSfx": True},
                ],
                [],
                "效率提升方法",
            )
            role_volumes.extend(float(item["volume"]) for item in cues if item.get("role") == "number")
        self.assertGreaterEqual(len(role_volumes), 3)
        self.assertLess(max(role_volumes) - min(role_volumes), 0.12)


if __name__ == "__main__":
    unittest.main()
