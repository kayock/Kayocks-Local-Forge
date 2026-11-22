import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // TypeScript errors fail the build (they previously hid two functional bugs).
  reactStrictMode: false,
  // NOTE: the companion gateway proxy is a runtime-gated route handler at
  // src/app/lf-companion/[...path]/route.ts — NOT a build-time rewrite. An
  // always-on rewrite would ship every customer deployment with a path from
  // the hosted server to ITS OWN localhost; the route handler answers 404
  // unless a deployment explicitly opts in (see docs/DEPLOYMENT.md §4a).
};

export default nextConfig;
