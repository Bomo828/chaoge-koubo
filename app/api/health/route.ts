import { getDatabase } from "../../../lib/server/db";

export const runtime = "nodejs";

export async function GET() {
  try {
    getDatabase().prepare("SELECT 1 AS ok").get();
    return Response.json({ status: "ok", service: "merchant-studio-web", time: new Date().toISOString() });
  } catch {
    return Response.json({ status: "error", service: "merchant-studio-web" }, { status: 503 });
  }
}
