// Topology (Phase 4): same-origin API proxy.
//
// The browser talks to the API through this Next.js rewrite so the session
// cookie set by /auth/verify is FIRST-PARTY (Origin === the web app). Set the
// server-side upstream with MIDMAN_API_INTERNAL_URL (preferred: an internal
// service address) or NEXT_PUBLIC_API_URL. The client base defaults to "/api"
// (see lib/api.ts) so every fetch is same-origin and `credentials: include`
// cookies flow without a CORS preflight.
//
// If the deployment must keep a SEPARATE API origin (no rewrite possible), the
// API MUST answer CORS with `Access-Control-Allow-Origin: <web origin>` (not
// "*") and `Access-Control-Allow-Credentials: true`, and the web MUST call the
// absolute origin directly (NEXT_PUBLIC_API_URL) with credentials include.
// Cookie attributes then require SameSite=None; Secure on the API origin.

const DEFAULT_API_ORIGIN = "http://localhost:3001";

function apiOrigin() {
  const raw = process.env.MIDMAN_API_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_ORIGIN;
  return raw.trim().replace(/\/+$/, "");
}

/** @type {import("next").NextConfig} */
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiOrigin()}/:path*` }];
  },
};

export default config;
