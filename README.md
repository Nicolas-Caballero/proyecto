# Pulso

Pulso reúne solicitudes de clientes, contactos y seguimientos en un panel para pequeños negocios. Cada empresa tiene su formulario público, su equipo, sus estados y sus reglas. El modo demo incluye una peluquería y un taller. Al crear otra empresa se puede elegir también una plantilla de reformas y editarla desde el panel.

## Arranque local

Se necesita Node.js 22 LTS actualizado o posterior y PostgreSQL 17. Puedes usar una instancia PostgreSQL existente o levantar una con Docker:

```bash
docker run -d --name pulso-postgres \
  -e POSTGRES_USER=pulso -e POSTGRES_PASSWORD=pulso-dev-local \
  -e POSTGRES_DB=pulso -p 127.0.0.1:5432:5432 \
  -v pulso-data:/var/lib/postgresql/data postgres:17-alpine
docker exec pulso-postgres pg_isready -U pulso -d pulso
```

Copia `.env.example` a `.env.local` y ajusta `DATABASE_URL` si usas otra instancia. En desarrollo puedes probar el flujo con las cuentas ficticias y el simulador de correo.

```bash
npm ci
npm run db:migrate
npm run db:seed
npm run dev
```

Abre `http://localhost:3000`. Para reiniciar la base local de Docker en otra sesión, ejecuta `docker start pulso-postgres`. Las migraciones se ejecutan con una cuenta de PostgreSQL autorizada para crear roles y objetos de esquema. La semilla contiene exclusivamente datos ficticios y se reserva para desarrollo o demostraciones aisladas. El formulario público pide siempre el nombre y al menos un medio de contacto. En **Configuración** puedes ordenar y editar los campos adicionales y elegir cuáles son obligatorios. El logotipo se configura con una URL HTTPS.

### Demostración de cinco minutos

1. Entra con la cuenta administradora de demostración y abre **Bandeja de entrada**. Cambia entre Estudio Norte y Motor Barrio para comparar sus solicitudes.
2. Comparte o abre el formulario público de una empresa. Prueba también `/f/estudio-norte?origen=instagram` y `/f/motor-barrio?origen=google`. Envía una solicitud con datos ficticios.
3. En la bandeja, asigna la nueva solicitud, escribe una nota interna y registra un contacto. La nota y el acuse de recibo quedan fuera de la primera respuesta humana. Puedes revisar y editar un mensaje antes de abrirlo en WhatsApp y registrar el contacto después.
4. Prueba **Requiere atención** y **Automatizaciones**. Para procesar trabajos pendientes, ejecuta `npm run worker` una vez o deja `npm run worker -- --watch` abierto en otra terminal para procesarlos cada minuto. La vista de automatizaciones muestra el modo de correo y permite revisar los resultados.
5. Cierra una solicitud como conseguida o perdida y comprueba el resumen filtrando por periodo u origen. La métrica de conseguidas después de un seguimiento cuenta el orden de los eventos.

## Producción

- Configura `DATABASE_URL` con un PostgreSQL persistente y ejecuta `npm run db:migrate` antes de iniciar el servicio. Protege la URL de la base de datos y realiza copias de seguridad. La aplicación valida la membresía en servidor y usa roles PostgreSQL separados para las operaciones de empresa, acceso público y trabajos.
- Configura Supabase Auth y las variables públicas de conexión de `.env.example`. Establece `APP_URL` en tu origen HTTPS y añade esa URL con la ruta `/api/auth/callback` a los destinos autorizados de Supabase. Activa el inicio de sesión por email y configura SMTP para entregar los enlaces de acceso. El primer usuario crea la empresa y el administrador registra una invitación en Configuración. El usuario invitado obtiene acceso al iniciar sesión con la dirección verificada correspondiente. Usa `DEMO_MODE=false` para producción.
- Para entrega real, establece `MAIL_MODE=resend`, `RESEND_API_KEY` y `MAIL_FROM` con un remitente de dominio verificado en Resend. En desarrollo se simulan y registran los envíos.
- Programa `npm run worker` periódicamente, o ejecuta una solicitud a `/api/cron` con la cabecera `Authorization: Bearer <CRON_SECRET>`. Usa un secreto aleatorio largo. Los trabajos se guardan en PostgreSQL y la frecuencia del planificador determina cuánto pueden tardar en procesarse una vez vencidos. Un intervalo de un minuto sirve para la mayoría de las demostraciones.
- Compila con `npm run build` y arranca con `npm start`. Next.js necesita un servidor Node.js y conexión con PostgreSQL.

Las fechas se almacenan con zona horaria y el panel muestra la hora local de cada empresa. El objetivo de primera respuesta se calcula dentro de su horario laboral. El enlace de datos pendientes caduca y da acceso al formulario acotado de la solicitud que lo originó.

## Recorrido por el código

- La entrada del cliente muestra los campos de su empresa y envía la solicitud para validarla y guardarla en el servidor. [Formulario](src/app/f) · [public.ts](src/lib/public.ts)
- La bandeja envía las acciones del equipo al servidor, que comprueba el acceso a la empresa y aplica las reglas de gestión. [dashboard.tsx](src/components/dashboard.tsx) · [workspace.ts](src/lib/workspace.ts) · [db.ts](src/lib/db.ts)
- Las automatizaciones programan trabajos persistentes que se pueden procesar desde la terminal. [automation.ts](src/lib/automation.ts) · [worker.ts](scripts/worker.ts)
- Las migraciones definen el esquema y las políticas de acceso. Las pruebas recorren los flujos por HTTP y comprueban el resultado en PostgreSQL. [Migraciones](db/migrations) · [workflow.test.ts](tests/workflow.test.ts)

## Comprobaciones

```bash
npm run typecheck
npm run build
npm test
```

Para `npm test`, inicia la app demo con una base local dedicada, migrada y sembrada. La prueba usa `http://localhost:3000` por defecto. Configura `TEST_APP_URL` si ejecutas la app en otro puerto y asegúrate de que el proceso de prueba usa la misma `DATABASE_URL`. La suite usa PostgreSQL real y el correo simulado. Crea sus propias empresas temporales y las elimina al terminar. El alcance de esta versión incluye enlaces de WhatsApp para envío manual. Facturación, app móvil, chatbot, disponibilidad en tiempo real e integración oficial de WhatsApp quedan fuera del MVP.
