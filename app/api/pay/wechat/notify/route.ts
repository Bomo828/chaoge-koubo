import { handleWechatNotification, wechatPayErrorResponse } from "../../../../../lib/server/wechat-pay";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    handleWechatNotification(request.headers, await request.text());
    return Response.json({ code: "SUCCESS", message: "成功" });
  } catch (error) {
    const response = wechatPayErrorResponse(error);
    if (response) {
      const data = await response.json() as { error?: string };
      return Response.json({ code: "FAIL", message: data.error || "回调处理失败" }, { status: response.status });
    }
    return Response.json({ code: "FAIL", message: "回调处理失败" }, { status: 500 });
  }
}
