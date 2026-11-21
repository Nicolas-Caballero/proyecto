"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import type { PublicField } from "../../lib/public-types";
import styles from "./public.module.css";

type FormProps = {
  endpoint: string;
  fields: PublicField[];
  darkText: boolean;
} & ({
  kind: "intake";
  services: { id: string; name: string }[];
  source: string;
} | {
  kind: "completion";
});

function DynamicField({ field }: { field: PublicField }) {
  const id = `field-${field.key}`;
  const requiredMark = field.required ? <span className={styles.required} aria-hidden="true"> *</span> : null;
  const fieldProps = { id, name: id, required: field.required };
  if (field.type === "checkbox") {
    return (
      <label className={styles.check} htmlFor={id}>
        <input {...fieldProps} type="checkbox" />
        <span>{field.label}{requiredMark}</span>
      </label>
    );
  }
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{field.label}{requiredMark}</label>
      {field.type === "textarea" ? <textarea {...fieldProps} maxLength={3000} rows={4} /> : field.type === "select" ? (
        <select {...fieldProps} defaultValue="">
          <option value="">Selecciona una opción</option>
          {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      ) : <input {...fieldProps} type={field.type} maxLength={500} step={field.type === "number" ? "any" : undefined} />}
    </div>
  );
}

export function PublicForm(props: FormProps) {
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const confirmation = useRef<HTMLDivElement>(null);
  const intake = props.kind === "intake";

  useEffect(() => setReady(true), []);

  useEffect(() => {
    if (status === "sent") confirmation.current?.focus();
  }, [status]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "sending") return;
    const form = new FormData(event.currentTarget);
    const answers = Object.fromEntries(props.fields.flatMap((field) => {
      const value = form.get(`field-${field.key}`);
      if (typeof value !== "string" || !value.trim()) return [];
      return [[field.key, field.type === "checkbox" ? true : value]];
    }));
    const payload = props.kind === "intake" ? {
      name: form.get("name"),
      email: form.get("email"),
      phone: form.get("phone"),
      serviceId: form.get("service"),
      source: props.source,
      website: form.get("website"),
      answers,
    } : { answers };
    setError("");
    setStatus("sending");
    try {
      const response = await fetch(props.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.error ?? "No se pudo guardar. Inténtalo de nuevo.");
        setStatus("idle");
        return;
      }
      setStatus("sent");
    } catch {
      setError("No hay conexión. Comprueba tu red e inténtalo de nuevo.");
      setStatus("idle");
    }
  }

  if (status === "sent") {
    return (
      <div ref={confirmation} className={styles.success} role="status" tabIndex={-1}>
        <span className={styles.successMark} aria-hidden="true">✓</span>
        <h2 className={styles.cardTitle}>{intake ? "Solicitud recibida" : "Información enviada"}</h2>
        <p className={styles.cardDescription}>{intake
          ? "El equipo revisará tu solicitud y se pondrá en contacto contigo."
          : "El equipo ya puede consultar los datos añadidos a tu solicitud."}</p>
      </div>
    );
  }
  return (
    <>
      <h2 className={styles.cardTitle}>{intake ? "Nueva solicitud" : "Datos solicitados"}</h2>
      <p className={styles.cardDescription}>{intake ? "Deja tu email o teléfono para que podamos responderte." : "Rellena los campos y envíalos al equipo."}</p>
      <noscript><p className={styles.error}>Activa JavaScript para enviar el formulario.</p></noscript>
      <form className={styles.form} action={props.endpoint} method="post" onSubmit={submit}>
        {intake && (
          <>
            <div className={styles.field}>
              <label htmlFor="contact-name">Nombre <span className={styles.required} aria-hidden="true">*</span></label>
              <input id="contact-name" name="name" autoComplete="name" maxLength={120} required />
            </div>
            <div className={styles.row}>
              <div className={styles.field}>
                <label htmlFor="contact-email">Email</label>
                <input id="contact-email" name="email" type="email" autoComplete="email" maxLength={254} />
              </div>
              <div className={styles.field}>
                <label htmlFor="contact-phone">Teléfono</label>
                <input id="contact-phone" name="phone" type="tel" autoComplete="tel" maxLength={32} />
              </div>
            </div>
            {props.services.length > 0 && (
              <div className={styles.field}>
                <label htmlFor="requested-service">Servicio <span className={styles.required} aria-hidden="true">*</span></label>
                <select id="requested-service" name="service" defaultValue="" required>
                  <option value="" disabled>Selecciona un servicio</option>
                  {props.services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
                </select>
              </div>
            )}
            <div className={styles.trap} aria-hidden="true">
              <label htmlFor="form-website">Sitio web</label>
              <input id="form-website" name="website" autoComplete="off" tabIndex={-1} />
            </div>
          </>
        )}
        {props.fields.map((field) => <DynamicField key={field.key} field={field} />)}
        {error && <div className={styles.error} role="alert">{error}</div>}
        <button className={styles.button} data-dark={props.darkText} type="submit" disabled={!ready || status === "sending"}>
          {status === "sending" ? "Enviando…" : intake ? "Enviar solicitud" : "Enviar información"}
        </button>
      </form>
    </>
  );
}
