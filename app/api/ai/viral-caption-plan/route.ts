import { getMemberSession } from "../../../member-session";
import { planViralCaptionDirector } from "../../../../lib/server/viral-caption-director";

/**
 * Both first-time planning and manual retry use the same content director.
 * ASR/upstream jobs own timing; this endpoint owns the one semantic decision.
 */
export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  try {
    const result = await planViralCaptionDirector({
      captions: body.captions,
      duration: Math.max(1, Math.min(600, Number(body.duration) || 600)),
      script: typeof body.script === "string" ? body.script : "",
      templateId: typeof body.templateId === "string" ? body.templateId : "template-9",
    });
    return Response.json(result);
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "没有可用于网感剪辑的字幕时间轴。",
    }, { status: 400 });
  }
}
