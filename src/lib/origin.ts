export function requestOrigin(request: Request) {
  return process.env.APP_URL ? new URL(process.env.APP_URL).origin : new URL(request.url).origin;
}

export function sameOrigin(request: Request) {
  const supplied = request.headers.get("origin");
  if (!supplied) return true;
  return supplied === new URL(request.url).origin || supplied === requestOrigin(request);
}
