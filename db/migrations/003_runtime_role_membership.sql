DO $$
DECLARE
  runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['app_runtime', 'app_worker', 'app_public', 'app_completion'] LOOP
    -- PostgreSQL grants CREATEROLE owners administrative membership with SET
    -- disabled when they create a role. Enable only transaction-local switching.
    EXECUTE format('GRANT %I TO %I WITH INHERIT FALSE, SET TRUE', runtime_role, current_user);
  END LOOP;
END
$$;
