export type FieldType = "text" | "textarea" | "email" | "tel" | "number" | "date" | "select" | "checkbox";

export type PublicField = {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options: string[];
};
