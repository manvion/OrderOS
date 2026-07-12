import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,

  // The shared package ships TypeScript source, not a build artifact — Next
  // compiles it as part of the app so we don't need a watch-and-rebuild step.
  transpilePackages: ['@orderos/shared'],

  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.blob.core.windows.net' },
      { protocol: 'https', hostname: '*.azureedge.net' },
      { protocol: 'http', hostname: 'localhost' },
    ],
  },

  async headers() {
    return [
      {
        /**
         * The embed route is the ONE thing that must be frameable — it is the
         * widget, and it lives inside third-party pages by design. The blanket
         * X-Frame-Options: DENY below would render it as an empty box on every
         * restaurant's website, so it is deliberately excluded here.
         *
         * Nothing is lost by allowing it to be framed: the page is inert without
         * a valid widget key, and the API behind it rejects any Origin that isn't
         * on that key's allowlist (WidgetTenantGuard). Framing it from an
         * unregistered site yields a widget that cannot load a menu or place an
         * order. Authorisation lives at the API, not in a frame header we cannot
         * make dynamic.
         */
        source: '/embed/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
      {
        // The loader is fetched cross-origin by every restaurant's website.
        source: '/widget.js',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          // Short cache: a widget fix must reach live restaurant sites the same
          // day, and this file is ~9KB. Long-caching it on someone else's domain
          // would mean bugs we cannot recall.
          { key: 'Cache-Control', value: 'public, max-age=300, must-revalidate' },
        ],
      },
      {
        /**
         * Everything else gets X-Frame-Options: DENY.
         *
         * The negative lookahead is load-bearing and NOT redundant with the
         * /embed rule above: Next.js applies EVERY matching header rule, not just
         * the first one. A plain `/:path*` here would re-add DENY to /embed and
         * the widget would render as an empty box on every restaurant's website —
         * which is exactly what it did until this was caught by curling a running
         * server rather than trusting the config to read correctly.
         */
        source: '/((?!embed).*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
        ],
      },
    ];
  },

  output: 'standalone', // small Docker image; see apps/web/Dockerfile
};

export default config;
