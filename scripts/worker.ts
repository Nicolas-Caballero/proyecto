// La entrada de consola ejecuta la misma cola que el cron y cierra las conexiones al terminar.
import { setTimeout as sleep } from "node:timers/promises";
import { runJobs } from "../src/lib/automation";
import { closeDb } from "../src/lib/db";

// Sin argumentos procesa un lote. Con --watch vuelve a consultar la cola cada minuto.
async function main() {
  const watch = process.argv.includes("--watch");
  // Las señales de cierre cancelan la espera entre lotes y permiten terminar el trabajo en curso.
  const interrupt = new AbortController();
  process.once("SIGINT", () => interrupt.abort());
  process.once("SIGTERM", () => interrupt.abort());

  try {
    do {
      try {
        // Procesa los trabajos vencidos y en modo continuo evita imprimir resúmenes de pasadas vacías.
        const result = await runJobs();
        if (!watch || result.attempted) console.log(result);
      } catch (error) {
        // Un error en modo continuo queda registrado y permite volver a probar en la siguiente pasada.
        if (!watch) throw error;
        console.error("No se pudieron procesar los trabajos:", error);
      }

      // La pausa es interrumpible para no esperar un minuto completo al cerrar el proceso.
      if (watch && !interrupt.signal.aborted) {
        await sleep(60_000, undefined, { signal: interrupt.signal }).catch((error) => {
          if (!interrupt.signal.aborted) throw error;
        });
      }
    } while (watch && !interrupt.signal.aborted);
  } finally {
    // Libera el pool de PostgreSQL tanto al terminar normalmente como si falla el proceso.
    await closeDb();
  }
}

// Inicia el script y devuelve un código de error si falla fuera del bucle de espera.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
