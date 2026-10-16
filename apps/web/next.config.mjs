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

// Security headers for every page. The app asks users to sign financial
// actions, so framing is forbidden outright (clickjacking). CSP keeps scripts
// same-origin; 'unsafe-inline' is needed for Next's inline bootstrap and the
// inline style attributes. connect-src allows https/wss for wallet RPCs.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

/** @type {import("next").NextConfig} */
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiOrigin()}/:path*` }];
  },
};

export default config;
