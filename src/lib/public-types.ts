// Tipos de campo admitidos por la configuración, la vista y la validación del servidor.
export type FieldType = "text" | "textarea" | "email" | "tel" | "number" | "date" | "select" | "checkbox";

// Describe un control del formulario en el formato que se comparte con el navegador.
export type PublicField = {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options: string[];
};
