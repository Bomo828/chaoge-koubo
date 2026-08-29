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
            self.assertGreaterEqual(
                sum(bool(str(item.get("keyword") or "").strip()) for item in planned),
                2,
            )
            key_sfx_items = [item for item in planned if item.get("keywordSfx") is True]
            self.assertGreaterEqual(len(key_sfx_items), 1)
            self.assertLessEqual(len(key_sfx_items), 2)
            self.assertTrue(all(str(item.get("keyword") or "").strip() for item in key_sfx_items))
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
            self.assertTrue(any(cue.get("role") not in {"opening", "ending"} for cue in cues))
            self.assertTrue(all(str(cue.get("file") or "").startswith(f"sfx/{template_id}/") for cue in cues))

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
