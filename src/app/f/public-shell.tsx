import type { CSSProperties, ReactNode } from "react";
import type { PublicBrand } from "../../lib/public";

import styles from "./public.module.css";

// Calcula la luminancia relativa para elegir un texto con contraste sobre el color de marca.
export function hasLightBrandColor(color: string) {
  const channels = color.slice(1).match(/.{2}/g) ?? [];
  const linear = channels.map((value) => {
    const channel = parseInt(value, 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  return (.2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2]) > .179;
}

// Reutiliza la cabecera de marca y la composición en las dos páginas públicas.
export function PublicShell({ brand, completion, children }: { brand: PublicBrand; completion?: boolean; children: ReactNode }) {
  const initials = brand.name.trim().split(/\s+/).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
  return (
    <main className={styles.shell} style={{ "--brand": brand.color } as CSSProperties}>
      <div className={styles.container}>
        <header className={styles.header}>
          {brand.logoUrl ? (
            <img className={styles.logo} src={brand.logoUrl} width={40} height={40} alt="" referrerPolicy="no-referrer" />
          ) : (
            <span className={styles.monogram} aria-hidden="true" data-dark={hasLightBrandColor(brand.color)}>{initials}</span>
          )}
          <span className={styles.companyName}>{brand.name}</span>
        </header>
        <div className={styles.layout}>
          <section className={styles.intro}>
            <p className={styles.eyebrow}>{completion ? "Tu solicitud" : "Atención al cliente"}</p>
            <h1 className={styles.title}>{completion ? "Completa tu solicitud" : "¿En qué podemos ayudarte?"}</h1>
            <p className={styles.description}>{completion
              ? "Envía los datos que el equipo necesita para continuar con tu solicitud."
              : "Cuéntanos qué necesitas y el equipo se pondrá en contacto contigo."}</p>
          </section>
          <section className={styles.card}>{children}</section>
        </div>
      </div>
    </main>
  );
}

// Muestra un mensaje genérico cuando falta la empresa o el enlace deja de ser válido.
export function UnavailableForm({ completion }: { completion?: boolean }) {
  return (
    <main className={styles.shell}>
      <div className={styles.unavailable}>
        <section className={styles.card}>
          <h1 className={styles.cardTitle}>{completion ? "Enlace no disponible" : "Formulario no disponible"}</h1>
          <p className={styles.description}>{completion
            ? "El enlace puede haber caducado o haberse utilizado. Pide uno nuevo al negocio si necesitas enviar más datos."
            : "Contacta con el negocio para solicitar el enlace actualizado."}</p>
        </section>
      </div>
    </main>
  );
}
