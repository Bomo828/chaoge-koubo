import { getMemberSession } from "../../../member-session";
import { chanjingErrorResponse, listAllCommonVoices } from "../../../../lib/chanjing";

export async function GET() {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });

  try {
    const voices = await listAllCommonVoices();
    return Response.json({ voices }, {
      headers: { "Cache-Control": "private, max-age=300" },
    });
  } catch (error) {
    return chanjingErrorResponse(error);
  }
}
