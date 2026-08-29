import assert from "node:assert/strict";
import { parseAiJsonObject } from "../lib/ai-json.ts";

const withTrailingExplanation = parseAiJsonObject(`\`\`\`json
{"title":"完整自然标题测试","items":[{"id":0}]}
\`\`\`
这是额外解释文字。`);
assert.equal(withTrailingExplanation.title, "完整自然标题测试");
assert.equal(withTrailingExplanation.items.length, 1);

const adjacentObjects = parseAiJsonObject(`{"title":"完整自然标题测试","title_lines":["完整自然","标题测试"]}
{"items":[{"id":0},{"id":1}]}`);
assert.equal(adjacentObjects.title, "完整自然标题测试");
assert.equal(adjacentObjects.items.length, 2);

const duplicatePlans = parseAiJsonObject(`{"title":"旧标题测试内容八字","items":[{"id":0}]}
{"title":"新标题测试内容八字","items":[{"id":0},{"id":1}]}`);
assert.equal(duplicatePlans.title, "新标题测试内容八字");
assert.equal(duplicatePlans.items.length, 2);

console.log("AI JSON parser: OK");
