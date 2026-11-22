-- El formulario de un enlace usa la definición de los campos de su empresa.
-- La política limita las filas visibles y el GRANT habilita su lectura.
CREATE POLICY completion_fields ON form_fields FOR SELECT TO app_completion
  USING (company_id = app_access.tenant_id());
GRANT SELECT ON form_fields TO app_completion;
