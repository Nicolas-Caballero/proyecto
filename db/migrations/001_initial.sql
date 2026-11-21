DO $$
DECLARE
  runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['app_runtime', 'app_worker', 'app_public', 'app_completion'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS', runtime_role);
    END IF;
    EXECUTE format('GRANT %I TO %I', runtime_role, current_user);
  END LOOP;
END
$$;

CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 63),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  industry text NOT NULL DEFAULT 'custom' CHECK (industry IN ('salon', 'workshop', 'renovation', 'custom')),
  logo_url text,
  primary_color text NOT NULL DEFAULT '#bc553c' CHECK (primary_color ~ '^#[a-fA-F0-9]{6}$'),
  timezone text NOT NULL DEFAULT 'Europe/Madrid',
  business_hours jsonb NOT NULL DEFAULT '{"days":[1,2,3,4,5],"start":"09:00","end":"18:00"}' CHECK (jsonb_typeof(business_hours) = 'object'),
  first_response_minutes integer NOT NULL DEFAULT 120 CHECK (first_response_minutes BETWEEN 1 AND 43200),
  rules jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(rules) = 'object'),
  templates jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(templates) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  company_id uuid NOT NULL REFERENCES companies ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'employee')),
  name text NOT NULL,
  email text NOT NULL,
  PRIMARY KEY (company_id, user_id)
);
CREATE INDEX memberships_user_id ON memberships (user_id);

CREATE TABLE company_invitations (
  company_id uuid NOT NULL REFERENCES companies ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(email)),
  role text NOT NULL CHECK (role IN ('admin', 'employee')),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, email)
);
CREATE INDEX company_invitations_email ON company_invitations (email);

CREATE TABLE services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (company_id, id)
);

CREATE TABLE form_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$'),
  label text NOT NULL,
  type text NOT NULL CHECK (type IN ('text', 'textarea', 'email', 'tel', 'number', 'date', 'select', 'checkbox')),
  required boolean NOT NULL DEFAULT false,
  options jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(options) = 'array'),
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  UNIQUE (company_id, key)
);

CREATE TABLE statuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  kind text NOT NULL DEFAULT 'open' CHECK (kind IN ('open', 'waiting', 'quote', 'appointment', 'closed')),
  color text NOT NULL DEFAULT '#696e79' CHECK (color ~ '^#[a-fA-F0-9]{6}$'),
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  UNIQUE (company_id, id)
);

CREATE TABLE requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies ON DELETE CASCADE,
  status_id uuid NOT NULL,
  service_id uuid,
  assigned_to uuid,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  email text,
  phone text,
  subject text NOT NULL CHECK (length(trim(subject)) > 0),
  answers jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(answers) = 'object'),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  source text NOT NULL DEFAULT 'web',
  next_action text,
  next_action_at timestamptz,
  first_response_at timestamptz,
  sla_due_at timestamptz,
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  appointment_at timestamptz,
  outcome text CHECK (outcome IN ('won', 'lost')),
  confirmed_amount numeric(12,2) CHECK (confirmed_amount >= 0),
  loss_reason text,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, status_id) REFERENCES statuses (company_id, id),
  FOREIGN KEY (company_id, service_id) REFERENCES services (company_id, id) ON DELETE SET NULL (service_id),
  FOREIGN KEY (company_id, assigned_to) REFERENCES memberships (company_id, user_id) ON DELETE SET NULL (assigned_to)
);
CREATE INDEX requests_inbox ON requests (company_id, created_at DESC);
CREATE INDEX requests_attention ON requests (company_id, sla_due_at) WHERE closed_at IS NULL AND first_response_at IS NULL;
CREATE INDEX requests_follow_up ON requests (company_id, next_action_at) WHERE closed_at IS NULL;
CREATE INDEX requests_by_status ON requests (company_id, status_id);

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  request_id uuid NOT NULL,
  author_id uuid,
  kind text NOT NULL CHECK (length(trim(kind)) > 0),
  body text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, request_id) REFERENCES requests (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, author_id) REFERENCES memberships (company_id, user_id) ON DELETE SET NULL (author_id)
);
CREATE INDEX events_timeline ON events (company_id, request_id, created_at);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  request_id uuid NOT NULL,
  type text NOT NULL CHECK (length(trim(type)) > 0),
  dedupe_key text NOT NULL,
  available_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  payload jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  last_error text,
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, dedupe_key),
  UNIQUE (company_id, request_id, id),
  FOREIGN KEY (company_id, request_id) REFERENCES requests (company_id, id) ON DELETE CASCADE
);
CREATE INDEX jobs_due ON jobs (company_id, available_at) WHERE status = 'pending' OR status = 'failed';
CREATE INDEX jobs_request ON jobs (company_id, request_id);

CREATE TABLE follow_ups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  request_id uuid NOT NULL,
  job_id uuid UNIQUE,
  assigned_to uuid,
  message text NOT NULL,
  due_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, request_id) REFERENCES requests (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, request_id, job_id) REFERENCES jobs (company_id, request_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, assigned_to) REFERENCES memberships (company_id, user_id) ON DELETE SET NULL (assigned_to)
);
CREATE INDEX follow_ups_due ON follow_ups (company_id, due_at) WHERE completed_at IS NULL;
CREATE INDEX follow_ups_request ON follow_ups (company_id, request_id);

CREATE TABLE completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  request_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'array'),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, request_id) REFERENCES requests (company_id, id) ON DELETE CASCADE
);
CREATE INDEX completions_request ON completions (company_id, request_id);

CREATE TABLE public_rate_limits (
  company_id uuid NOT NULL REFERENCES companies ON DELETE CASCADE,
  fingerprint text NOT NULL,
  bucket timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 1 CHECK (hits > 0),
  PRIMARY KEY (company_id, fingerprint, bucket)
);
CREATE INDEX public_rate_limits_age ON public_rate_limits (company_id, bucket);

CREATE SCHEMA app_access;
REVOKE ALL ON SCHEMA app_access FROM PUBLIC;
GRANT USAGE ON SCHEMA app_access TO app_runtime, app_worker, app_public, app_completion;
GRANT USAGE ON SCHEMA public TO app_runtime, app_worker, app_public, app_completion;

CREATE FUNCTION app_access.tenant_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog
RETURN nullif(current_setting('app.company_id', true), '')::uuid;

CREATE FUNCTION app_access.is_member(tenant uuid, admin_only boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE company_id = tenant
      AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND (NOT admin_only OR role = 'admin')
  )
$$;

CREATE FUNCTION app_access.completion_request() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog
RETURN nullif(current_setting('app.request_id', true), '')::uuid;

CREATE FUNCTION app_access.completion_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog
RETURN nullif(current_setting('app.completion_id', true), '')::uuid;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_access FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_access.tenant_id() TO app_runtime, app_worker, app_public, app_completion;
GRANT EXECUTE ON FUNCTION app_access.is_member(uuid, boolean) TO app_runtime;
GRANT EXECUTE ON FUNCTION app_access.completion_request(), app_access.completion_id() TO app_completion;

DO $$
DECLARE
  table_name text;
  platform_role text;
BEGIN
  -- Revoke default grants on new public tables, including Supabase API roles.
  FOREACH table_name IN ARRAY ARRAY[
    'companies', 'memberships', 'company_invitations', 'services', 'form_fields',
    'statuses', 'requests', 'events', 'jobs', 'follow_ups', 'completions', 'public_rate_limits'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', table_name);
    FOREACH platform_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = platform_role) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', table_name, platform_role);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY['services', 'form_fields', 'statuses', 'memberships'] LOOP
    EXECUTE format('CREATE POLICY runtime_read ON %I FOR SELECT TO app_runtime USING (
      company_id = app_access.tenant_id() AND app_access.is_member(company_id)
    )', table_name);
    EXECUTE format('CREATE POLICY runtime_admin ON %I TO app_runtime USING (
      company_id = app_access.tenant_id() AND app_access.is_member(company_id, true)
    ) WITH CHECK (
      company_id = app_access.tenant_id() AND app_access.is_member(company_id, true)
    )', table_name);
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY['requests', 'events', 'jobs', 'follow_ups', 'completions'] LOOP
    EXECUTE format('CREATE POLICY runtime_member ON %I TO app_runtime USING (
      company_id = app_access.tenant_id() AND app_access.is_member(company_id)
    ) WITH CHECK (
      company_id = app_access.tenant_id() AND app_access.is_member(company_id)
    )', table_name);
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY[
    'requests', 'events', 'jobs', 'follow_ups', 'completions', 'statuses', 'memberships', 'public_rate_limits'
  ] LOOP
    EXECUTE format('CREATE POLICY worker_tenant ON %I TO app_worker USING (
      company_id = app_access.tenant_id()
    ) WITH CHECK (
      company_id = app_access.tenant_id()
    )', table_name);
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY['services', 'form_fields', 'statuses'] LOOP
    EXECUTE format('CREATE POLICY public_read ON %I FOR SELECT TO app_public USING (
      company_id = app_access.tenant_id()
    )', table_name);
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY['requests', 'events', 'jobs'] LOOP
    EXECUTE format('CREATE POLICY public_insert ON %I FOR INSERT TO app_public WITH CHECK (
      company_id = app_access.tenant_id()
    )', table_name);
  END LOOP;
END
$$;

CREATE POLICY runtime_read ON companies FOR SELECT TO app_runtime
  USING (id = app_access.tenant_id() AND app_access.is_member(id));
CREATE POLICY runtime_admin ON companies FOR UPDATE TO app_runtime
  USING (id = app_access.tenant_id() AND app_access.is_member(id, true))
  WITH CHECK (id = app_access.tenant_id() AND app_access.is_member(id, true));
CREATE POLICY runtime_admin ON company_invitations TO app_runtime
  USING (company_id = app_access.tenant_id() AND app_access.is_member(company_id, true))
  WITH CHECK (company_id = app_access.tenant_id() AND app_access.is_member(company_id, true));
CREATE POLICY worker_read ON companies FOR SELECT TO app_worker
  USING (id = app_access.tenant_id());
CREATE POLICY public_read ON companies FOR SELECT TO app_public
  USING (id = app_access.tenant_id());
CREATE POLICY public_rate ON public_rate_limits TO app_public
  USING (company_id = app_access.tenant_id())
  WITH CHECK (company_id = app_access.tenant_id());

CREATE POLICY completion_company ON companies FOR SELECT TO app_completion
  USING (id = app_access.tenant_id());
CREATE POLICY completion_request ON requests TO app_completion
  USING (company_id = app_access.tenant_id() AND id = app_access.completion_request())
  WITH CHECK (company_id = app_access.tenant_id() AND id = app_access.completion_request());
CREATE POLICY completion_token ON completions TO app_completion
  USING (company_id = app_access.tenant_id() AND id = app_access.completion_id())
  WITH CHECK (company_id = app_access.tenant_id() AND id = app_access.completion_id());
CREATE POLICY completion_event ON events FOR INSERT TO app_completion
  WITH CHECK (company_id = app_access.tenant_id() AND request_id = app_access.completion_request());

GRANT SELECT, UPDATE ON companies TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON services, form_fields, statuses, company_invitations, memberships TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON requests, jobs, follow_ups, completions TO app_runtime;
GRANT SELECT, INSERT ON events TO app_runtime;
-- Deletion deliberately lives in its own admin-only policy below.
GRANT DELETE ON requests TO app_runtime;
DROP POLICY runtime_member ON requests;
CREATE POLICY runtime_read ON requests FOR SELECT TO app_runtime
  USING (company_id = app_access.tenant_id() AND app_access.is_member(company_id));
CREATE POLICY runtime_insert ON requests FOR INSERT TO app_runtime
  WITH CHECK (company_id = app_access.tenant_id() AND app_access.is_member(company_id));
CREATE POLICY runtime_update ON requests FOR UPDATE TO app_runtime
  USING (company_id = app_access.tenant_id() AND app_access.is_member(company_id))
  WITH CHECK (company_id = app_access.tenant_id() AND app_access.is_member(company_id));
CREATE POLICY runtime_delete ON requests FOR DELETE TO app_runtime
  USING (company_id = app_access.tenant_id() AND app_access.is_member(company_id, true));

GRANT SELECT ON companies, statuses, memberships, completions TO app_worker;
GRANT SELECT, UPDATE ON requests TO app_worker;
GRANT SELECT, INSERT, UPDATE ON jobs, follow_ups TO app_worker;
GRANT SELECT, INSERT ON events TO app_worker;
GRANT SELECT, DELETE ON public_rate_limits TO app_worker;

GRANT SELECT ON companies, statuses, services, form_fields TO app_public;
GRANT INSERT ON requests, events, jobs TO app_public;
GRANT SELECT, INSERT, UPDATE ON public_rate_limits TO app_public;

GRANT SELECT ON companies, requests TO app_completion;
GRANT UPDATE (answers, updated_at) ON requests TO app_completion;
GRANT SELECT (id, company_id, request_id, used_at), UPDATE (used_at) ON completions TO app_completion;
GRANT INSERT ON events TO app_completion;
