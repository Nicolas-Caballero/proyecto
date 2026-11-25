-- Ajusta cómo el usuario de la aplicación adopta los roles internos.
DO $$
DECLARE
  runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['app_runtime', 'app_worker', 'app_public', 'app_completion'] LOOP
    -- PostgreSQL crea la membresía administrativa con SET deshabilitado.
    -- Habilita el cambio explícito de rol que hace la aplicación con SET LOCAL.
    -- INHERIT FALSE conserva los permisos propios de cada rol hasta ese cambio.
    EXECUTE format('GRANT %I TO %I WITH INHERIT FALSE, SET TRUE', runtime_role, current_user);
  END LOOP;
END
$$;
