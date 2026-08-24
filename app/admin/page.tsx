import type { Metadata } from "next";
import { requireAdminSession } from "../member-session";
import { adminStats, listTemplates, listUsers } from "../../lib/server/admin-data";
import { getPlatformSettings } from "../../lib/server/platform-settings";
import { listClonedVoicesForAdmin } from "../../lib/server/cloned-voices";
import { listInvitations } from "../../lib/server/invitations";
import { AdminClient } from "./admin-client";
import "./admin.css";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "管理后台" };

export default async function AdminPage() {
  const member = await requireAdminSession("/admin");
  return <AdminClient
    member={member}
    initialStats={adminStats()}
    initialTemplates={listTemplates({ includeDrafts: true })}
    initialUsers={listUsers()}
    initialVoices={listClonedVoicesForAdmin()}
    initialInvitations={listInvitations()}
    initialSettings={getPlatformSettings()}
  />;
}
