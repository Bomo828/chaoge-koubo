import { listTemplates } from "../../../../lib/server/admin-data";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const category = new URL(request.url).searchParams.get("category") || undefined;
  return Response.json(
    { items: listTemplates({ category }) },
    { headers: { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" } },
  );
}
