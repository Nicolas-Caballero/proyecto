// Elige el origen público configurado para enlaces y redirecciones, con el origen de la petición como alternativa.
export function requestOrigin(request: Request) {
  return process.env.APP_URL ? new URL(process.env.APP_URL).origin : new URL(request.url).origin;
}

// Si el navegador envía Origin, comprueba que corresponde a la propia aplicación.
export function sameOrigin(request: Request) {
  const supplied = request.headers.get("origin");
  if (!supplied) return true;
  return supplied === new URL(request.url).origin || supplied === requestOrigin(request);
}
