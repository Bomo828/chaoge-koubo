import assert from "node:assert/strict";
import {
  buildViralCaptionTokenTimeline,
  compileViralSemanticCaptionPlan,
} from "../lib/viral-caption-ai-skill";
import {
  compileViralCaptionCues,
  viralCaptionTemplateContract,
  viralCaptionUnitCount,
} from "../lib/viral-caption-contract";

function timedWords(values: string[], offset = 0) {
  return values.map((text, index) => ({
    start: Number((offset + index * 0.4).toFixed(3)),
    end: Number((offset + index * 0.4 + 0.34).toFixed(3)),
    text,
  }));
}

const firstWords = timedWords(["第一步", "先", "分析", "需求", "第二步"]);
const secondWords = timedWords(["再", "准备", "执行", "方案"], 2);
const timeline = buildViralCaptionTokenTimeline([
  { start: 0, end: 1.94, text: "第一步先分析需求，第二步", words: firstWords },
  { start: 2, end: 3.54, text: "再准备执行方案", words: secondWords },
]);

assert.equal(timeline.precision, "word", "reliable word timing should be preferred");
assert.deepEqual(timeline.tokens.map((token) => token.id), [0, 1, 2, 3, 4, 5, 6, 7, 8]);

const compiled = compileViralSemanticCaptionPlan({
  timeline,
  contract: viralCaptionTemplateContract("template-9"),
  value: [
    {
      a: 0, b: 3, x: "第一步先分析需求", l: ["第一步先", "分析需求"],
      k: "分析需求", p: "primary", z: "First analyze demand", n: "example_step", w: 0.9,
    },
    {
      a: 4, b: 8, x: "第二步再准备执行方案", l: ["第二步再准备", "执行方案"],
      k: "执行方案", p: "regular", z: "Then prepare the plan", n: "example_step", w: 0.8,
    },
  ],
});

assert.equal(compiled.error, "");
assert.deepEqual(compiled.cues.map((cue) => cue.text), ["第一步先分析需求", "第二步再准备执行方案"]);
assert.equal(compiled.cues[0].end, firstWords[3].end, "cue end must come from the last selected word");
assert.equal(compiled.cues[1].start, firstWords[4].start, "a step label attached to the previous ASR sentence must move with its real time");
assert.equal(compiled.cues.map((cue) => cue.words?.map((word) => word.text).join("")).join(""), "第一步先分析需求第二步再准备执行方案");

const skipped = compileViralSemanticCaptionPlan({
  timeline,
  contract: viralCaptionTemplateContract("template-9"),
  value: [
    { a: 0, b: 2, x: "第一步先分析", l: ["第一步", "先分析"], k: "", p: "none", z: "" },
    { a: 4, b: 8, x: "第二步再准备执行方案", l: ["第二步再准备", "执行方案"], k: "", p: "none", z: "" },
  ],
});
assert.equal(skipped.cues.length, 0);
assert.match(skipped.error, /连续覆盖/);

const segmentTimeline = buildViralCaptionTokenTimeline([
  { start: 0, end: 0.8, text: "虽然预算有限" },
  { start: 0.9, end: 1.8, text: "但是方案仍然可行" },
]);
assert.equal(segmentTimeline.precision, "segment");
const segmentPlan = compileViralSemanticCaptionPlan({
  timeline: segmentTimeline,
  contract: viralCaptionTemplateContract("template-11"),
  value: [{
    a: 0, b: 1, x: "虽然预算有限但是方案仍然可行", l: ["虽然预算有限", "但是方案仍然可行"],
    k: "方案可行", p: "regular", z: "The plan remains feasible", n: "pain_reversal", w: 0.8,
  }],
});
assert.equal(segmentPlan.error, "");
assert.equal(segmentPlan.cues[0].start, 0);
assert.equal(segmentPlan.cues[0].end, 1.8);
assert.equal(segmentPlan.cues[0].words, undefined, "sentence fallback must not pretend to have word timing");

const causalWords = timedWords(["因为", "客户", "需求", "变化", "所以", "方案", "需要", "调整"]);
const causalTimeline = buildViralCaptionTokenTimeline([{
  start: 0,
  end: causalWords.at(-1)!.end,
  text: "因为客户需求变化，所以方案需要调整",
  words: causalWords,
}]);
const danglingPlan = compileViralSemanticCaptionPlan({
  timeline: causalTimeline,
  contract: viralCaptionTemplateContract("template-10"),
  value: [
    { a: 0, b: 0, x: "因为", l: ["因为"], k: "", p: "none", z: "" },
    { a: 1, b: 7, x: "客户需求变化所以方案需要调整", l: ["客户需求变化", "所以方案需要调整"], k: "需求变化", p: "regular", z: "" },
  ],
});
assert.equal(danglingPlan.cues.length, 0);
assert.match(danglingPlan.error, /语义边界/);

const mixedWords = timedWords(["升级", "Pro版", "每月", "节省", "30%", "运营成本"]);
const mixedTimeline = buildViralCaptionTokenTimeline([{
  start: 0,
  end: mixedWords.at(-1)!.end,
  text: "升级Pro版每月节省30%运营成本",
  words: mixedWords,
}]);
const mixedPlan = compileViralSemanticCaptionPlan({
  timeline: mixedTimeline,
  contract: viralCaptionTemplateContract("template-11"),
  value: [{
    a: 0, b: 5, x: "升级Pro版每月节省30%运营成本", l: ["升级Pro版每月", "节省30%运营成本"],
    k: "30%", p: "primary", z: "Save 30% monthly", n: "number_benefit", w: 0.95,
  }],
});
assert.equal(mixedPlan.error, "");
assert.equal(mixedPlan.cues[0].keyword, "30%");

const oversizedWords = timedWords(["门店运营", "经常遇到", "获客成本高", "但是", "通过优化内容", "可以提高转化率"]);
const oversizedTimeline = buildViralCaptionTokenTimeline([{
  start: 0,
  end: oversizedWords.at(-1)!.end,
  text: "门店运营经常遇到获客成本高，但是通过优化内容可以提高转化率",
  words: oversizedWords,
}]);
const repairedOversizedPlan = compileViralSemanticCaptionPlan({
  timeline: oversizedTimeline,
  contract: viralCaptionTemplateContract("template-9"),
  value: [{
    a: 0, b: 5, x: "门店运营经常遇到获客成本高但是通过优化内容可以提高转化率",
    l: ["门店运营经常遇到获客成本高", "但是通过优化内容可以提高转化率"],
    k: "提高转化率", p: "primary", z: "Optimize content to improve conversion",
    n: "pain_reversal", w: 0.92,
  }],
});
assert.equal(repairedOversizedPlan.error, "", "one oversized AI cue should be repaired instead of rejecting the whole plan");
assert.ok(repairedOversizedPlan.autoSplitCount >= 1);
assert.ok(repairedOversizedPlan.cues.length >= 2);
assert.ok(repairedOversizedPlan.cues.every((cue) => viralCaptionUnitCount(cue.text) <= 14));
assert.ok(repairedOversizedPlan.cues.every((cue) => cue.captionLines.every((line) => viralCaptionUnitCount(line) <= 7)));
assert.equal(
  repairedOversizedPlan.cues.flatMap((cue) => cue.words || []).map((word) => word.text).join(""),
  oversizedWords.map((word) => word.text).join(""),
  "capacity repair must preserve every confirmed word exactly once",
);
assert.equal(repairedOversizedPlan.cues.filter((cue) => cue.keyword === "提高转化率").length, 1);

// Regression: a causative verb can legitimately begin a complete subtitle
// phrase.  Treating every leading “让” as an orphan used to reject the whole
// AI plan even though the ASR timeline contained a clean semantic boundary.
const causativeCapacityWords = timedWords(["最大的特点就是", "让口播脱离了死", "板的叙事"]);
const causativeCapacityTimeline = buildViralCaptionTokenTimeline([{
  start: 0,
  end: causativeCapacityWords.at(-1)!.end,
  text: "最大的特点就是让口播脱离了死板的叙事",
  words: causativeCapacityWords,
}]);
const causativeCapacityPlan = compileViralSemanticCaptionPlan({
  timeline: causativeCapacityTimeline,
  contract: viralCaptionTemplateContract("template-9"),
  value: [{
    a: 0, b: 2, x: "最大的特点就是让口播脱离了死板的叙事",
    l: ["最大的特点就是", "让口播脱离了死板的叙事"],
    k: "死板的叙事", p: "primary", z: "Make talking-head videos feel less rigid",
    n: "core_viewpoint", w: 0.94,
  }],
});
assert.equal(causativeCapacityPlan.error, "", "a complete phrase beginning with 让 must remain a valid semantic unit");
assert.ok(causativeCapacityPlan.autoSplitCount >= 1);
assert.equal(causativeCapacityPlan.cues[0].text, "最大的特点就是");
assert.equal(
  causativeCapacityPlan.cues.flatMap((cue) => cue.words || []).map((word) => word.text).join(""),
  causativeCapacityWords.map((word) => word.text).join(""),
);
assert.ok(causativeCapacityPlan.cues.every((cue) => cue.captionLines.every((line) => viralCaptionUnitCount(line) <= 7)));

const unsafeSegmentPlan = compileViralSemanticCaptionPlan({
  timeline: buildViralCaptionTokenTimeline([{
    start: 0,
    end: 3,
    text: "这一整条上游字幕非常长而且完全没有任何可以使用的词级时间",
  }]),
  contract: viralCaptionTemplateContract("template-9"),
  value: [{
    a: 0, b: 0, x: "这一整条上游字幕非常长而且完全没有任何可以使用的词级时间",
    l: ["这一整条上游字幕非常长", "而且完全没有任何可以使用的词级时间"],
    k: "", p: "none", z: "",
  }],
});
assert.equal(unsafeSegmentPlan.cues.length, 0);
assert.match(unsafeSegmentPlan.error, /缺少词级时间/);

const sentenceOnlyCompiled = compileViralCaptionCues([{
  start: 2,
  end: 5,
  text: "这一整条字幕很长但是上游没有提供任何真实的词级时间",
}], "template-9");
assert.equal(sentenceOnlyCompiled.length, 1, "sentence-only timing must stay one cue instead of producing overlapping rows");
assert.equal(sentenceOnlyCompiled[0].start, 2);
assert.equal(sentenceOnlyCompiled[0].end, 5);
assert.equal(
  sentenceOnlyCompiled[0].text,
  "这一整条字幕很长但是上游没有提供任何真实的词级时间",
  "visual capacity must never be solved by inventing subtitle time",
);

console.log("viral semantic caption skill contract: ok");
