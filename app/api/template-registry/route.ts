import { listTemplates } from "../../../lib/server/admin-data";

export const runtime = "nodejs";

export async function GET() {
  const templates = listTemplates({ category: "viral_video" });
  return Response.json({
    schema_version: 1,
    updated_at: new Date().toISOString(),
    templates: templates.map((template) => {
      const learnedTemplate =
        template.config.learnedTemplate &&
        typeof template.config.learnedTemplate === "object" &&
        !Array.isArray(template.config.learnedTemplate)
          ? template.config.learnedTemplate
          : null;

      return {
        id: template.slug,
        name: template.name,
        version: template.version,
        status: template.status,
        category: "真人口播",
        description: template.description,
        preview_url: template.previewUrl,
        cover_url: template.coverUrl,
        ...template.config,
        // The video worker consumes `package`. Previously the learned result
        // was only exposed as `learnedTemplate`, so the renderer silently fell
        // back to its built-in template and merely changed the catalog colour.
        package: learnedTemplate,
      };
    }),
  }, {
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "CDN-Cache-Control": "no-store",
    },
  });
}
