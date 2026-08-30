import assert from "node:assert/strict";
import {
  buildViralCaptionTokenTimeline,
  compileViralSemanticCaptionPlan,
} from "../lib/viral-caption-ai-skill";
import { viralCaptionTemplateContract } from "../lib/viral-caption-contract";

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

console.log("viral semantic caption skill contract: ok");
