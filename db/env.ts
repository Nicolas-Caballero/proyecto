import { existsSync } from "node:fs";

// Conserva las variables definidas al lanzar el proceso.
// Entre los archivos, .env.local tiene prioridad porque se carga primero.
for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}
