// Carga las variables de conexión antes de iniciar la migración.
import "./env";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { closeDb, transaction } from "../src/lib/db";

/** Aplica en orden los archivos SQL que aún no figuran en el registro de migraciones. */
async function migrate() {
  // El prefijo numérico del nombre determina el orden de aplicación.
  const directory = join(process.cwd(), "db", "migrations");
  const files = (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  const migrated = await transaction(async (db) => {
    // El bloqueo evita que dos procesos intenten aplicar la misma migración en paralelo.
    await db.query("SELECT pg_advisory_xact_lock(79580471042213)");
    await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    // El historial de migraciones queda fuera de los permisos de la API pública.
    await db.query("REVOKE ALL ON schema_migrations FROM PUBLIC");
    await db.query(`DO $$
      DECLARE api_role text;
      BEGIN
        FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format('REVOKE ALL ON schema_migrations FROM %I', api_role);
          END IF;
        END LOOP;
      END
    $$`);
    const { rows } = await db.query<{ name: string }>("SELECT name FROM schema_migrations");
    const applied = new Set(rows.map(({ name }) => name));
    const pending = files.filter((name) => !applied.has(name));
    for (const name of pending) {
      // El SQL y su registro se confirman juntos dentro de la misma transacción.
      await db.query(await readFile(join(directory, name), "utf8"));
      await db.query("INSERT INTO schema_migrations(name) VALUES ($1)", [name]);
    }
    return pending;
  });
  // Solo se anuncian las migraciones una vez confirmadas.
  for (const name of migrated) console.log(`Migración aplicada: ${name}`);
}

// Propaga los fallos al entorno de ejecución mediante el código de salida.
migrate()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDb);
