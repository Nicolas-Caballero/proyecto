import type { Metadata } from "next";
import "./globals.css";

// Define el título y la descripción predeterminados para todas las páginas de Pulso.
export const metadata: Metadata = {
  title: { default: "Pulso · Gestión de solicitudes", template: "%s · Pulso" },
  description: "Organiza las solicitudes de tus clientes y da seguimiento a cada oportunidad.",
};

// Envuelve cada página en el documento HTML y declara el español como idioma de la interfaz.
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="es"><body>{children}</body></html>;
}
