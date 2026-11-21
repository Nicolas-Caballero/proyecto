import type { NextConfig } from "next";

const appUrl = process.env.APP_URL;
const devHosts = ["127.0.0.1"];
if (appUrl && URL.canParse(appUrl)) devHosts.push(new URL(appUrl).hostname);

const nextConfig: NextConfig = {
  agentRules: false,
  allowedDevOrigins: devHosts,
  devIndicators: false,
  poweredByHeader: false,
};

export default nextConfig;
