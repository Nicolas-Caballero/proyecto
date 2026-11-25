import type { NextConfig } from "next";

// Admite la IP local y el dominio configurado como orígenes del servidor de desarrollo.
const appUrl = process.env.APP_URL;
const devHosts = ["127.0.0.1"];
if (appUrl && URL.canParse(appUrl)) devHosts.push(new URL(appUrl).hostname);

// Aplica las opciones de Next.js para el servidor de desarrollo y la respuesta HTTP.
const nextConfig: NextConfig = {
  agentRules: false,
  allowedDevOrigins: devHosts,
  devIndicators: false,
  poweredByHeader: false,
};

export default nextConfig;
