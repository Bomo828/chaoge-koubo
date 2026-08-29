import { getMemberSession } from "../../../member-session";
import { listMemberAssets, saveCosMemberAsset, saveMemberAsset, saveUploadedMemberAsset } from "../../../../lib/member-assets";
import { videoWorkerUpstreamUrl } from "../../../../lib/server/video-worker";
import { createMemberAssetAccessToken, type MemberAssetAccessPurpose } from "../../../../lib/server/member-asset-access";
import { sanitizeViralWorkflowManifest } from "../../../../lib/viral-workflow";

function clean(value: unknown, fallback: string, max: number) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}

function assetJson(item: Awaited<ReturnType<typeof listMemberAssets>>[number]) {
  const assetPath = `/api/member/assets/${encodeURIComponent(item.id)}`;
  const accessUrl = (purpose: MemberAssetAccessPurpose, parameters?: Record<string, string>) => {
    const search = new URLSearchParams(parameters);
    const token = createMemberAssetAccessToken(item.member_id, item.id, purpose);
    if (token) search.set("access", token);
    const query = search.toString();
    return query ? `${assetPath}?${query}` : assetPath;
  };
  return {
    id: item.id,
    projectName: item.project_name,
    kind: item.kind,
    name: item.name,
    contentType: item.content_type,
    sizeBytes: Number(item.size_bytes),
    // 会员资产接口不返回克隆声音的服务商模型 ID。
    sourceTaskId: item.kind === "voice" ? null : item.source_task_id,
    createdAt: Number(item.created_at) * 1000,
    expiresAt: item.expires_at === null ? null : Number(item.expires_at) * 1000,
    retentionDays: item.kind === "video" ? 7 : item.kind === "image" ? 30 : null,
    // 浏览器播放由资产接口重定向到 COS 的临时签名地址，避免大视频经
    // Next.js/Nginx 二次代理时首段 Range 响应被缓冲或截断。
    mediaUrl: accessUrl("media"),
    // 二次创作仍走同源代理，fetch 读取时不会受到 COS 跨域规则影响。
    importUrl: item.kind === "video" ? accessUrl("import", { stream: "1" }) : accessUrl("media"),
    downloadUrl: accessUrl("download", { download: "1" }),
    coverUrl: item.cover_object_key ? accessUrl("cover", { cover: "1" }) : "",
    viralWorkflow: item.viral_workflow,
  };
}

export async function GET() {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  try {
    const items = await listMemberAssets(member);
    return Response.json({ items: items.map(assetJson) });
  } catch (error) {
    console.error("List member assets failed", error);
    return Response.json({ error: "会员资产暂时无法读取，请稍后重试。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const member = await getMemberSession();
  if (!member) return Response.json({ error: "请先登录会员账号。" }, { status: 401 });
  try {
    if ((request.headers.get("content-type") || "").includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      const cover = form.get("cover");
      const id = clean(form.get("id"), "", 100);
      const kind = ["image", "video", "audio", "voice"].includes(String(form.get("kind"))) ? String(form.get("kind")) as "image" | "video" | "audio" | "voice" : "video";
      if (!(file instanceof File) || file.size < 1) return Response.json({ error: "上传文件无效。" }, { status: 400 });
      if (file.size > 80 * 1024 * 1024) return Response.json({ error: "本地测试生成文件不能超过 80MB。" }, { status: 413 });
      if (!/^[a-zA-Z0-9_-]{8,100}$/.test(id)) return Response.json({ error: "资产编号无效。" }, { status: 400 });
      const saved = await saveUploadedMemberAsset(member, {
        id,
        projectName: clean(form.get("projectName"), "未命名项目", 80),
        kind,
        name: clean(form.get("name"), kind === "video" ? "生成短视频" : "生成文件", 120),
        contentType: file.type || (kind === "video" ? "video/webm" : "application/octet-stream"),
        data: await file.arrayBuffer(),
        coverData: cover instanceof File && cover.size > 0 ? await cover.arrayBuffer() : null,
        coverContentType: cover instanceof File && cover.size > 0 ? cover.type || "image/jpeg" : null,
        sourceTaskId: clean(form.get("sourceTaskId"), "", 120) || null,
        createdAt: Number(form.get("createdAt") || Date.now()),
      });
      return saved ? Response.json({ item: assetJson(saved) }) : Response.json({ error: "资产保存失败。" }, { status: 500 });
    }

    const body = await request.json() as Record<string, unknown>;
    const id = clean(body.id, "", 100);
    const sourceUrl = clean(body.sourceUrl, "", 2_000_000);
    const coverUrl = clean(body.coverUrl, "", 2_000_000);
    const sourceObjectKey = clean(body.sourceObjectKey, "", 1_000);
    const coverObjectKey = clean(body.coverObjectKey, "", 1_000);
    const sourceTaskId = clean(body.sourceTaskId, "", 120) || null;
    const kind = ["image", "video", "audio", "voice"].includes(String(body.kind)) ? String(body.kind) as "image" | "video" | "audio" | "voice" : "image";
    const viralWorkflow = kind === "video" ? sanitizeViralWorkflowManifest(body.viralWorkflow) : null;
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(id)) return Response.json({ error: "资产编号无效。" }, { status: 400 });
    if (kind === "video" && sourceObjectKey && sourceTaskId) {
      const statusResponse = await fetch(`${videoWorkerUpstreamUrl()}/v1/jobs/${encodeURIComponent(sourceTaskId)}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
      const status = await statusResponse.json().catch(() => null) as {
        state?: string;
        result_object_key?: string;
        cover_object_key?: string;
        result_size?: number;
      } | null;
      if (!statusResponse.ok || status?.state !== "success" || status.result_object_key !== sourceObjectKey) {
        return Response.json({ error: "云端成片校验失败，请稍后重试保存。" }, { status: 400 });
      }
      const saved = await saveCosMemberAsset(member, {
        id,
        projectName: clean(body.projectName, "未命名项目", 80),
        kind,
        name: clean(body.name, "生成短视频", 120),
        objectKey: sourceObjectKey,
        contentType: "video/mp4",
        sizeBytes: Math.max(0, Number(status.result_size || 0)),
        sourceTaskId,
        coverObjectKey: status.cover_object_key === coverObjectKey ? coverObjectKey || null : null,
        coverContentType: coverObjectKey ? "image/jpeg" : null,
        createdAt: Number(body.createdAt || Date.now()),
        viralWorkflow,
      });
      return saved ? Response.json({ item: assetJson(saved) }) : Response.json({ error: "资产保存失败。" }, { status: 500 });
    }
    if (!/^https?:\/\//i.test(sourceUrl) && !/^data:/i.test(sourceUrl)) return Response.json({ error: "资产来源无效。" }, { status: 400 });
    const saved = await saveMemberAsset(member, {
      id,
      projectName: clean(body.projectName, "未命名项目", 80),
      kind,
      name: clean(body.name, kind === "video" ? "生成短视频" : "生成图片", 120),
      sourceUrl,
      coverUrl: /^https?:\/\//i.test(coverUrl) ? coverUrl : undefined,
      sourceTaskId,
      createdAt: Number(body.createdAt || Date.now()),
      viralWorkflow,
    });
    return saved ? Response.json({ item: assetJson(saved) }) : Response.json({ error: "资产保存失败。" }, { status: 500 });
  } catch (error) {
    console.error("Save member asset failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "资产保存失败。" }, { status: 500 });
  }
}
