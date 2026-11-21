import { setTimeout as sleep } from "node:timers/promises";
import { runJobs } from "../src/lib/automation";
import { closeDb } from "../src/lib/db";

async function main() {
  const watch = process.argv.includes("--watch");
  const interrupt = new AbortController();
  process.once("SIGINT", () => interrupt.abort());
  process.once("SIGTERM", () => interrupt.abort());

  try {
    do {
      try {
        const result = await runJobs();
        if (!watch || result.attempted) console.log(result);
      } catch (error) {
        if (!watch) throw error;
        console.error("No se pudieron procesar los trabajos:", error);
      }

      if (watch && !interrupt.signal.aborted) {
        await sleep(60_000, undefined, { signal: interrupt.signal }).catch((error) => {
          if (!interrupt.signal.aborted) throw error;
        });
      }
    } while (watch && !interrupt.signal.aborted);
  } finally {
    await closeDb();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
