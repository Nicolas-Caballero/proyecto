CREATE POLICY completion_fields ON form_fields FOR SELECT TO app_completion
  USING (company_id = app_access.tenant_id());
GRANT SELECT ON form_fields TO app_completion;
