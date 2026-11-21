import { Pool, type PoolClient } from "pg";

export type CompanyRole = "admin" | "employee";

export interface Membership {
  company_id: string;
  user_id: string;
  role: CompanyRole;
  name: string;
  email: string;
}

export interface ListedMembership extends Membership {
  company_name: string;
  company_slug: string;
  industry: "salon" | "workshop" | "renovation" | "custom";
}

export interface Completion {
  id: string;
  company_id: string;
  request_id: string;
  fields: unknown;
  expires_at: Date;
}

export class AccessDeniedError extends Error {
  constructor() {
    super("No tienes acceso a esta empresa.");
    this.name = "AccessDeniedError";
  }
}

let pool: Pool | undefined;
const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export async function closeDb(): Promise<void> {
  if (pool) {
    const closingPool = pool;
    pool = undefined;
    await closingPool.end();
  }
}

/**
 * Owner transaction for trusted bootstrap and scope discovery. Regular reads and
 * writes must use the scoped functions below so PostgreSQL applies RLS.
 */
export async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  let rollbackError: Error | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path TO public; SET LOCAL TIME ZONE 'UTC'");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (cause) {
      rollbackError = cause instanceof Error ? cause : new Error("Error al revertir la transacción.");
    }
    throw error;
  } finally {
    client.release(rollbackError);
  }
}

type DatabaseRole = "app_runtime" | "app_public" | "app_completion" | "app_worker";

async function useScope(
  client: PoolClient,
  role: DatabaseRole,
  companyId: string,
  userId = "",
  requestId = "",
  completionId = "",
): Promise<void> {
  await client.query(
    `SELECT set_config('app.company_id', $1, true),
            set_config('app.user_id', $2, true),
            set_config('app.request_id', $3, true),
            set_config('app.completion_id', $4, true)`,
    [companyId, userId, requestId, completionId],
  );
  // The only identifiers interpolated here are internal role literals.
  await client.query(`SET LOCAL ROLE "${role}"`);
}

export async function listMemberships(userId: string): Promise<ListedMembership[]> {
  if (!validUuid.test(userId)) return [];
  return transaction(async (client) => {
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

export async function withTenant<T>(
  userId: string,
  companyId: string,
  run: (client: PoolClient, membership: Membership) => Promise<T>,
  requiredRole?: CompanyRole,
): Promise<T> {
  if (!validUuid.test(userId) || !validUuid.test(companyId)) throw new AccessDeniedError();
  return transaction(async (client) => {
    const { rows: [membership] } = await client.query<Membership>(
      "SELECT * FROM memberships WHERE user_id = $1 AND company_id = $2 FOR SHARE",
      [userId, companyId],
    );
    if (!membership || (requiredRole && membership.role !== requiredRole)) {
      throw new AccessDeniedError();
    }
    await useScope(client, "app_runtime", companyId, userId);
    return run(client, membership);
  });
}

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

export async function withCompletion<T>(
  slug: string,
  tokenHash: string,
  run: (client: PoolClient, completion: Completion) => Promise<T>,
): Promise<T | null> {
  if (!/^[a-f0-9]{64}$/.test(tokenHash)) return null;
  return transaction(async (client) => {
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
    await useScope(client, "app_completion", completion.company_id, "", completion.request_id, completion.id);
    return run(client, completion);
  });
}

export async function listWorkerCompanyIds(): Promise<string[]> {
  return transaction(async (client) => {
    const { rows } = await client.query<{ id: string }>("SELECT id FROM companies ORDER BY id");
    return rows.map(({ id }) => id);
  });
}

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
