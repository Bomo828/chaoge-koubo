import { getMemberSession } from "../../../../member-session";
import { aiErrorResponse, lk888Fetch } from "../../../../../lib/lk888";

type ModelList = { models?: Array<{ name?: string; display_name?: string; description?: string; tags?: string[] }> };

const preferred = ["gpt-5.4-mini", "gpt-5.4", "gemini-3.5-flash", "qwen3.5-flash", "deepseek-v3.2"];

export async function GET() {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  try {
    const result = await lk888Fetch<ModelList>("/v1/skills/models?type=chat", { cache: "no-store" });
    const models = (result.models || [])
      .filter((item) => typeof item.name === "string" && preferred.includes(item.name))
      .sort((left, right) => preferred.indexOf(left.name || "") - preferred.indexOf(right.name || ""))
      .map((item) => ({ name: item.name, displayName: item.display_name || item.name, description: item.description || "", tags: item.tags || [] }));
    return Response.json({ models });
  } catch (error) {
    return aiErrorResponse(error);
  }
}
