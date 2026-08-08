import vinext from "vinext";
import { defineConfig, loadEnv } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(async ({ mode, command }) => {
  const applicationEnv = loadEnv(mode, process.cwd(), "");
  const localBindingConfig = {
    main: "./worker/index.ts",
    compatibility_flags: ["nodejs_compat"],
    ...(command === "serve" ? {
      vars: {
        LK888_API_KEY: applicationEnv.LK888_API_KEY ?? "",
        LK888_API_BASE_URL: applicationEnv.LK888_API_BASE_URL ?? "https://api.lk888.ai",
        CHANJING_BASE_URL: applicationEnv.CHANJING_BASE_URL ?? "https://open-api.chanjing.cc",
        CHANJING_APP_ID: applicationEnv.CHANJING_APP_ID ?? "",
        CHANJING_SECRET_KEY: applicationEnv.CHANJING_SECRET_KEY ?? "",
        VOICE_SAMPLE_RELAY_BASE_URL: applicationEnv.VOICE_SAMPLE_RELAY_BASE_URL ?? "https://api.chaogeai.top",
      },
    } : {}),
    d1_databases: d1
      ? [
          {
            binding: d1,
            database_name: "site-creator-d1",
            database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
          },
        ]
      : [],
    r2_buckets: r2
      ? [
          {
            binding: r2,
            bucket_name: "site-creator-r2",
          },
        ]
      : [],
  };

  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  // Keep Next/Vinext upload configuration loaded through the normal dev restart.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: {
      // Allow Cloudflare Quick Tunnel hostnames for temporary in-app browser
      // previews while Vite keeps blocking unrelated Host headers.
      allowedHosts: [".trycloudflare.com"],
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        inspectorPort: isCodexSeatbeltSandbox ? false : undefined,
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
