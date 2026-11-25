import { UnavailableForm } from "../../f/public-shell";

// Indica que el visitante puede pedir otro enlace si necesita completar más datos.
export default function CompletionNotFound() {
  return <UnavailableForm completion />;
}
