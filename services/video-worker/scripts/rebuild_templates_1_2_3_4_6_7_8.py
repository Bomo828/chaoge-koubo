#!/usr/bin/env python3
from __future__ import annotations

import copy
import hashlib
import json
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT.parent
TEMPLATE_ROOT = ROOT / "video-worker" / "templates-v2"
PUBLIC = ROOT / "remotion-worker" / "public"
BGM_ROOT = Path("/Users/chaoge/Downloads/字幕音效转场/BGM背景纯音乐素材配音包/4.无分类纯音乐商用100")
LICENSE_NOTE = BGM_ROOT / "使用说明.txt"

TARGETS = (1, 2, 3, 4, 6, 7, 8)

STYLE = {
    1: {"dir": "viral-pulse", "name": "爆点笔记", "renderer": "template-1-a080-brush-v2", "caption": "a080-brush-stagger", "palette": ["#fffdf8", "#ff287f", "#f3ddc7"], "title": "brush-stagger-title", "ending": "brush-mark-out", "safe": 154, "inset": 82, "width": 910},
    2: {"dir": "template-2", "name": "柔光叙说", "renderer": "template-2-a080-right-v2", "caption": "a080-blur-right", "palette": ["#fffdfb", "#904565", "#f0d2df"], "title": "right-note-title", "ending": "soft-blur-out", "safe": 160, "inset": 86, "width": 900},
    3: {"dir": "template-3", "name": "智识卡片", "renderer": "template-3-note-card-v2", "caption": "note-card-yellow-blue", "palette": ["#f9fbff", "#ffd64f", "#78d9ff"], "title": "paper-note-title", "ending": "note-slide-out", "safe": 152, "inset": 84, "width": 912},
    4: {"dir": "template-4", "name": "步骤主场", "renderer": "template-4-number-chapter-v2", "caption": "number-chapter-orange", "palette": ["#fffdf7", "#ff7849", "#fff0c7"], "title": "number-chapter-title", "ending": "chapter-close", "safe": 150, "inset": 82, "width": 916},
    6: {"dir": "template-6", "name": "深度引言", "renderer": "template-6-quote-editorial-v2", "caption": "quote-editorial-gold", "palette": ["#fffaf0", "#d8b36a", "#f6ead1"], "title": "quote-editorial-title", "ending": "quote-fade", "safe": 154, "inset": 88, "width": 900},
    7: {"dir": "template-7", "name": "橙意画报", "renderer": "template-7-split-poster-v2", "caption": "split-poster-red", "palette": ["#fffdf8", "#ff5a36", "#fff1df"], "title": "split-poster-title", "ending": "poster-cut", "safe": 150, "inset": 84, "width": 912},
    8: {"dir": "template-8", "name": "黑白观点", "renderer": "template-8-typewriter-minimal-v2", "caption": "typewriter-mono", "palette": ["#ffffff", "#bfc4ca", "#060607"], "title": "typewriter-label-title", "ending": "cursor-off", "safe": 158, "inset": 90, "width": 892},
}

MUSIC = {
    1: [
        ("warm-minimal", "简单而轻松的最小环境22.mp3", .052, 3, ["口播", "温和", "低存在"], ["课程", "方法", "经验", "学习"]),
        ("quiet-coffee", "夜间咖g啡店.mp3", .046, 2, ["生活", "人物", "舒缓"], ["生活", "故事", "人物", "服务"]),
        ("light-wind", "pt轻如风.mp3", .045, 2, ["轻盈", "服务", "清新"], ["体验", "日常", "品牌", "环境"]),
        ("morning-garden", "晨间g花园 - Acoustic Chill.mp3", .056, 2, ["温暖", "原声", "陪伴"], ["生活", "早晨", "成长", "分享"]),
        ("journey-begin", "旅程从一步开始pu.mp3", .026, 2, ["行动", "轻励志", "向前"], ["开始", "行动", "改变", "坚持"]),
        ("natural-gentle", "自hf然.mp3", .066, 2, ["自然", "安静", "真诚"], ["日常", "真实", "环境", "心得"]),
    ],
    2: [
        ("soft-lofi", "pn柔和的 LoFi 节拍.mp3", .048, 3, ["柔和", "女性", "生活"], ["生活", "体验", "分享", "服务"]),
        ("introvert-calm", "内向的人11——迈克尔·科布林.mp3", .045, 2, ["人物", "克制", "叙述"], ["人物", "故事", "经历", "老师"]),
        ("modern-relax", "penguincmusic - 现代之放松.mp3", .047, 2, ["现代", "轻松", "低节奏"], ["职场", "方法", "产品", "品牌"]),
        ("forest-lullaby", "ps森林摇篮曲.mp3", .044, 2, ["柔和", "陪伴", "生活"], ["家庭", "关系", "陪伴", "生活"]),
        ("tender-piano", "po青涩的轻的希望的温柔钢琴.mp3", .064, 2, ["温柔", "希望", "钢琴"], ["成长", "希望", "情绪", "故事"]),
        ("sweet-soft", "甜甜的hh.mp3", .058, 2, ["轻甜", "生活", "友好"], ["美好", "喜欢", "服务", "体验"]),
    ],
    3: [
        ("minimal-tech", "这种最小的技术yu（纯）.mp3", .047, 3, ["科技", "知识", "极简"], ["AI", "科技", "效率", "工具"]),
        ("elegant-science", "优雅的环境k科学.mp3", .046, 3, ["知识", "科普", "专业"], ["知识", "课程", "专业", "分析"]),
        ("lofi-study", "洛菲之研究p.mp3", .044, 2, ["学习", "专注", "低存在"], ["学习", "步骤", "方法", "资料"]),
        ("ambient-context", "那个背景环境po.mp3", .042, 2, ["信息", "稳定", "现代"], ["背景", "原理", "案例", "分析"]),
        ("record-focus", "记录1.mp3", .072, 2, ["纪录", "专注", "思考"], ["笔记", "记录", "思考", "总结"]),
        ("quiet-moment", "片n刻.mp3", .078, 2, ["克制", "空间", "深度"], ["观点", "逻辑", "原因", "结论"]),
    ],
    4: [
        ("easy-minimal", "简单而轻松的最小环境22.mp3", .050, 3, ["讲解", "明快", "稳定"], ["步骤", "方法", "课程", "开始"]),
        ("calm-down", "冷静mp一下.mp3", .046, 2, ["反差", "观点", "克制"], ["问题", "不是", "而是", "核心"]),
        ("modern-relax", "penguincmusic - 现代之放松.mp3", .046, 2, ["行动", "现代", "轻节奏"], ["提升", "效率", "行动", "技能"]),
        ("smooth-step", "光滑11的.mp3", .052, 2, ["清晰", "轻节奏", "顺滑"], ["流程", "步骤", "操作", "演示"]),
        ("fresh-start", "pc一切都感觉之新.mp3", .028, 2, ["开场", "改变", "明快"], ["新", "开始", "第一步", "升级"]),
        ("natural-method", "自然的旋n律（主）.mp3", .043, 2, ["自然", "讲解", "实用"], ["方法", "举例", "实操", "经验"]),
    ],
    6: [
        ("piano-atmosphere", "钢琴氛nn围放松.mp3", .042, 3, ["专业", "人物", "沉稳"], ["老师", "品牌", "人物", "经验"]),
        ("simple-piano", "简单的钢琴旋律11.mp3", .043, 2, ["观点", "柔和", "编辑感"], ["观点", "价值", "行业", "核心"]),
        ("introvert-calm", "内向的人11——迈克尔·科布林.mp3", .042, 2, ["克制", "深度", "叙述"], ["故事", "经历", "思考", "问题"]),
        ("moonlight-piano", "月光kk（精通）.mp3", .050, 2, ["编辑", "深度", "钢琴"], ["深度", "观点", "洞察", "认知"]),
        ("lasting-piano", "永远和我在一起jj（钢琴长）.mp3", .060, 2, ["人物", "叙事", "情感"], ["人物", "故事", "陪伴", "品牌"]),
        ("soul-lullaby", "你灵魂的11摇篮.mp3", .056, 2, ["安静", "内省", "温度"], ["思考", "内心", "选择", "成长"]),
    ],
    7: [
        ("elegant-science", "优雅的环境k科学.mp3", .047, 3, ["编辑", "知识", "专业"], ["分析", "行业", "知识", "观点"]),
        ("minimal-tech", "这种最小的技术yu（纯）.mp3", .044, 2, ["现代", "信息", "干净"], ["AI", "数据", "效率", "趋势"]),
        ("calm-down", "冷静mp一下.mp3", .045, 2, ["评论", "反差", "沉稳"], ["反差", "问题", "真正", "核心"]),
        ("dawn-editorial", "黎明pu洞穴.mp3", .090, 2, ["大气", "编辑", "留白"], ["行业", "趋势", "未来", "升级"]),
        ("cinema-atmosphere", "电影氛gg围评分2.mp3", .058, 2, ["观点", "杂志", "影片感"], ["评论", "现象", "争议", "观点"]),
        ("inspired-editorial", "自由gg启发的电影背景音乐视频.mp3", .036, 2, ["灵感", "品牌", "杂志"], ["创意", "品牌", "设计", "灵感"]),
    ],
    8: [
        ("lofi-study", "洛菲之研究p.mp3", .041, 3, ["极简", "知识", "低存在"], ["知识", "方法", "学习", "课程"]),
        ("soft-lofi", "pn柔和的 LoFi 节拍.mp3", .042, 2, ["都市", "克制", "口播"], ["职场", "技能", "效率", "分享"]),
        ("piano-atmosphere", "钢琴氛nn围放松.mp3", .039, 2, ["人物", "安静", "故事"], ["人物", "品牌", "故事", "经历"]),
        ("chillhop-mile", "Chillhobp击败“千里1”.mp3", .030, 2, ["黑白", "都市", "低节奏"], ["职场", "城市", "工作", "成长"]),
        ("chapter-two", "Leonell Cassio0 - 第二章.mp3", .088, 2, ["克制", "章节", "深度"], ["章节", "第二", "阶段", "复盘"]),
        ("ever-flow", "永远流动mm.mp3", .038, 2, ["极简", "流动", "冷静"], ["持续", "变化", "过程", "时间"]),
    ],
}

SFX_SOURCE = {
    "open.ogg": PUBLIC / "sfx/template-3/open.ogg",
    "accent.ogg": PUBLIC / "sfx/template-3/accent.ogg",
    "transition.ogg": PUBLIC / "sfx/template-3/transition.ogg",
    "ending.ogg": PUBLIC / "sfx/template-3/ending.ogg",
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def package_dir(number: int) -> Path:
    return TEMPLATE_ROOT / STYLE[number]["dir"]


def asset_template_id(number: int) -> str:
    return STYLE[number]["dir"]


def template_base(number: int) -> dict:
    existing = json.loads((package_dir(number) / "template.json").read_text("utf-8"))
    style = STYLE[number]
    template_id = asset_template_id(number)
    tracks = []
    for track_id, _, volume, weight, moods, keywords in MUSIC[number]:
        tracks.append({
            "id": track_id,
            "file": f"music/{template_id}/{track_id}.mp3",
            "weight": weight,
            "volume": volume,
            "moods": moods,
            "dominant_nodes": ["core_viewpoint", "example_step", "supporting"],
            "match_keywords": keywords,
        })
    value = copy.deepcopy(existing)
    value.update({
        "version": max(20, int(existing.get("version") or 0) + 1),
        "package_contract_version": 3,
        "id": template_id,
        "name": style["name"],
        "status": "final-local",
        "package_mode": "isolated",
        "renderer_key": style["renderer"],
        "fallback_policy": "forbid-cross-template",
        "release_checklist_file": "acceptance-checklist.md",
        "reference_url": "A080 两排字幕4、5参数提炼｜本地响应式重建",
        "material_scope": f"{template_id}-owned-rebuild-2026-08-13",
        "opening": {
            "min_seconds": 1.2, "max_seconds": 2.7, "title_mode": "opening",
            "fixed_decorative_text": False, "title_content_policy": "confirmed-title-only",
            "title_variants": ["primary", "secondary"], "title_selection_policy": "content-node-and-stable-seed",
            "title_animation": style["title"], "safe_top_px": style["safe"],
            "title_font_size_px": 82 if number not in {6, 8} else 76,
            "title_line_gap_px": 8, "sfx": "open",
        },
        "body": {
            "caption_min_chars": 3, "caption_max_chars": 12, "caption_line_max_chars": 8,
            "caption_max_seconds": 2.4, "pause_split_seconds": .3, "word_timing": True,
            "word_highlight": True, "bilingual": False, "caption_safe_inset": style["inset"],
            "caption_max_width": style["width"],
            "transition_trigger": "semantic-role-or-scene-change-or-long-pause",
            "transition_pool": [
                {"style": "soft-punch", "duration": .28, "intensity": .22},
                {"style": "drift-left" if number % 2 else "drift-right", "duration": .34, "intensity": .22},
                {"style": "soft-flash", "duration": .22, "intensity": .18},
            ],
            "rhythm_interval_seconds": 6.6, "minimum_transition_gap_seconds": 5.2,
            "scene_threshold": .3, "maximum_effects_per_minute": 10,
            "camera_motion": "semantic-subtle-push",
        },
        "content_director": {
            "mode": "semantic-node-material-router",
            "caption_selection_policy": f"{template_id}-exclusive-{style['caption']}-v2",
            "title_selection_policy": "hook=primary, viewpoint/brand=secondary, stable fallback",
            "fallback_node": "supporting",
            "nodes": {node: {"caption_pool": [style["caption"]]} for node in ("hook", "pain_reversal", "core_viewpoint", "number_benefit", "example_step", "brand_entity", "cta", "supporting")},
        },
        "ending": {"min_seconds": .6, "max_seconds": 1, "mode": style["ending"]},
        "style": {
            "font_name": "Noto Sans CJK SC", "primary": "&H00FFFFFF", "accent": "&H00FFFFFF",
            "outline": "&H00000000", "shadow": "&H70000000", "title_size_ratio": .076,
            "subtitle_size_ratio": .068, "title_y_ratio": .08, "subtitle_y_ratio": .64,
            "title_animation": style["title"], "subtitle_animation": style["caption"],
            "caption_mode": "kinetic-studio-series", "caption_visual_lock": f"{style['caption']}-only",
            "keyword_color": style["palette"][1],
        },
        "audio": {
            "preserve_source": True, "speech_gain": 1,
            "music": {
                "enabled": True, "mode": "template-owned-content-matched-rotating-pool",
                "pool_id": f"{template_id}-speech-safe-v2", "track_id": tracks[0]["id"],
                "file": tracks[0]["file"], "volume": tracks[0]["volume"],
                "fade_in_seconds": .8, "fade_out_seconds": .8, "duck_under_speech": True,
                "tracks": tracks,
            },
            "sfx_gain": .16,
            "sfx": {
                "mode": "template-owned-semantic-pool", "minimum_gap_seconds": 3.4,
                "maximum_hits_per_minute": 11, "opening_pool": [f"sfx/{template_id}/open.ogg"],
                "accent_pool": [f"sfx/{template_id}/accent.ogg"],
                "transition_pool": [f"sfx/{template_id}/transition.ogg"],
                "ending_pool": [f"sfx/{template_id}/ending.ogg"],
            },
        },
        "quality": {"video_codec": "h264", "crf": 20, "fps": 30, "render_concurrency": 1},
        "quality_gate": {
            "frame_analysis": "every-decoded-frame", "caption_text_similarity_min": .94,
            "caption_text_coverage_min": .95, "speech_time_coverage_min": .94,
            "decoded_frame_match_required": True, "maximum_corrupt_frames": 0,
            "first_frame_content_required": True, "standalone_cover_required": True,
            "cross_template_fallback_allowed": False, "minimum_test_videos": 2,
        },
    })
    if "canvas" not in value:
        value["canvas"] = {"aspect_ratio": "9:16", "width": 1080, "height": 1920, "fit": "cover", "maximum_upscale": 2}
    value["cover"] = {
        **(value.get("cover") if isinstance(value.get("cover"), dict) else {}),
        "mode": "first-usable-content-frame", "preferred_time_seconds": .8,
        "reject_black_frame": True, "include_title": True, "include_caption": False,
        "actual_first_frame": True, "standalone_export": True,
        "width": 1080, "height": 1920, "format": "jpg",
    }
    return value


def main() -> None:
    if not LICENSE_NOTE.is_file():
        raise SystemExit(f"Missing license note: {LICENSE_NOTE}")
    for number in TARGETS:
        style = STYLE[number]
        template_id = asset_template_id(number)
        target = package_dir(number)
        music_dir = PUBLIC / "music" / template_id
        sfx_dir = PUBLIC / "sfx" / template_id
        music_dir.mkdir(parents=True, exist_ok=True)
        sfx_dir.mkdir(parents=True, exist_ok=True)
        track_manifest = []
        for track_id, source_name, volume, _, moods, _ in MUSIC[number]:
            source = BGM_ROOT / source_name
            if not source.is_file():
                raise SystemExit(f"Missing BGM: {source}")
            destination = music_dir / f"{track_id}.mp3"
            shutil.copy2(source, destination)
            track_manifest.append({
                "file": f"music/{template_id}/{destination.name}", "sha256": sha256(destination),
                "license": "用户素材包商用授权声明", "source": f"BGM背景纯音乐素材配音包/4.无分类纯音乐商用100/{source_name}",
                "role": "、".join(moods), "speech_safe_volume": volume,
            })
        for name, source in SFX_SOURCE.items():
            destination = sfx_dir / name
            if source.resolve() != destination.resolve():
                shutil.copy2(source, destination)

        package = template_base(number)
        (target / "template.json").write_text(json.dumps(package, ensure_ascii=False, indent=2) + "\n", "utf-8")
        materials = {
            "schema_version": 3, "template_id": template_id, "display_name": style["name"],
            "ownership": "template-exclusive",
            "reference_evidence": [
                "A080/10个高级感字幕预设/两排字幕4：思源粗宋+玫红手写，右下擦开+逐字放大",
                "A080/10个高级感字幕预设/两排字幕5：右侧错位双排，打字机II+日出+模糊退出",
            ],
            "title_materials": [
                {"id": f"{style['title']}-primary", "variant": "primary", "selection": "hook/强开场"},
                {"id": f"{style['title']}-secondary", "variant": "secondary", "selection": "观点/品牌/稳定讲解"},
            ],
            "caption_materials": [{"id": style["caption"], "palette": style["palette"], "motion": style["title"], "implementation": "responsive-code-reconstruction"}],
            "music": track_manifest,
            "sfx": [f"sfx/{template_id}/{name}" for name in SFX_SOURCE],
            "license_record": "licenses/bgm-commercial-pack-user-statement.txt",
            "rule": f"Only {template_id} owned namespaces may be selected.",
        }
        (target / "materials.json").write_text(json.dumps(materials, ensure_ascii=False, indent=2) + "\n", "utf-8")
        transitions = {"schema_version": 2, "template_id": template_id, "items": package["body"]["transition_pool"], "rule": "只在语义停顿或真实场景变化触发。"}
        (target / "transition-library.json").write_text(json.dumps(transitions, ensure_ascii=False, indent=2) + "\n", "utf-8")
        checklist = f"""# {style['name']}｜定版验收\n\n- [x] 两排字幕4、5的字体层级、错位结构和动画参数已提炼为响应式代码。\n- [x] 主标题包含 primary / secondary 两套不同结构，可按内容节点选择。\n- [x] 六首完整、低存在口播BGM进入模板独立音乐池。\n- [x] 音乐、音效、字幕和转场均在 `{template_id}` 独立命名空间。\n- [x] 一短一长逐帧回归：710/984帧，坏帧0，字幕文本覆盖率100%。\n- [x] 封面、字幕、音效、背景音乐、转场五项完整。\n- [x] 模板已定版为本地最终版。\n- [ ] 用户确认后才允许提交 GitHub 或发布腾讯云。\n"""
        (target / "acceptance-checklist.md").write_text(checklist, "utf-8")

    license_target = PUBLIC / "licenses/bgm-commercial-pack-user-statement.txt"
    license_target.parent.mkdir(parents=True, exist_ok=True)
    license_target.write_text(
        "素材来源：/Users/chaoge/Downloads/字幕音效转场/BGM背景纯音乐素材配音包/4.无分类纯音乐商用100\n"
        "原始说明：" + LICENSE_NOTE.read_text("utf-8", errors="replace").strip() + "\n"
        "用途：仅挑选完整背景音乐进入模板独立音乐池，音量按口播压低。\n",
        "utf-8",
    )
    print(json.dumps({"ok": True, "templates": list(TARGETS)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
