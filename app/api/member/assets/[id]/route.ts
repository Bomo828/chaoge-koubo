import { getMemberSession } from "../../../../member-session";
import { deleteMemberAsset, getMemberAsset, getMemberAssetCover, getMemberAssetDirectUrl } from "../../../../../lib/member-assets";

function filenameWithExtension(name: string, contentType: string) {
  if (/\.[a-z0-9]{2,5}$/i.test(name)) return name;
  const extension = contentType.includes("webm")
    ? "webm"
    : contentType.includes("mp4")
      ? "mp4"
      : contentType.includes("jpeg")
        ? "jpg"
        : contentType.includes("png")
          ? "png"
          : contentType.includes("webp")
            ? "webp"
            : contentType.includes("mpeg")
              ? "mp3"
              : "bin";
  return `${name}.${extension}`;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  const { id } = await context.params;
  const searchParams = new URL(request.url).searchParams;
  const cover = searchParams.get("cover") === "1";
  const download = searchParams.get("download") === "1";
  const stream = searchParams.get("stream") === "1";
  const directUrl = stream ? "" : getMemberAssetDirectUrl(member, id, cover, download);
  if (directUrl) {
    return new Response(null, {
      status: 307,
      headers: {
        Location: directUrl,
        "Cache-Control": download ? "private, no-store" : "private, max-age=900",
      },
    });
  }
  if (cover) {
    const image = await getMemberAssetCover(member, id);
    if (!image) return Response.json({ error: "没有找到这个视频封面。" }, { status: 404 });
    return new Response(image.body, {
      headers: {
        "Content-Type": image.contentType,
        "Content-Length": String(image.size),
        "Content-Disposition": "inline",
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  const asset = await getMemberAsset(member, id, request.headers.get("range") || "");
  if (!asset) return Response.json({ error: "没有找到这个会员资产。" }, { status: 404 });
  const filename = filenameWithExtension(asset.row.name, asset.row.content_type);
  const responseContentType = asset.object.httpMetadata.contentType || asset.row.content_type;
  const contentType = responseContentType === "application/octet-stream" && asset.row.kind === "video"
    ? asset.row.object_key.toLowerCase().endsWith(".webm") ? "video/webm" : "video/mp4"
    : responseContentType;
  const headers = new Headers({
    "Content-Type": contentType,
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": download ? "private, no-store" : "private, max-age=86400",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
  });
  const size = asset.object.size || asset.row.size_bytes;
  if (size) headers.set("Content-Length", String(size));
  if (asset.object.range) {
    headers.set("Content-Range", `bytes ${asset.object.range.start}-${asset.object.range.end}/${asset.object.range.total}`);
  }
  return new Response(asset.object.body, {
    status: asset.object.range ? 206 : 200,
    headers,
  });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  const { id } = await context.params;
  return Response.json({ deleted: await deleteMemberAsset(member, id) });
}
