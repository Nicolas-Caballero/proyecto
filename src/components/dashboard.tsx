'use client';

// El panel usa iconos vectoriales, estado local de React y los contratos compartidos con la API.
import {
  Activity, ArrowDown, ArrowUp, ArrowUpRight, Bell, CalendarDays,
  Check, CheckCircle2, ChevronDown, ChevronRight, CircleAlert, Clock3, Copy, Download,
  ExternalLink, Inbox, LayoutGrid, LogOut, Mail, Menu, MessageCircle, Plus,
  RefreshCw, Search, Settings2, Sparkles, Trash2, UserRound, UsersRound, X, Zap,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type {
  DashboardAction, DashboardCompany, DashboardData, DashboardField, DashboardJob,
  DashboardRequest, DashboardRole, DashboardStatus, Industry, RequestOutcome, RequestPriority, RuleKey,
} from './dashboard-types';
import { getAttentionReasons, getDashboardMetrics } from './dashboard-metrics';

// Cada entrada aporta el icono y nombre para el menú, y un identificador estable para cambiar de vista.
const navigation = [
  { id: 'overview', label: 'Resumen', icon: LayoutGrid },
  { id: 'inbox', label: 'Bandeja de entrada', icon: Inbox },
  { id: 'attention', label: 'Requiere atención', icon: CircleAlert },
  { id: 'automations', label: 'Automatizaciones', icon: Zap },
  { id: 'settings', label: 'Configuración', icon: Settings2 },
] as const;
// Estas etiquetas traducen los valores que maneja el servidor y conservan sus claves para los envíos.
const industries: Record<Industry, string> = {
  salon: 'Peluquería', workshop: 'Taller', renovation: 'Reformas', custom: 'Personalizado',
};
const ruleLabels: Record<RuleKey, string> = {
  acknowledgment: 'Acuse de recibo', sla: 'Alerta por demora', information: 'Información pendiente',
  quoteFollowup: 'Seguimiento de presupuesto', appointmentReminder: 'Recordatorio de cita',
};
const priorityLabels = { high: 'Alta', normal: 'Normal', low: 'Baja' } as const;
const sourceLabels: Record<string, string> = {
  web: 'Web', instagram: 'Instagram', google: 'Google', whatsapp: 'WhatsApp', phone: 'Teléfono', manual: 'Manual',
};
// Los nombres cubren las actividades automáticas y las acciones que registra el equipo.
const eventLabels: Record<string, string> = {
  created: 'Solicitud recibida', note: 'Nota interna', contact: 'Contacto registrado',
  assignment: 'Asignación actualizada', status: 'Cambio de estado', response: 'Respuesta registrada',
  followup: 'Seguimiento programado', completeFollowup: 'Seguimiento completado',
  appointment: 'Cita actualizada', closed: 'Solicitud cerrada', email: 'Correo electrónico',
  updated: 'Solicitud actualizada', external_contact: 'Contacto registrado', followup_completed: 'Seguimiento completado',
  information_requested: 'Información solicitada', information_received: 'Información recibida', automated_email: 'Correo automático',
};
const jobLabels = { pending: 'Pendiente', running: 'En ejecución', done: 'Completado', failed: 'Fallido', canceled: 'Cancelado' } as const;
const statusKinds = { open: 'Abierto', waiting: 'En espera', quote: 'Presupuesto enviado', appointment: 'Cita confirmada', closed: 'Cerrado' } as const;
// Los días siguen la numeración del calendario de JavaScript, con domingo en la posición cero.
const dayLabels = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const money = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
const palette = ['#6747d8', '#4267ac', '#aa671e', '#178062', '#a73559'];
// El tipo de vista se deriva del menú y Submit ofrece el mismo contrato a todos los formularios.
type View = (typeof navigation)[number]['id'];
type Submit = (action: DashboardAction, message?: string) => Promise<boolean>;

// Usa las primeras letras de hasta dos palabras como alternativa al logotipo o a la foto.
function initials(value: string) {
  return value.trim().split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toUpperCase();
}

// Presenta fechas de solicitudes y trabajos en la zona de la empresa y con el formato español.
function dateLabel(value: string | null, zone: string, time = false) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: zone, day: 'numeric', month: 'short', ...(time ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(new Date(value));
}

// Convierte un instante a la cadena que acepta datetime-local, que carece de zona horaria.
function localDateTime(value: string | null, timezone: string) {
  if (!value) return '';
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  // Extraer las partes evita depender de los separadores de la configuración regional.
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(({ type }) => type === name)?.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

// Interpreta la fecha introducida en la zona de la empresa y devuelve un instante para la API.
function utcDateTime(value: string, timezone: string) {
  if (!value) return null;
  const desired = Date.parse(`${value}:00Z`);
  let resolved = desired;
  // Los intentos corrigen el desfase y comprueban que la hora existe durante un cambio horario.
  for (let pass = 0; pass < 3; pass++) {
    const current = Date.parse(`${localDateTime(new Date(resolved).toISOString(), timezone)}:00Z`);
    if (current === desired) return new Date(resolved).toISOString();
    resolved += desired - current;
  }
  throw new Error(`La hora seleccionada no existe en la zona ${timezone}.`);
}

// Resume la mediana en minutos o en horas y minutos. El guion indica que faltan datos.
function formatDuration(minutes: number | null) {
  if (minutes === null) return '—';
  const rounded = Math.round(minutes);
  return rounded >= 60 ? `${Math.floor(rounded / 60)} h ${rounded % 60} min` : `${rounded} min`;
}

// El botón base distingue las variantes de estilo y evita enviar un formulario por defecto.
function Button({ children, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`dash-button ${className}`} {...props}>{children}</button>;
}

// Asocia la etiqueta y la ayuda al control que contiene.
function Field({ label, children, help }: {label: string; children: ReactNode; help?: string}) {
  return <label className="dash-field">{label}{children}{help && <small>{help}</small>}</label>;
}

// Reutiliza la presentación de las listas vacías y permite explicar cómo recuperar resultados.
function Empty({ text, detail }: {text: string; detail?: string}) {
  return <div className="dash-empty"><Inbox size={24} /><h3>{text}</h3>{detail && <p>{detail}</p>}</div>;
}

// Separa la etiqueta configurable del estado de su representación visual en la tabla y el detalle.
function StatusBadge({ status }: {status?: DashboardStatus}) {
  // El fondo translúcido requiere un color hexadecimal de seis dígitos.
  const color = status && /^#[0-9a-f]{6}$/i.test(status.color) ? status.color : '#65647d';
  return <span className="dash-badge" style={{color, backgroundColor: `${color}17`}}><span className="dash-dot" />{status?.label ?? 'Sin estado'}</span>;
}

// El panel lateral comparte el comportamiento de diálogo entre las distintas operaciones.
function Drawer({ title, subtitle, children, close }: {title: string; subtitle?: string; children: ReactNode; close: () => void}) {
  useEffect(() => {
    // Guarda el activador y mueve el foco al botón de cierre al abrir el diálogo.
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.getElementById('dash-dialog');
    dialog?.querySelector<HTMLElement>('button')?.focus();
    // Escape cierra el diálogo. Tab recorre solo los controles visibles y habilitados del panel.
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary'))
        .filter((element) => !element.hasAttribute('disabled') && element.getClientRects().length);
      if (!focusable.length) return;
      if (event.shiftKey && document.activeElement === focusable[0]) {
        event.preventDefault();
        focusable.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === focusable.at(-1)) {
        event.preventDefault();
        focusable[0].focus();
      }
    };
    // Mientras el diálogo está activo se bloquea el desplazamiento de la página subyacente.
    document.addEventListener('keydown', listener);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      // La limpieza restaura el teclado, el desplazamiento y el foco cuando se cierra el diálogo.
      document.removeEventListener('keydown', listener);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, [close]);
  return <div className="dash-drawer-backdrop" onMouseDown={(event) => {if (event.target === event.currentTarget) close();}}>
    <section role="dialog" aria-modal="true" aria-labelledby="dash-dialog-title" id="dash-dialog" className="dash-drawer">
      <div className="dash-drawer-head"><div><h2 id="dash-dialog-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div><Button className="icon-only" onClick={close} aria-label="Cerrar"><X size={18} /></Button></div>
      <div className="dash-drawer-body">{children}</div>
    </section>
  </div>;
}

// Coordina los datos de la sesión y comparte las operaciones del espacio de trabajo entre sus vistas.
export function Dashboard({ initial }: {initial: DashboardData}) {
  // Empieza con los datos del servidor y mantiene localmente la navegación, el diálogo y los avisos.
  const [data, setData] = useState(initial);
  const [view, setView] = useState<View>('inbox');
  const [drawer, setDrawer] = useState<string | null>(null);
  const [workspaceMenu, setWorkspaceMenu] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{error?: boolean; text: string} | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const closeDrawer = useCallback(() => setDrawer(null), []);
  // Deriva el contexto de navegación y los indicadores a partir de la empresa seleccionada.
  const company = data.company;
  const route = navigation.find((item) => item.id === view)!;
  const attentionCount = data.requests.filter((request) => getAttentionReasons(request, now).length > 0).length;
  const activeRequest = data.requests.find((request) => request.id === drawer);
  const formPath = company ? `/f/${encodeURIComponent(company.slug)}` : '';
  const isAdmin = company?.role === 'admin';

  useEffect(() => {
    // Actualiza los vencimientos aunque la lista de solicitudes no se haya recargado.
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!notice) return;
    // Los mensajes de error permanecen más tiempo para facilitar su lectura.
    const timer = window.setTimeout(() => setNotice(null), notice.error ? 10000 : 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Obtiene la versión actual de los datos y deja que el servidor compruebe el acceso a la empresa.
  async function load(slug?: string) {
    const response = await fetch(`/api/workspace${slug ? `?company=${encodeURIComponent(slug)}` : ''}`, { cache: 'no-store' });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || 'No se pudo cargar la empresa.');
    }
    const next: DashboardData = await response.json();
    setData(next);
    setNow(Date.now());
    return next;
  }

  // Envía la operación, refresca los datos y devuelve el resultado para que el formulario decida si se cierra.
  const submit: Submit = async (action, message = 'Cambios guardados.') => {
    setPending(true);
    try {
      const response = await fetch('/api/workspace', {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({...action, company: company?.slug}),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'No se pudo guardar el cambio.');
      // Al crear una empresa, la respuesta del servidor identifica el nuevo espacio que debe abrirse.
      const next = await load(action.action === 'createCompany' ? result.company : company?.slug);
      if (action.action === 'createCompany' && next.company) rememberCompany(next.company.slug);
      setNotice({text: message});
      return true;
    } catch (error) {
      setNotice({error: true, text: error instanceof Error ? error.message : 'Ocurrió un error.'});
      return false;
    } finally {
      setPending(false);
    }
  };

  // Guarda la selección en la URL para conservarla si se recarga la página.
  function rememberCompany(slug: string) {
    const url = new URL(window.location.href);
    url.searchParams.set('company', slug);
    window.history.replaceState(null, '', url);
  }

  // Refresca la empresa actual sin cambiar de vista ni perder los filtros activos.
  async function refresh() {
    setPending(true);
    try {
      await load(company?.slug);
      setNotice({text: 'Datos actualizados.'});
    } catch (error) {
      setNotice({error: true, text: error instanceof Error ? error.message : 'No se pudieron actualizar los datos.'});
    } finally {
      setPending(false);
    }
  }

  // Tras cargar otra empresa, vuelve a su bandeja y cierra los menús y detalles del espacio anterior.
  async function switchCompany(slug: string) {
    setPending(true);
    try {
      await load(slug);
      rememberCompany(slug);
      setDrawer(null);
      setView('inbox');
      setWorkspaceMenu(false);
      setSidebarOpen(false);
    } catch (error) {
      setNotice({error: true, text: error instanceof Error ? error.message : 'No se pudo cargar la empresa.'});
    } finally {
      setPending(false);
    }
  }

  // Convierte la ruta interna en un enlace absoluto que se puede compartir fuera de la aplicación.
  async function copyLink(path: string) {
    try {
      await navigator.clipboard.writeText(new URL(path, window.location.origin).href);
      setNotice({text: 'Enlace copiado.'});
    } catch {
      setNotice({error: true, text: 'El navegador no permite copiar. Abre el enlace y cópialo desde la barra de direcciones.'});
    }
  }

  return <div className="dashboard-shell">
    {/* La cortina móvil permite cerrar el menú al tocar fuera de la barra lateral. */}
    <button className={`dash-sidebar-shade${sidebarOpen ? ' is-open' : ''}`} type="button" aria-label="Cerrar menú" onClick={() => setSidebarOpen(false)} />
    <aside className={`dashboard-sidebar${sidebarOpen ? ' is-open' : ''}`}>
      <div className="dash-brand"><span className="dash-brand-icon"><Activity size={20} strokeWidth={2.5} /></span>Pulso</div>
      {/* El selector ofrece las empresas accesibles para la cuenta activa. */}
      <button type="button" className="dash-workspace" aria-expanded={workspaceMenu} onClick={() => setWorkspaceMenu(!workspaceMenu)}>
        <span className="dash-avatar">{company?.logoUrl ? <img src={company.logoUrl} alt="" /> : company ? initials(company.name) : <UsersRound size={17} />}</span>
        <span className="dash-workspace-copy"><b>{company?.name ?? 'Mis empresas'}</b><small>{company ? industries[company.industry] : 'Espacio de trabajo'}</small></span>
        <ChevronDown className="workspace-chevron" size={15} />
      </button>
      {workspaceMenu && <div className="dash-workspace-menu">{data.companies.map((entry) => <button key={entry.id} type="button" disabled={pending} onClick={() => void switchCompany(entry.slug)}>{entry.slug === company?.slug ? <Check size={14} /> : <UsersRound size={14} />}{entry.name}</button>)}<button type="button" onClick={() => {setDrawer('company'); setWorkspaceMenu(false); setSidebarOpen(false);}}><Plus size={14} />Nueva empresa</button></div>}
      {/* La configuración se muestra a administradores y atención indica cuántas solicitudes revisar. */}
      <nav className="dash-nav" aria-label="Espacio de trabajo"><p className="dash-nav-label">Espacio de trabajo</p>{navigation.filter((item) => item.id !== 'settings' || isAdmin).map(({id,label,icon: Icon}) => <button type="button" key={id} className={`dash-nav-link${id === view ? ' is-active' : ''}`} aria-current={id === view ? 'page' : undefined} onClick={() => {setView(id); setSidebarOpen(false);}}><Icon size={17} />{label}{id === 'attention' && attentionCount > 0 && <span className="nav-count">{attentionCount}</span>}</button>)}</nav>
      {/* La sesión y el modo de demostración permanecen visibles al pie del menú. */}
      <div className="dash-sidebar-foot">
        {data.mode === 'demo' && <div className="dash-mode-card"><Sparkles size={14} />Modo demostración</div>}
        <div className="dash-profile"><span className="dash-avatar">{initials(data.viewer.name || data.viewer.email)}</span><div className="dash-profile-copy"><b>{data.viewer.name || data.viewer.email}</b><small>{isAdmin ? 'Administrador' : company ? 'Empleado' : 'Mi cuenta'}</small></div><form method="post" action="/api/auth/logout"><button title="Cerrar sesión" aria-label="Cerrar sesión"><LogOut size={16} /></button></form></div>
      </div>
    </aside>
    <div className="dashboard-main">
      {/* La cabecera identifica la vista y da acceso al formulario público y a los avisos. */}
      <header className="dash-topbar">
        <div className="dash-crumb"><Button className="icon-only dash-mobile-menu" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Abrir menú"><Menu size={18} /></Button><span className="dash-crumb-context">Espacio de trabajo</span><ChevronRight className="dash-crumb-chevron" size={14} /><b>{route.label}</b></div>
        {company && <div className="dash-topright"><a className="dash-button" href={formPath} target="_blank" rel="noreferrer"><ExternalLink size={14} /><span className="dash-toplink-text">Formulario público</span></a><Button className="icon-only" disabled={pending} onClick={() => void refresh()} aria-label="Actualizar datos" title="Actualizar datos"><RefreshCw size={15} /></Button><Button className="icon-only" onClick={() => {setView('attention'); setSidebarOpen(false);}} aria-label="Requiere atención"><Bell size={16} /></Button></div>}
      </header>
      {/* El contenido cambia al navegar y ofrece crear una empresa cuando la cuenta aún no tiene ninguna. */}
      <main className="dash-content">
        {!company && <><div className="dash-heading"><div><h1>Tu espacio de trabajo</h1><p>Crea una empresa para empezar a recibir solicitudes.</p></div><Button className="primary" onClick={() => setDrawer('company')}><Plus size={16} />Nueva empresa</Button></div><section className="dash-panel"><Empty text="Todavía no hay empresas" /></section></>}
        {company && (view === 'inbox' || view === 'attention') && <InboxView key={`${company.id}-${view}`} data={data} company={company} attentionOnly={view === 'attention'} now={now} open={setDrawer} />}
        {company && view === 'overview' && <Overview key={company.id} company={company} requests={data.requests} now={now} />}
        {company && view === 'automations' && <JobsView data={data} company={company} submit={submit} pending={pending} />}
        {company && view === 'settings' && isAdmin && <Settings key={company.id} company={company} data={data} submit={submit} pending={pending} formPath={formPath} copyLink={copyLink} />}
      </main>
    </div>
    {/* Se monta un único diálogo según la operación o la solicitud seleccionada. */}
    {drawer === 'company' && <CompanyDrawer submit={submit} pending={pending} close={closeDrawer} />}
    {drawer === 'new' && company && <NewRequest company={company} submit={submit} pending={pending} close={closeDrawer} />}
    {activeRequest && company && <RequestDrawer key={activeRequest.id} request={activeRequest} company={company} members={data.members} submit={submit} pending={pending} close={closeDrawer} error={(text) => setNotice({error: true, text})} />}
    {notice && <div role={notice.error ? 'alert' : 'status'} className={`dash-toast dash-notice ${notice.error ? 'error' : 'success'}`}>{notice.text}</div>}
  </div>;
}

export default Dashboard;

// Presenta una métrica con su unidad o criterio de cálculo junto al valor principal.
function Stat({ label, value, note, icon, tone }: {label: string; value: ReactNode; note: string; icon: ReactNode; tone: string}) {
  return <div className="dash-stat"><div className="dash-stat-top"><span className={`dash-stat-icon dash-tone-${tone}`}>{icon}</span>{label}</div><b className="dash-stat-value">{value}</b><small>{note}</small></div>;
}

// Comparte la tabla entre la bandeja completa y la vista de solicitudes que requieren atención.
function InboxView({ data, company, attentionOnly, now, open }: {data: DashboardData; company: DashboardCompany; attentionOnly: boolean; now: number; open: (id: string) => void}) {
  // Los filtros pertenecen a la vista y actúan sobre las solicitudes que ya devolvió el servidor.
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [origin, setOrigin] = useState('');
  const [owner, setOwner] = useState('');
  const [priority, setPriority] = useState('');
  const [tab, setTab] = useState<'all' | 'mine' | 'open'>('all');
  const origins = [...new Set(data.requests.map((request) => request.origin))].filter(Boolean).sort();
  // Combina la búsqueda de texto con los filtros de empresa y ordena por actividad reciente.
  const requests = data.requests.filter((request) => {
    const search = `${request.name} ${request.email} ${request.phone} ${request.service} ${request.subject} ${Object.values(request.data).join(' ')}`.toLocaleLowerCase('es');
    return (!query || search.includes(query.trim().toLocaleLowerCase('es')))
      && (!status || request.status === status) && (!origin || request.origin === origin)
      && (!owner || (owner === 'unassigned' ? !request.assigneeId : request.assigneeId === owner))
      && (!priority || request.priority === priority)
      && (tab !== 'mine' || request.assigneeId === data.viewer.id)
      && (tab !== 'open' || !request.closedAt)
      && (!attentionOnly || getAttentionReasons(request, now).length > 0);
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // Las tarjetas cuentan el total de solicitudes activas aunque el listado esté filtrado.
  const openRequests = data.requests.filter((request) => !request.closedAt);
  const overdue = openRequests.filter((request) => !request.firstResponseAt && request.slaDueAt && Date.parse(request.slaDueAt) <= now).length;
  const lateFollowup = openRequests.filter((request) => getAttentionReasons(request, now).includes('Seguimiento vencido')).length;
  const unassigned = openRequests.filter((request) => !request.assigneeId).length;
  const hasAttention = openRequests.some((request) => getAttentionReasons(request, now).length);

  return <>
    <div className="dash-heading"><div><h1>{attentionOnly ? 'Requiere atención' : 'Bandeja de entrada'}</h1><p>{attentionOnly ? 'Solicitudes abiertas que necesitan una acción del equipo.' : 'Gestiona las solicitudes de tus clientes desde un solo lugar.'}</p></div><Button className="primary" onClick={() => open('new')}><Plus size={16} />Nueva solicitud</Button></div>
    {/* Las tarjetas resumen el volumen de trabajo y los motivos que requieren una acción. */}
    <div className="dash-grid-metrics">
      <Stat label="Abiertas" value={openRequests.length} note="Solicitudes en curso" icon={<Inbox size={18} />} tone="purple" />
      <Stat label="Sin responsable" value={unassigned} note="Pendientes de asignación" icon={<UserRound size={18} />} tone="orange" />
      <Stat label="Fuera de plazo" value={overdue} note="Sin primera respuesta humana" icon={<Clock3 size={18} />} tone="rose" />
      <Stat label="Seguimiento vencido" value={lateFollowup} note="Con una acción atrasada" icon={<CalendarDays size={18} />} tone="blue" />
    </div>
    <section className="dash-panel">
      <div className="dash-panel-title"><div><h2>{attentionOnly ? 'Solicitudes que requieren atención' : 'Solicitudes'}</h2></div><span className="dash-badge neutral">{requests.length} {requests.length === 1 ? 'solicitud' : 'solicitudes'}</span></div>
      {/* Las pestañas agrupan solicitudes y los filtros acotan los resultados visibles. */}
      {!attentionOnly && <div className="dash-tabs" aria-label="Grupo de solicitudes"><button type="button" className="dash-tab" aria-pressed={tab === 'all'} onClick={() => setTab('all')}>Todas</button><button type="button" className="dash-tab" aria-pressed={tab === 'mine'} onClick={() => setTab('mine')}>Asignadas a mí</button><button type="button" className="dash-tab" aria-pressed={tab === 'open'} onClick={() => setTab('open')}>Abiertas</button></div>}
      <div className="dash-filterbar">
        <label className="dash-search"><Search size={16} /><input className="dash-input" aria-label="Buscar solicitudes" placeholder="Buscar por cliente, servicio…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <select className="dash-select" aria-label="Estado" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Estado</option>{company.statuses.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select>
        <select className="dash-select" aria-label="Origen" value={origin} onChange={(event) => setOrigin(event.target.value)}><option value="">Origen</option>{origins.map((entry) => <option key={entry} value={entry}>{sourceLabels[entry] ?? entry}</option>)}</select>
        <select className="dash-select" aria-label="Responsable" value={owner} onChange={(event) => setOwner(event.target.value)}><option value="">Responsable</option><option value="unassigned">Sin responsable</option>{data.members.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select>
        <select className="dash-select" aria-label="Prioridad" value={priority} onChange={(event) => setPriority(event.target.value)}><option value="">Prioridad</option>{Object.entries(priorityLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
      </div>
      {/* La misma tabla muestra una recomendación de acción o los motivos de atención. */}
      {requests.length ? <div className="dash-table-wrapper"><table className="dash-table"><thead><tr><th>Cliente</th><th>Estado</th><th>Prioridad</th><th>Responsable</th><th>Origen</th><th>Última actividad</th><th>{attentionOnly ? 'Motivos' : 'Próxima acción'}</th><th aria-label="Abrir solicitud" /></tr></thead><tbody>
        {requests.map((request, index) => {
          const reasons = getAttentionReasons(request, now);
          // La acción escrita por el equipo tiene prioridad sobre las sugerencias derivadas de fechas y tareas.
          const next = request.nextAction ?? (request.followupAt ? `Seguimiento · ${dateLabel(request.followupAt, company.timezone)}`
            : request.appointmentAt ? `Cita · ${dateLabel(request.appointmentAt, company.timezone)}`
            : request.followups.some((task) => !task.completedAt) ? 'Completar seguimiento'
            : reasons[0] ?? (request.closedAt ? '—' : !request.firstResponseAt ? 'Responder al cliente' : '—'));
          return <tr key={request.id} data-interactive onClick={() => open(request.id)}>
            <td><div className="dash-table-person"><span className={`dash-avatar avatar-${index % 5}`}>{initials(request.name)}</span><div><button type="button" className="dash-text-button" onClick={(event) => {event.stopPropagation(); open(request.id);}}>{request.name}</button><p>{request.service || 'Solicitud general'}</p></div></div></td>
            <td><StatusBadge status={company.statuses.find((entry) => entry.id === request.status)} /></td>
            <td><span className={`dash-inline dash-priority-${request.priority}`}><span className="dash-dot" />{priorityLabels[request.priority]}</span></td>
            <td>{data.members.find((member) => member.id === request.assigneeId)?.name ?? <span className="dash-muted">Sin asignar</span>}</td>
            <td>{sourceLabels[request.origin] ?? request.origin ?? '—'}</td>
            <td>{dateLabel(request.updatedAt, company.timezone, true)}</td>
            <td className={`dash-next${reasons.length ? ' dash-overdue' : ''}`}>{attentionOnly ? reasons.join(' · ') : next}</td>
            <td><ChevronRight className="dash-arrow" size={15} /></td>
          </tr>;
        })}
      </tbody></table></div> : <Empty text={attentionOnly && !hasAttention ? 'Todo al día' : 'No se encontraron solicitudes'} detail={attentionOnly && !hasAttention ? 'Las solicitudes pendientes aparecerán aquí.' : 'Prueba con otros filtros o añade una solicitud.'} />}
      <div className="dash-table-foot"><span>Mostrando {requests.length} de {data.requests.length} solicitudes</span>{(query || status || origin || owner || priority) && <button type="button" className="dash-text-button" onClick={() => {setQuery(''); setStatus(''); setOrigin(''); setOwner(''); setPriority('');}}>Limpiar filtros</button>}</div>
    </section>
  </>;
}

// El alta de empresa permite elegir un conjunto inicial de servicios, campos y estados.
function CompanyDrawer({ submit, pending, close }: {submit: Submit; pending: boolean; close: () => void}) {
  // Recoge el nombre y el sector y mantiene el diálogo abierto si el servidor rechaza el alta.
  async function handle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    if (await submit({action: 'createCompany', name: String(values.get('name')), industry: String(values.get('industry')) as Industry}, 'Empresa creada.')) close();
  }
  return <Drawer title="Nueva empresa" subtitle="Elige una configuración inicial para tu espacio de trabajo." close={close}>
    <form className="dash-form" onSubmit={handle}>
      <Field label="Nombre de la empresa"><input className="dash-input" name="name" maxLength={120} required placeholder="Nombre comercial" /></Field>
      <Field label="Configuración inicial" help="Podrás editar los campos, estados y reglas después de crearla.">
        <select className="dash-select" name="industry" defaultValue="custom">{Object.entries(industries).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
      </Field>
      <div className="dash-form-actions"><Button className="primary" type="submit" disabled={pending}><Plus size={15} />Crear empresa</Button></div>
    </form>
  </Drawer>;
}

// Construye el control apropiado para cada campo configurado y agrupa sus valores mediante un prefijo.
function ManualField({ field }: {field: DashboardField}) {
  const props = { name: `field:${field.id}`, 'aria-label': field.label };
  if (field.type === 'checkbox') return <label className="dash-check"><input type="checkbox" {...props} value="Sí" />{field.label}</label>;
  return <Field label={field.label}>
    {field.type === 'textarea' ? <textarea className="dash-textarea" maxLength={2000} {...props} />
      : field.type === 'select' ? <select className="dash-select" {...props}><option value="">Selecciona…</option>{field.options?.map((value) => <option key={value}>{value}</option>)}</select>
      : <input className="dash-input" type={field.type} maxLength={2000} step={field.type === 'number' ? 'any' : undefined} {...props} />}
  </Field>;
}

// Recoge la información de solicitudes que el equipo recibe por canales externos.
function NewRequest({ company, submit, pending, close }: {company: DashboardCompany; submit: Submit; pending: boolean; close: () => void}) {
  // Combina los datos de contacto y origen con las respuestas configuradas para la empresa.
  async function handle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const read = (key: string) => String(values.get(key) ?? '');
    // Envía las respuestas con las claves de configuración y omite los campos que quedaron vacíos.
    const data = Object.fromEntries(company.fields.flatMap((field) => {
      const value = read(`field:${field.id}`);
      return value ? [[field.id, value]] : [];
    }));
    if (await submit({action: 'createRequest', name: read('name'), email: read('email'), phone: read('phone'), service: read('service'),
      origin: read('origin'), priority: read('priority') as RequestPriority, data}, 'Solicitud registrada.')) close();
  }
  return <Drawer title="Nueva solicitud" subtitle="Registra una solicitud recibida por otro canal." close={close}>
    <form className="dash-form" onSubmit={handle}>
      <Field label="Nombre del cliente"><input className="dash-input" name="name" required maxLength={160} /></Field>
      <div className="dash-form-grid">
        <Field label="Correo electrónico"><input className="dash-input" name="email" type="email" maxLength={254} /></Field>
        <Field label="Teléfono"><input className="dash-input" name="phone" type="tel" maxLength={40} /></Field>
      </div>
      <Field label="Servicio"><select className="dash-select" name="service"><option value="">Solicitud general</option>{company.services.map((value) => <option key={value}>{value}</option>)}</select></Field>
      <div className="dash-form-grid">
        <Field label="Origen"><input className="dash-input" name="origin" list="dash-source-options" required defaultValue="phone" maxLength={80} /></Field><datalist id="dash-source-options">{Object.entries(sourceLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</datalist>
        <Field label="Prioridad"><select className="dash-select" name="priority" defaultValue="normal">{Object.entries(priorityLabels).map(([id,label]) => <option key={id} value={id}>{label}</option>)}</select></Field>
      </div>
      {/* Los campos adicionales dependen de la configuración de la empresa activa. */}
      {company.fields.length > 0 && <><h3>Datos de la solicitud</h3>{company.fields.map((field) => <ManualField key={field.id} field={field} />)}</>}
      <div className="dash-form-actions"><Button className="primary" type="submit" disabled={pending}><Plus size={15} />Registrar solicitud</Button></div>
    </form>
  </Drawer>;
}

// Agrupa el detalle de una solicitud, su edición y las actividades que el equipo puede registrar.
function RequestDrawer({ request, company, members, submit, pending, close, error }: {
  request: DashboardRequest; company: DashboardCompany; members: DashboardData['members']; submit: Submit;
  pending: boolean; close: () => void; error: (text: string) => void;
}) {
  // Conserva las entradas de cada operación mientras se mantiene abierto el detalle.
  const [outcome, setOutcome] = useState<RequestOutcome>(request.outcome ?? 'won');
  const [whatsapp, setWhatsapp] = useState(`Hola, ${request.name}. Te escribimos desde ${company.name} sobre tu solicitud${request.service ? ` de ${request.service}` : ''}.`);
  const [whatsappPhone, setWhatsappPhone] = useState(request.phone);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [selectedFields, setSelectedFields] = useState<string[]>([]);
  // Resuelve los datos de presentación y distingue las tareas automáticas del seguimiento manual.
  const currentStatus = company.statuses.find((entry) => entry.id === request.status);
  const phone = whatsappPhone.replace(/\D/g, '').replace(/^00/, '');
  const tasks = request.followups.filter((task) => !task.completedAt);
  const manualFollowup = !request.closedAt && request.followupAt;
  const zone = company.timezone;

  // Normaliza el formulario de estado, asignación, prioridad y agenda en una actualización.
  async function saveRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const read = (name: string) => String(values.get(name) ?? '');
    try {
      await submit({
        action: 'updateRequest', requestId: request.id, status: read('status'), priority: read('priority') as RequestPriority,
        assigneeId: read('assignee') || null, nextAction: read('nextAction') || null,
        // Omitir una fecha sin cambios conserva el instante original y permite eliminarla al enviarla vacía.
        followupAt: read('followup') !== localDateTime(request.followupAt, zone) ? utcDateTime(read('followup'), zone) : undefined,
        appointmentAt: read('appointment') !== localDateTime(request.appointmentAt, zone) ? utcDateTime(read('appointment'), zone) : undefined,
      });
    } catch (err) {
      error(err instanceof Error ? err.message : 'Introduce una fecha y hora válida.');
    }
  }

  // El botón que envía el formulario distingue una nota interna de un contacto con el cliente.
  async function addEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form, (event.nativeEvent as SubmitEvent).submitter);
    const kind = values.get('kind') === 'contact' ? 'contact' : 'note';
    if (await submit({action: 'addEvent', requestId: request.id, kind, text: String(values.get('text'))},
      kind === 'note' ? 'Nota añadida.' : 'Contacto registrado.')) form.reset();
  }

  // Guarda el resultado y el dato adicional que le corresponde, importe o motivo de pérdida.
  async function closeRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await submit({
      action: 'updateRequest', requestId: request.id, outcome,
      amount: outcome === 'won' && values.get('amount') ? Number(values.get('amount')) : null,
      lostReason: outcome === 'lost' ? String(values.get('lostReason') ?? '') : null,
    }, 'Resultado guardado.');
  }

  // Alterna qué datos podrá completar el cliente cuando se le envíe la solicitud de información.
  function selectField(id: string) {
    setSelectedFields((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  }

  return <Drawer title={request.name} subtitle={`${request.service || request.subject || 'Solicitud general'} · ${dateLabel(request.createdAt, zone, true)}`} close={close}>
    {/* Los datos de contacto incorporan las respuestas de los campos personalizados. */}
    <section className="dash-detail-section">
      <div className="dash-config-title"><h3>Datos del cliente</h3><StatusBadge status={currentStatus} /></div>
      <dl className="dash-keyvalues">
        {request.email && <div><dt>Correo</dt><dd><a className="dash-text-button" href={`mailto:${request.email}`}>{request.email}</a></dd></div>}
        {request.phone && <div><dt>Teléfono</dt><dd><a className="dash-text-button" href={`tel:${request.phone}`}>{request.phone}</a></dd></div>}
        <div><dt>Origen</dt><dd>{sourceLabels[request.origin] ?? request.origin}</dd></div>
        {Object.entries(request.data).map(([key,value]) => <div key={key}><dt>{company.fields.find((field) => field.id === key)?.label ?? key}</dt><dd>{value || '—'}</dd></div>)}
      </dl>
    </section>
    {/* El formulario vuelve a cargar sus valores cuando se confirma una actualización del detalle. */}
    <form className="dash-form dash-detail-section" key={request.updatedAt} onSubmit={saveRequest}>
      <h3>Gestionar solicitud</h3>
      <div className="dash-form-grid">
        <Field label="Estado"><select className="dash-select" name="status" defaultValue={request.status}>{company.statuses.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></Field>
        <Field label="Prioridad"><select className="dash-select" name="priority" defaultValue={request.priority}>{Object.entries(priorityLabels).map(([id,label]) => <option key={id} value={id}>{label}</option>)}</select></Field>
      </div>
      <Field label="Responsable"><select className="dash-select" name="assignee" defaultValue={request.assigneeId ?? ''}><option value="">Sin responsable</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></Field>
      <Field label="Próxima acción"><input className="dash-input" name="nextAction" maxLength={300} defaultValue={request.nextAction ?? ''} placeholder="Ej. Llamar para confirmar detalles" /></Field>
      <div className="dash-form-grid">
        <Field label="Fecha de seguimiento"><input className="dash-input" name="followup" type="datetime-local" defaultValue={localDateTime(request.followupAt, zone)} /></Field>
        <Field label="Cita confirmada"><input className="dash-input" name="appointment" type="datetime-local" defaultValue={localDateTime(request.appointmentAt, zone)} /></Field>
      </div>
      <small className="dash-muted">Zona horaria {zone}</small>
      <div className="dash-form-actions"><Button className="primary" type="submit" disabled={pending}>Guardar cambios</Button></div>
    </form>
    {/* El equipo puede completar por separado seguimientos manuales y generados por una regla. */}
    {(tasks.length > 0 || manualFollowup) && <section className="dash-detail-section">
      <h3>Seguimientos pendientes</h3>
      {manualFollowup && <div className="dash-config-row">
        <p>{request.nextAction || 'Seguimiento programado por el equipo'}</p>
        <small className="dash-muted">Vence el {dateLabel(request.followupAt, zone, true)}</small>
        <div><Button className="small" disabled={pending} onClick={() => void submit({action: 'addEvent', requestId: request.id, kind: 'completeFollowup', text: ''}, 'Seguimiento completado.')}><Check size={14} />Completar seguimiento</Button></div>
      </div>}
      {tasks.map((task) => <div key={task.id} className="dash-config-row"><p>{task.message || 'Seguimiento de solicitud'}</p><small className="dash-muted">{task.dueAt ? `Vence el ${dateLabel(task.dueAt, zone, true)}` : 'Sin vencimiento'}</small><div><Button className="small" disabled={pending} onClick={() => void submit({action: 'addEvent', requestId: request.id, kind: 'completeFollowup', followupId: task.id, text: ''}, 'Seguimiento completado.')}><Check size={14} />Completar seguimiento</Button></div></div>)}
    </section>}
    {/* Se abre WhatsApp con el borrador editable. El contacto se registra desde el historial. */}
    {request.phone && <details><summary>Escribir por WhatsApp</summary>
      <div className="dash-form"><Field label="Teléfono con prefijo internacional" help="Ej. +34 seguido del número."><input className="dash-input" type="tel" value={whatsappPhone} onChange={(event) => setWhatsappPhone(event.target.value)} /></Field><Field label="Mensaje editable"><textarea className="dash-textarea" value={whatsapp} onChange={(event) => setWhatsapp(event.target.value)} /></Field>
      <small className="dash-muted">Revisa y envía el mensaje en WhatsApp. Después puedes registrar el contacto en el historial.</small>
      <div>{phone.length >= 8 && <a className="dash-button" href={`https://wa.me/${phone}?text=${encodeURIComponent(whatsapp)}`} target="_blank" rel="noreferrer"><MessageCircle size={14} />Abrir WhatsApp<ArrowUpRight size={13} /></a>}</div></div>
    </details>}
    {/* Si la regla está activa, el equipo especifica los campos que pueden rellenarse mediante el enlace. */}
    {request.email && company.fields.length > 0 && company.rules.information.enabled && !request.closedAt && <details><summary>Pedir información al cliente</summary>
      <div className="dash-form"><small className="dash-muted">El cliente recibirá un enlace temporal para rellenar los campos seleccionados.</small>
        {company.fields.map((field) => <label key={field.id} className="dash-check"><input type="checkbox" checked={selectedFields.includes(field.id)} onChange={() => selectField(field.id)} />{field.label}</label>)}
        <div><Button disabled={pending || !selectedFields.length} onClick={async () => {if (await submit({action: 'requestInfo', requestId: request.id, fields: selectedFields}, 'Petición de información programada.')) setSelectedFields([]);}}><Mail size={14} />Confirmar envío</Button></div>
      </div>
    </details>}
    {/* El resultado determina si se solicita el importe confirmado o el motivo de pérdida. */}
    <details><summary>{request.closedAt ? 'Resultado de la solicitud' : 'Cerrar solicitud'}</summary>
      <form className="dash-form" key={request.closedAt ?? ''} onSubmit={closeRequest}>
        <Field label="Resultado"><select className="dash-select" value={outcome} onChange={(event) => setOutcome(event.target.value as RequestOutcome)}><option value="won">Conseguida</option><option value="lost">Perdida</option></select></Field>
        {outcome === 'won' ? <Field label="Importe confirmado (€)"><input className="dash-input" name="amount" type="number" min="0" max="9999999999.99" step="0.01" defaultValue={request.amount ?? ''} /></Field>
          : <Field label="Motivo de pérdida"><textarea className="dash-textarea" name="lostReason" maxLength={1000} defaultValue={request.lostReason ?? ''} /></Field>}
        <div><Button className="primary" type="submit" disabled={pending}><CheckCircle2 size={14} />{request.closedAt ? 'Guardar resultado' : 'Confirmar cierre'}</Button></div>
      </form>
    </details>
    {/* El historial mantiene juntos el actor, el texto y la fecha de cada actividad. */}
    <section className="dash-detail-section">
      <h3>Historial</h3>
      <ol className="dash-activity">
        {request.events.map((event) => <li key={event.id}><span className="activity-icon"><Activity size={13} /></span><div><b>{eventLabels[event.kind] ?? event.kind.replace(/_/g, ' ')}</b><p>{event.text}</p><small>{event.actor} · {dateLabel(event.at, zone, true)}</small></div></li>)}
      </ol>
      <form className="dash-form" onSubmit={addEvent}>
        <Field label="Añadir al historial"><textarea className="dash-textarea" name="text" required maxLength={4000} placeholder="Escribe una nota o describe el contacto…" /></Field>
        <div className="dash-form-actions"><Button type="submit" name="kind" value="note" disabled={pending}>Añadir nota</Button><Button type="submit" name="kind" value="contact" disabled={pending}>Registrar contacto</Button></div>
      </form>
    </section>
    {/* La eliminación requiere confirmar la acción en el detalle administrativo. */}
    {company.role === 'admin' && <details><summary>Eliminar solicitud</summary>
      <div className="dash-form"><p className="dash-muted">Se eliminarán la solicitud y su historial.</p>
        <label className="dash-check"><input type="checkbox" checked={confirmDelete} onChange={(event) => setConfirmDelete(event.target.checked)} />Confirmo la eliminación</label>
        <div><Button className="danger" disabled={pending || !confirmDelete} onClick={async () => {if (await submit({action: 'deleteRequest', requestId: request.id}, 'Solicitud eliminada.')) close();}}><Trash2 size={14} />Eliminar solicitud</Button></div>
      </div>
    </details>}
  </Drawer>;
}

// Calcula los indicadores y la distribución por canal para el periodo seleccionado.
function Overview({ company, requests, now }: {company: DashboardCompany; requests: DashboardRequest[]; now: number}) {
  const [origin, setOrigin] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Como el cálculo excluye el extremo final, usa la medianoche del día siguiente para incluir todo el día elegido.
  const nextDay = to ? new Date(Date.parse(`${to}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10) : '';
  const bounds = {from: from ? utcDateTime(`${from}T00:00`, company.timezone) ?? undefined : undefined,
    to: nextDay ? utcDateTime(`${nextDay}T00:00`, company.timezone) ?? undefined : undefined};
  const origins = [...new Set(requests.map((request) => request.origin))].sort();
  const filter = {...bounds, source: origin, now: new Date(now)};
  const metrics = getDashboardMetrics(requests, filter);
  const channels = origin ? [origin] : origins;
  // Obtiene los recuentos por canal con el mismo periodo y ordena de mayor a menor para el gráfico.
  const counts = channels.map((channel) => ({channel, count: getDashboardMetrics(requests, {...filter, source: channel}).received}))
    .filter((row) => row.count > 0).sort((a,b) => b.count - a.count);

  return <>
    <div className="dash-heading"><div><h1>Resumen</h1><p>Actividad y resultados de {company.name}.</p></div></div>
    {/* El periodo y origen seleccionados se aplican a las tarjetas y a los resúmenes. */}
    <div className="dash-panel dash-padded dash-filterbar dash-report-filters">
      <Field label="Desde"><input className="dash-input" type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} /></Field>
      <Field label="Hasta"><input className="dash-input" type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} /></Field>
      <Field label="Origen"><select className="dash-select" value={origin} onChange={(event) => setOrigin(event.target.value)}><option value="">Todos los orígenes</option>{origins.map((item) => <option key={item} value={item}>{sourceLabels[item] ?? item}</option>)}</select></Field>
      {(from || to || origin) && <Button onClick={() => {setFrom(''); setTo(''); setOrigin('');}}>Limpiar filtros</Button>}
    </div>
    <div className="dash-grid-metrics">
      <Stat label="Recibidas" value={metrics.received} note="Solicitudes en el periodo" icon={<Inbox size={18} />} tone="purple" />
      <Stat label="Primera respuesta" value={formatDuration(metrics.medianResponseMinutes)} note="Mediana de respuesta humana" icon={<Clock3 size={18} />} tone="blue" />
      <Stat label="Vencidas" value={metrics.overdue} note="Abiertas y fuera de plazo" icon={<CircleAlert size={18} />} tone="rose" />
      <Stat label="Tasa de cierre" value={metrics.closeRate === null ? '—' : `${new Intl.NumberFormat('es-ES', {maximumFractionDigits: 1}).format(metrics.closeRate * 100)} %`} note={`${metrics.won} conseguidas de ${metrics.resolved} resueltas`} icon={<CheckCircle2 size={18} />} tone="green" />
    </div>
    {/* El resumen muestra la distribución de solicitudes y los resultados observados tras seguimientos. */}
    <div className="dash-settings-grid">
      <section className="dash-panel dash-padded"><div className="dash-form"><h3>Solicitudes por origen</h3>{counts.length ? <div className="dash-report-bars">{counts.map(({channel, count}) => <div key={channel} className="dash-report-item"><span>{sourceLabels[channel] ?? channel}</span><div className="dash-report-track"><div className="dash-report-fill" style={{width: `${Math.round(count / counts[0].count * 100)}%`}} /></div><b>{count}</b></div>)}</div> : <p className="dash-muted">Sin solicitudes en este periodo.</p>}</div></section>
      <section className="dash-panel dash-padded"><div className="dash-form"><h3>Seguimientos y resultados</h3><dl className="dash-keyvalues dash-report-results">
        <div><dt>Importe confirmado</dt><dd><b>{money.format(metrics.confirmedAmount)}</b></dd></div>
        <div><dt>Seguimientos generados</dt><dd>{metrics.followUpsGenerated}</dd></div>
        <div><dt>Seguimientos completados</dt><dd>{metrics.followUpsCompleted}</dd></div>
        <div><dt>Conseguidas tras un seguimiento completado</dt><dd>{metrics.wonAfterFollowUp}</dd></div>
      </dl></div></section>
    </div>
  </>;
}

// Muestra la cola y el historial de reglas con opciones de filtrado y reintento según el rol.
function JobsView({ data, company, submit, pending }: {data: DashboardData; company: DashboardCompany; submit: Submit; pending: boolean}) {
  const [status, setStatus] = useState<DashboardJob['status'] | ''>('');
  const [kind, setKind] = useState<RuleKey | ''>('');
  // Conserva los filtros en la vista para comparar ejecuciones de una misma regla o estado.
  const visible = data.jobs.filter((job) => (!status || status === job.status) && (!kind || kind === job.kind));
  return <>
    <div className="dash-heading"><div><h1>Automatizaciones</h1><p>Consulta las próximas ejecuciones y los resultados de tus reglas.</p></div></div>
    {/* El aviso permite saber si las reglas entregan correos o solo simulan el envío. */}
    <p className="dash-notice"><Mail size={15} aria-hidden="true" /> {data.mailMode === 'live' ? 'Correo real activado' : 'Correo simulado en desarrollo. Los mensajes se registran en el historial.'}</p>
    <section className="dash-panel dash-panel-jobs">
      <div className="dash-panel-title"><div><h2>Historial de ejecución</h2></div><span className="dash-badge neutral">{visible.length} ejecuciones</span></div>
      <div className="dash-filterbar">
        <select className="dash-select" aria-label="Estado de ejecución" value={status} onChange={(event) => setStatus(event.target.value as DashboardJob['status'] | '')}><option value="">Todos los estados</option>{Object.entries(jobLabels).map(([id,label]) => <option key={id} value={id}>{label}</option>)}</select>
        <select className="dash-select" aria-label="Tipo de regla" value={kind} onChange={(event) => setKind(event.target.value as RuleKey | '')}><option value="">Todas las reglas</option>{Object.entries(ruleLabels).map(([id,label]) => <option key={id} value={id}>{label}</option>)}</select>
      </div>
      {/* Los errores se muestran junto al trabajo que falló para facilitar su revisión y reintento. */}
      {visible.length ? <div className="dash-table-wrapper"><table className="dash-table"><thead><tr><th>Regla</th><th>Solicitud</th><th>Programada</th><th>Estado</th><th>Intentos</th><th>Detalle</th></tr></thead><tbody>
        {visible.map((job) => <tr key={job.id}><td><b>{ruleLabels[job.kind]}</b></td><td>{data.requests.find((request) => request.id === job.requestId)?.name ?? '—'}</td><td>{dateLabel(job.runAt, company.timezone, true)}</td><td><span className={`dash-badge ${job.status === 'failed' ? 'dash-tone-rose' : job.status === 'done' ? 'dash-tone-green' : 'neutral'}`}><span className="dash-dot" />{jobLabels[job.status]}</span></td><td>{job.attempts}</td><td className="dash-next">{job.error && <p className="dash-job-error">{job.error}</p>}{job.status === 'failed' && company.role === 'admin' && <Button className="small" disabled={pending} onClick={() => void submit({action: 'retryJob', jobId: job.id}, 'Ejecución programada de nuevo.')}>Reintentar</Button>}</td></tr>)}
      </tbody></table></div> : <Empty text="No hay ejecuciones en esta vista" detail="Las reglas aparecerán aquí cuando se programen." />}
    </section>
  </>;
}

// Los nombres visibles reflejan los controles disponibles y las unidades específicas de cada regla.
const fieldTypes: Record<DashboardField['type'], string> = {
  text: 'Texto corto', textarea: 'Texto largo', select: 'Lista de opciones', date: 'Fecha',
  email: 'Correo electrónico', tel: 'Teléfono', number: 'Número', checkbox: 'Casilla',
};
const ruleDelays = {sla: 'Objetivo (minutos laborables)', quoteFollowup: 'Espera (días)', appointmentReminder: 'Antelación (minutos)'} as const;

// La configuración administrativa combina edición de empresa, formulario, flujo y reglas de automatización.
function Settings({ company, data, submit, pending, formPath, copyLink }: {
  company: DashboardCompany; data: DashboardData; submit: Submit; pending: boolean;
  formPath: string; copyLink: (path: string) => Promise<void>;
}) {
  const [tab, setTab] = useState<'company' | 'form' | 'workflow' | 'rules' | 'team'>('company');
  // Mantiene un borrador común para que los cambios de una pestaña se conserven al visitar otra.
  const [settings, setSettings] = useState(company);
  const [servicesText, setServicesText] = useState(company.services.join('\n'));
  const [fieldOptions, setFieldOptions] = useState<Record<string, string>>(() => Object.fromEntries(company.fields.map((field) => [field.id, field.options?.join('\n') || ''])));
  const [source, setSource] = useState('instagram');
  const [dirty, setDirty] = useState(false);
  // El formulario público lee la etiqueta en el parámetro origen para atribuir nuevas solicitudes.
  const taggedPath = source.trim() ? `${formPath}?origen=${encodeURIComponent(source.trim())}` : formPath;

  // Actualiza una sección tipada del borrador y habilita el guardado.
  function change<K extends keyof DashboardCompany>(key: K, value: DashboardCompany[K]) {
    setSettings((current) => ({...current, [key]: value}));
    setDirty(true);
  }

  // Persiste los cambios de las pestañas de configuración en una sola operación.
  async function handle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Normaliza las listas introducidas como texto al construir la configuración que valida el servidor.
    const fields = settings.fields.map((field) => ({...field, options: (fieldOptions[field.id] ?? (field.options ?? []).join('\n')).split('\n').map((option) => option.trim()).filter(Boolean)}));
    const {name, logoUrl, color, timezone, businessHours, statuses, rules} = settings;
    if (await submit({action: 'updateCompany', settings: {
      name, logoUrl, color, timezone, businessHours, statuses, rules, fields,
      services: servicesText.split('\n').map((line) => line.trim()).filter(Boolean),
    }}, 'Configuración guardada.')) {
      setDirty(false);
      // La recarga sustituye los identificadores provisionales por los asignados por PostgreSQL.
    }
  }

  useEffect(() => {
    // La configuración devuelta por el servidor sustituye el borrador solo si no hay cambios pendientes.
    if (!dirty) {
      setSettings(company);
      setServicesText(company.services.join('\n'));
      setFieldOptions(Object.fromEntries(company.fields.map((field) => [field.id, field.options?.join('\n') || ''])));
    }
  }, [company, dirty]);

  // Aplica los cambios al campo correspondiente conservando la posición del resto de campos.
  function changeField(id: string, value: Partial<DashboardField>) {
    change('fields', settings.fields.map((field) => field.id === id ? {...field, ...value} : field));
  }
  // Modifica el estado por identificador para conservar su vinculación con solicitudes existentes.
  function changeStatus(id: string, value: Partial<DashboardStatus>) {
    change('statuses', settings.statuses.map((status) => status.id === id ? {...status, ...value} : status));
  }
  // Conserva los valores de las demás reglas y los atributos de la regla que no se han editado.
  function changeRule(id: RuleKey, value: Partial<DashboardCompany['rules'][RuleKey]>) {
    change('rules', {...settings.rules, [id]: {...settings.rules[id], ...value}});
  }
  // Reordena una copia con los controles de subir y bajar y conserva la lista original.
  function moved<T>(items: T[], index: number, offset: number) {
    const reordered = [...items];
    const item = reordered[index];
    reordered.splice(index, 1);
    reordered.splice(index + offset, 0, item);
    return reordered;
  }

  // Prepara el acceso por correo y rol. La persona invitada completa su entrada al iniciar sesión.
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    if (await submit({action: 'addMember', email: String(values.get('email')), role: String(values.get('role')) as DashboardRole}, 'Acceso preparado. La persona debe iniciar sesión con el email indicado.')) form.reset();
  }

  return <>
    <div className="dash-heading"><div><h1>Configuración</h1><p>Adapta Pulso a la forma de trabajar de {company.name}.</p></div><a className="dash-button" href={`/api/workspace/export?company=${encodeURIComponent(company.slug)}`}><Download size={15} />Exportar solicitudes</a></div>
    {/* Las pestañas organizan los ajustes sin generar operaciones de guardado independientes. */}
    <section className="dash-panel dash-settings-tabs"><div className="dash-tabs" aria-label="Áreas de configuración">
      {([['company','Empresa'], ['form','Formulario'], ['workflow','Estados'], ['rules','Reglas y plantillas'], ['team','Equipo']] as const).map(([id,label]) => <button type="button" key={id} className="dash-tab" aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}
    </div></section>
    {tab !== 'team' && <form onSubmit={handle} className="dash-form dash-settings-form">
      {/* La identidad se usa en el formulario público. El horario interviene en el cálculo de plazos. */}
      {tab === 'company' && <div className="dash-settings-grid">
        <section className="dash-panel dash-padded dash-form"><h3>Identidad</h3>
          <Field label="Nombre de la empresa"><input className="dash-input" value={settings.name} onChange={(event) => change('name', event.target.value)} required maxLength={120} /></Field>
          <Field label="URL del logotipo"><input className="dash-input" type="url" value={settings.logoUrl} onChange={(event) => change('logoUrl', event.target.value)} placeholder="https://…" /></Field>
          <Field label="Color principal"><input className="dash-color-input" type="color" value={settings.color} onChange={(event) => change('color', event.target.value)} /></Field>
        </section>
        <section className="dash-panel dash-padded dash-form"><h3>Horario laboral</h3>
          <Field label="Zona horaria" help="Ej. Europe/Madrid o Atlantic/Canary"><input className="dash-input" name="timezone" value={settings.timezone} onChange={(event) => change('timezone', event.target.value)} required maxLength={80} /></Field>
          <div className="dash-form-actions" aria-label="Días laborables">{dayLabels.map((label, day) => <label key={label} className="dash-check"><input type="checkbox" checked={settings.businessHours.weekdays.includes(day)} onChange={(event) => change('businessHours', {...settings.businessHours, weekdays: event.target.checked ? [...settings.businessHours.weekdays, day] : settings.businessHours.weekdays.filter((value) => value !== day)})} />{label}</label>)}</div>
          <div className="dash-form-grid"><Field label="Apertura"><input className="dash-input" type="time" value={settings.businessHours.start} onChange={(event) => change('businessHours', {...settings.businessHours, start: event.target.value})} required /></Field><Field label="Cierre"><input className="dash-input" type="time" value={settings.businessHours.end} onChange={(event) => change('businessHours', {...settings.businessHours, end: event.target.value})} required /></Field></div>
        </section>
      </div>}
      {/* El editor controla los servicios, los enlaces por canal y los campos de captación. */}
      {tab === 'form' && <>
        <div className="dash-settings-grid">
          <section className="dash-panel dash-padded dash-form"><h3>Servicios</h3><Field label="Servicios disponibles" help="Escribe un servicio por línea, en el orden en que quieres mostrarlo."><textarea className="dash-textarea" rows={4} value={servicesText} onChange={(event) => {setServicesText(event.target.value); setDirty(true);}} /></Field></section>
          <section className="dash-panel dash-padded dash-form"><h3>Enlaces para compartir</h3><Field label="Etiqueta de origen"><input className="dash-input" list="dash-link-sources" value={source} onChange={(event) => setSource(event.target.value)} maxLength={60} /></Field><datalist id="dash-link-sources">{Object.entries(sourceLabels).map(([id,label]) => <option key={id} value={id}>{label}</option>)}</datalist><div className="dash-form-actions"><Button onClick={() => void copyLink(taggedPath)}><Copy size={14} />Copiar enlace</Button><a className="dash-button" href={taggedPath} target="_blank" rel="noreferrer"><ExternalLink size={14} />Abrir formulario</a></div></section>
        </div>
        <section className="dash-panel dash-padded dash-form"><div className="dash-config-title"><h3>Campos personalizados</h3><Button onClick={() => change('fields', [...settings.fields, {id: `new-${crypto.randomUUID()}`, label: '', type: 'text', required: false}])}><Plus size={14} />Añadir campo</Button></div>
          <div className="dash-setting-list">
            {settings.fields.map((field, index) => <div className="dash-config-row" key={field.id}>
              <div className="dash-config-title"><b>{field.label || 'Campo nuevo'}</b><OrderButtons index={index} total={settings.fields.length} move={(offset) => change('fields', moved(settings.fields, index, offset))} remove={() => change('fields', settings.fields.filter((entry) => entry.id !== field.id))} /></div>
              <div className="dash-form-grid"><Field label="Etiqueta"><input className="dash-input" value={field.label} onChange={(event) => changeField(field.id, {label: event.target.value})} required maxLength={160} /></Field>
                <Field label="Tipo"><select className="dash-select" value={field.type} onChange={(event) => changeField(field.id, {type: event.target.value as DashboardField['type']})}>{Object.entries(fieldTypes).map(([id,label]) => <option key={id} value={id}>{label}</option>)}</select></Field></div>
              {field.type === 'select' && <Field label="Opciones" help="Una por línea."><textarea className="dash-textarea" required value={fieldOptions[field.id] ?? ''} onChange={(event) => {setFieldOptions((current) => ({...current, [field.id]: event.target.value})); setDirty(true);}} /></Field>}
              <label className="dash-check"><input type="checkbox" checked={field.required} onChange={(event) => changeField(field.id, {required: event.target.checked})} />Obligatorio</label>
            </div>)}
          </div>
        </section>
      </>}
      {/* Los estados tienen nombre y color propios, y su tipo orienta el flujo y las automatizaciones. */}
      {tab === 'workflow' && <section className="dash-panel dash-padded dash-form">
        <div className="dash-config-title"><h3>Estados de la solicitud</h3><Button onClick={() => change('statuses', [...settings.statuses, {id: `new-${crypto.randomUUID()}`, label: '', color: '#6747d8', kind: 'open'}])}><Plus size={14} />Añadir estado</Button></div>
        <small className="dash-muted">El tipo conecta los estados con el cierre y las automatizaciones.</small>
        <div className="dash-setting-list">{settings.statuses.map((status, index) => <div className="dash-config-row" key={status.id}>
          <div className="dash-config-title"><StatusBadge status={status} /><OrderButtons index={index} total={settings.statuses.length} move={(offset) => change('statuses', moved(settings.statuses, index, offset))} remove={() => change('statuses', settings.statuses.filter((entry) => entry.id !== status.id))} /></div>
          <div className="dash-form-grid three"><Field label="Nombre"><input className="dash-input" value={status.label} onChange={(event) => changeStatus(status.id, {label: event.target.value})} required maxLength={100} /></Field>
          <Field label="Tipo"><select className="dash-select" value={status.kind} onChange={(event) => changeStatus(status.id, {kind: event.target.value as DashboardStatus['kind']})}>{Object.entries(statusKinds).map(([id,label]) => <option key={id} value={id}>{label}</option>)}</select></Field>
          <Field label="Color"><input className="dash-color-input" type="color" value={status.color} onChange={(event) => changeStatus(status.id, {color: event.target.value})} /></Field></div>
        </div>)}</div>
      </section>}
      {/* Cada regla permite editar los parámetros disponibles y el texto de los mensajes que genera. */}
      {tab === 'rules' && <section className="dash-panel dash-padded dash-form">
        <div className="dash-config-title"><h3>Reglas y plantillas</h3><span className="dash-badge neutral">{data.mailMode === 'live' ? 'Correo real' : 'Correo simulado'}</span></div>
        <small className="dash-muted">Las variables entre llaves se rellenan con datos de la solicitud.</small>
        <div className="dash-setting-list">{(Object.keys(ruleLabels) as RuleKey[]).map((rule) => <div key={rule} className="dash-config-row">
          <div className="dash-config-title"><b>{ruleLabels[rule]}</b><label className="dash-check"><input type="checkbox" checked={settings.rules[rule].enabled} onChange={(event) => changeRule(rule, {enabled: event.target.checked})} />Activa</label></div>
          {rule in ruleDelays && <Field label={ruleDelays[rule as keyof typeof ruleDelays]}><input className="dash-input" type="number" min={1} max={rule === 'quoteFollowup' ? 365 : 43200} value={settings.rules[rule].delay ?? ''} onChange={(event) => changeRule(rule, {delay: event.target.value ? Number(event.target.value) : undefined})} /></Field>}
          {rule === 'quoteFollowup' && <label className="dash-check"><input type="checkbox" checked={settings.rules[rule].automatic ?? false} onChange={(event) => changeRule(rule, {automatic: event.target.checked})} />Enviar automáticamente al cliente</label>}
          <Field label="Plantilla de mensaje"><textarea className="dash-textarea" maxLength={4000} value={settings.rules[rule].template} onChange={(event) => changeRule(rule, {template: event.target.value})} /></Field>
        </div>)}</div>
      </section>}
      <div className="dash-setting-submit"><Button className="primary" type="submit" disabled={pending || !dirty}><Check size={15} />Guardar configuración</Button></div>
    </form>}
    {/* La gestión de equipo usa un envío propio y queda fuera del borrador de configuración. */}
    {tab === 'team' && <div className="dash-settings-grid">
      <section className="dash-panel dash-padded dash-form"><h3>Miembros</h3><div className="dash-setting-list">{data.members.map((member) => <div key={member.id} className="dash-config-row"><div className="dash-config-title"><b>{member.name}</b><span className="dash-badge neutral">{member.role === 'admin' ? 'Administrador' : 'Empleado'}</span></div><small className="dash-muted">{member.email}</small></div>)}</div></section>
      <section className="dash-panel dash-padded"><form className="dash-form" onSubmit={invite}><h3>Dar acceso</h3><p className="dash-muted">La persona debe iniciar sesión con el mismo correo electrónico.</p>
        <Field label="Correo de trabajo"><input className="dash-input" name="email" type="email" required maxLength={254} /></Field>
        <Field label="Rol"><select className="dash-select" name="role" defaultValue="employee"><option value="employee">Empleado</option><option value="admin">Administrador</option></select></Field>
        <div><Button className="primary" type="submit" disabled={pending}><UsersRound size={15} />Preparar acceso</Button></div></form></section>
    </div>}
  </>;
}

// Reutiliza los controles para ordenar y quitar filas de los editores de campos y estados.
function OrderButtons({ index, total, move, remove }: {index: number; total: number; move: (offset: number) => void; remove: () => void}) {
  return <div className="dash-form-actions">
    <Button className="small" aria-label="Subir" disabled={index === 0} onClick={() => move(-1)}><ArrowUp size={14} /></Button>
    <Button className="small" aria-label="Bajar" disabled={index === total - 1} onClick={() => move(1)}><ArrowDown size={14} /></Button>
    <Button className="small danger" aria-label="Eliminar" onClick={remove}><Trash2 size={14} /></Button>
  </div>;
}
