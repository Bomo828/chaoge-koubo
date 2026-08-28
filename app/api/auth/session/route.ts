import { getMemberSession } from "../../../member-session";

export const dynamic = "force-dynamic";

export async function GET() {
  const member = await getMemberSession();
  return Response.json(
    { member },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
