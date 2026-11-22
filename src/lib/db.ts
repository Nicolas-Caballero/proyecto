import { Pool, type PoolClient } from "pg";

// Los roles de empresa representan los permisos de una persona en un equipo.
export type CompanyRole = "admin" | "employee";

// Relación entre un usuario autenticado y una empresa concreta.
export interface Membership {
  company_id: string;
  user_id: string;
  role: CompanyRole;
  name: string;
  email: string;
}

// Añade los datos que usa el selector de empresas del panel.
export interface ListedMembership extends Membership {
  company_name: string;
  company_slug: string;
  industry: "salon" | "workshop" | "renovation" | "custom";
}

// Contexto de un enlace válido para completar los campos de una sola solicitud.
export interface Completion {
  id: string;
  company_id: string;
  request_id: string;
  fields: unknown;
  expires_at: Date;
}

// Permite que el servidor distinga un acceso denegado de un error de conexión.
export class AccessDeniedError extends Error {
  constructor() {
    super("No tienes acceso a esta empresa.");
    this.name = "AccessDeniedError";
  }
}

// Se reutiliza el grupo de conexiones durante la vida del proceso.
let pool: Pool | undefined;
const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Abre el grupo de conexiones al ejecutar la primera consulta. */
function getPool(): Pool {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("Define DATABASE_URL para conectar con PostgreSQL.");
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 5000,
      max: 10,
    });
  }
  return pool;
}

/** Cierra las conexiones al finalizar un proceso de consola. */
export async function closeDb(): Promise<void> {
  if (pool) {
    const closingPool = pool;
    pool = undefined;
    await closingPool.end();
  }
}

/**
 * Ejecuta una operación atómica y devuelve el resultado de la función recibida.
 * El cliente empieza con los permisos del propietario para tareas de inicialización
 * y de comprobación de acceso. Las funciones de ámbito aplican las políticas RLS.
 */
export async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  let rollbackError: Error | undefined;
  try {
    await client.query("BEGIN");
    // La configuración local desaparece al finalizar la transacción.
    await client.query("SET LOCAL search_path TO public; SET LOCAL TIME ZONE 'UTC'");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    // Revierte el conjunto de cambios y conserva la causa original.
    try {
      await client.query("ROLLBACK");
    } catch (cause) {
      rollbackError = cause instanceof Error ? cause : new Error("Error al revertir la transacción.");
    }
    throw error;
  } finally {
    // Si la reversión falló, el grupo descarta la conexión.
    client.release(rollbackError);
  }
}

// Cada rol PostgreSQL tiene permisos propios para los canales de acceso de la aplicación.
type DatabaseRole = "app_runtime" | "app_public" | "app_completion" | "app_worker";

/** Establece el contexto que PostgreSQL usa para filtrar filas en esta transacción. */
async function useScope(
  client: PoolClient,
  role: DatabaseRole,
  companyId: string,
  userId = "",
  requestId = "",
  completionId = "",
): Promise<void> {
  // El tercer argumento de set_config limita los identificadores a esta transacción.
  await client.query(
    `SELECT set_config('app.company_id', $1, true),
            set_config('app.user_id', $2, true),
            set_config('app.request_id', $3, true),
            set_config('app.completion_id', $4, true)`,
    [companyId, userId, requestId, completionId],
  );
  // El código del servidor elige un nombre de rol de la unión DatabaseRole.
  await client.query(`SET LOCAL ROLE "${role}"`);
}

/** Devuelve las empresas a las que pertenece el usuario, ordenadas para el selector. */
export async function listMemberships(userId: string): Promise<ListedMembership[]> {
  if (!validUuid.test(userId)) return [];
  return transaction(async (client) => {
    // Una consulta parametrizada limita la búsqueda al usuario de la sesión.
    const result = await client.query<ListedMembership>(
      `SELECT m.*, c.name AS company_name, c.slug AS company_slug, c.industry
       FROM memberships m JOIN companies c ON c.id = m.company_id
       WHERE m.user_id = $1
       ORDER BY c.name, c.id`,
      [userId],
    );
    return result.rows;
  });
}

/** Comprueba la membresía y ejecuta la operación con los permisos de esa empresa. */
export async function withTenant<T>(
  userId: string,
  companyId: string,
  run: (client: PoolClient, membership: Membership) => Promise<T>,
  requiredRole?: CompanyRole,
): Promise<T> {
  if (!validUuid.test(userId) || !validUuid.test(companyId)) throw new AccessDeniedError();
  return transaction(async (client) => {
    // FOR SHARE conserva la membresía y su rol mientras se usa el permiso.
    const { rows: [membership] } = await client.query<Membership>(
      "SELECT * FROM memberships WHERE user_id = $1 AND company_id = $2 FOR SHARE",
      [userId, companyId],
    );
    if (!membership || (requiredRole && membership.role !== requiredRole)) {
      throw new AccessDeniedError();
    }
    // A partir de aquí PostgreSQL comprueba tanto la membresía como la empresa de cada fila.
    await useScope(client, "app_runtime", companyId, userId);
    return run(client, membership);
  });
}

/** Resuelve el slug y aplica los permisos del formulario público en esa empresa. */
export async function withPublicCompany<T>(
  slug: string,
  run: (client: PoolClient, companyId: string) => Promise<T>,
): Promise<T | null> {
  return transaction(async (client) => {
    const { rows: [company] } = await client.query<{ id: string }>(
      "SELECT id FROM companies WHERE slug = $1",
      [slug],
    );
    if (!company) return null;
    await useScope(client, "app_public", company.id);
    return run(client, company.id);
  });
}

/** Valida el resumen SHA-256 del enlace y acota el acceso al registro autorizado. */
export async function withCompletion<T>(
  slug: string,
  tokenHash: string,
  run: (client: PoolClient, completion: Completion) => Promise<T>,
): Promise<T | null> {
  if (!/^[a-f0-9]{64}$/.test(tokenHash)) return null;
  return transaction(async (client) => {
    // Solo se aceptan enlaces vigentes, sin usar y asociados a una solicitud abierta.
    // Bloquear el enlace y la solicitud evita que dos envíos lo consuman a la vez.
    const { rows: [completion] } = await client.query<Completion>(
      `SELECT c.id, c.company_id, c.request_id, c.fields, c.expires_at
       FROM completions c
       JOIN companies b ON b.id = c.company_id
       JOIN requests r ON r.company_id = c.company_id AND r.id = c.request_id
       WHERE b.slug = $1 AND c.token_hash = $2
         AND c.expires_at > current_timestamp AND c.used_at IS NULL AND r.closed_at IS NULL
       FOR UPDATE OF r, c`,
      [slug, tokenHash],
    );
    if (!completion) return null;
    // La política limita la modificación a la solicitud y al enlace encontrados.
    await useScope(client, "app_completion", completion.company_id, "", completion.request_id, completion.id);
    return run(client, completion);
  });
}

/** Enumera empresas para que el proceso de automatización pueda revisarlas una a una. */
export async function listWorkerCompanyIds(): Promise<string[]> {
  return transaction(async (client) => {
    const { rows } = await client.query<{ id: string }>("SELECT id FROM companies ORDER BY id");
    return rows.map(({ id }) => id);
  });
}

/** Ejecuta una operación de automatización con el rol y el ámbito de una empresa. */
export async function withWorkerCompany<T>(
  companyId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!validUuid.test(companyId)) throw new AccessDeniedError();
  return transaction(async (client) => {
    await useScope(client, "app_worker", companyId);
    return run(client);
  });
}
