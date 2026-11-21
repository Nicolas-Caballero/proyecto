import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Pulso · Gestión de solicitudes", template: "%s · Pulso" },
  description: "Organiza las solicitudes de tus clientes y da seguimiento a cada oportunidad.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="es"><body>{children}</body></html>;
}
