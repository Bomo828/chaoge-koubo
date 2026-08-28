import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // The development toolbar overlaps the compact wallet in the studio sidebar.
  // Keep local previews visually identical to the deployed interface.
  devIndicators: false,
  // Local testing may be opened through localhost, 127.0.0.1, or the Mac's
  // LAN address. Allow those origins so the client bundle can hydrate and
  // interactive controls such as the login modal keep working.
  allowedDevOrigins: ["localhost", "127.0.0.1", "192.168.100.14"],
  experimental: {
    // Imported source videos are relayed through the App Router before they
    // reach the video worker. Keep this aligned with the worker and Nginx
    // limits so valid videos are not rejected by Next's smaller default.
    proxyClientMaxBodySize: "500mb",
    // Vinext also applies this server-action limit to App Router API uploads.
    // Lip-sync uploads are validated again in the route and capped at 200MB.
    serverActions: {
      bodySizeLimit: "200mb",
    },
  },
  async headers() {
    const longLivedMediaCache = "public, max-age=604800, s-maxage=31536000, stale-while-revalidate=86400";
    return [
      {
        source: "/media/:path*",
        headers: [
          { key: "Cache-Control", value: longLivedMediaCache },
          { key: "Accept-Ranges", value: "bytes" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
      {
        source: "/template-covers/:path*",
        headers: [{ key: "Cache-Control", value: longLivedMediaCache }],
      },
      {
        source: "/industry-image-lab/:path*",
        headers: [{ key: "Cache-Control", value: longLivedMediaCache }],
      },
      {
        source: "/ffmpeg/:path*",
        headers: [{ key: "Cache-Control", value: longLivedMediaCache }],
      },
    ];
  },
};

export default nextConfig;
