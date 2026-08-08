import { getMemberSession } from "../../../../../member-session";
import { getMemberAsset } from "../../../../../../lib/member-assets";
import { isAdmin } from "../../../../../../lib/server/auth";
import { listClonedVoicesForAdmin } from "../../../../../../lib/server/cloned-voices";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const admin = await getMemberSession();
  if (!isAdmin(admin)) return Response.json({ error: "需要管理员权限。" }, { status: 403 });
  const { id } = await context.params;
  const voice = listClonedVoicesForAdmin().find((item) => item.id === id);
  if (!voice?.sampleAssetId) return Response.json({ error: "这个声音暂时没有试听样本。" }, { status: 404 });
  const asset = await getMemberAsset({
    id: voice.ownerId,
    username: voice.ownerUsername,
    displayName: voice.ownerName,
    level: "basic",
    points: 0,
    role: "member",
  }, voice.sampleAssetId);
  if (!asset) return Response.json({ error: "试听样本不存在。" }, { status: 404 });
  return new Response(asset.object.body, {
    headers: {
      "Content-Type": asset.row.content_type,
      "Content-Length": String(asset.object.size || asset.row.size_bytes),
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
