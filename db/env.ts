import { existsSync } from "node:fs";

// Explicit environment values take precedence, including when both files exist.
for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}
