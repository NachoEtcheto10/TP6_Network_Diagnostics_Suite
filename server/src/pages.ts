/** Paginas HTML del agente: panel del backend y hoja de etiquetas QR. */
import type { SyncStore } from './sync/store.ts';

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const time = (ms: number) => new Date(ms).toLocaleString('es-AR');

const STYLE = `
  body{font-family:system-ui,Segoe UI,Roboto,sans-serif;margin:0;background:#0f172a;color:#e2e8f0}
  header{padding:16px 24px;background:#111c33;border-bottom:1px solid #1e293b;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
  h1{font-size:18px;margin:0} h2{font-size:15px;margin:24px 0 8px;color:#93c5fd}
  main{padding:8px 24px 40px} .muted{color:#94a3b8;font-size:12px}
  table{border-collapse:collapse;width:100%;font-size:13px} td,th{padding:6px 8px;border-bottom:1px solid #1e293b;text-align:left;vertical-align:top}
  .pill{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;background:#1e293b}
  .applied{background:#14532d;color:#bbf7d0}.conflict,.edited-backoffice{background:#78350f;color:#fde68a}
  .card{background:#111c33;border:1px solid #1e293b;border-radius:10px;padding:12px;margin:8px 0;display:flex;gap:12px}
  .card img{width:96px;height:72px;object-fit:cover;border-radius:6px}
  form{display:inline} button{background:#2563eb;color:white;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;font-size:12px}
  button.danger{background:#b91c1c} button.warn{background:#b45309} code{color:#fcd34d}
`;

export function renderDashboard(
  store: SyncStore,
  chaos: { failRate: number },
  sim: { snmpPort: number; sshPort: number; user: string; pass: string },
): string {
  const inst = store.list('installation');
  const diags = store.list('diagnostic');
  const devices = store.list('device');
  const reports = store.list('report');
  const log = store.recentLog.slice(0, 25);

  const installations = inst
    .map((r) => {
      const d = (r.data ?? {}) as Record<string, any>;
      const photo = Array.isArray(d.photos) && d.photos[0]?.dataUri ? `<img src="${esc(d.photos[0].dataUri)}">` : '';
      const gps = d.location ? `${Number(d.location.latitude).toFixed(5)}, ${Number(d.location.longitude).toFixed(5)}` : 'sin GPS';
      return `<div class="card">${photo}<div>
        <b>${esc(d.siteName)}</b> <span class="muted">${esc(d.client)}</span><br>
        <span class="muted">Tecnico: ${esc(d.technician)} · GPS: ${esc(gps)} · Fotos: ${Array.isArray(d.photos) ? d.photos.length : 0} · v${r.serverVersion}</span><br>
        <span class="muted">Notas: ${esc(d.notes)}</span><br>
        <span class="muted">Recibido ${time(r.receivedAt)}</span>
        <form method="post" action="/admin/backoffice-edit"><input type="hidden" name="id" value="${esc(r.id)}">
        <button class="warn" title="Simula que la oficina edita el registro: la proxima edicion offline del tecnico generara un conflicto">Editar desde oficina</button></form>
      </div></div>`;
    })
    .join('');

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta http-equiv="refresh" content="3">
  <title>NDS Backend</title><style>${STYLE}</style></head><body>
  <header><h1>Network Diagnostics Suite — Backend de sincronización</h1>
    <span class="pill">Instalaciones ${inst.length}</span><span class="pill">Diagnósticos ${diags.length}</span>
    <span class="pill">Equipos ${devices.length}</span><span class="pill">Reportes ${reports.length}</span>
    <span class="muted">Se actualiza cada 3 s</span></header>
  <main>
    <p class="muted">Simuladores de laboratorio: SNMP <code>UDP/${sim.snmpPort}</code> community <code>public</code> ·
      SSH <code>TCP/${sim.sshPort}</code> usuario <code>${esc(sim.user)}</code> / <code>${esc(sim.pass)}</code> ·
      <a style="color:#93c5fd" href="/qr" target="_blank">Etiquetas QR de prueba</a></p>
    <p>Modo caos (fallas simuladas del backend): <b>${Math.round(chaos.failRate * 100)}%</b>
      <form method="post" action="/admin/chaos"><input type="hidden" name="failRate" value="0"><button>0%</button></form>
      <form method="post" action="/admin/chaos"><input type="hidden" name="failRate" value="0.5"><button class="warn">50%</button></form>
      <form method="post" action="/admin/chaos"><input type="hidden" name="failRate" value="1"><button class="danger">100%</button></form>
      &nbsp; <form method="post" action="/admin/reset" onsubmit="return confirm('¿Borrar todos los datos del backend?')"><button class="danger">Vaciar backend</button></form></p>
    <h2>Instalaciones sincronizadas</h2>${installations || '<p class="muted">Todavía no llegó ninguna.</p>'}
    <h2>Últimas operaciones recibidas (outbox)</h2>
    <table><tr><th>Hora</th><th>Entidad</th><th>ID</th><th>Resultado</th><th>opId</th></tr>
    ${log.map((l) => `<tr><td>${time(l.at)}</td><td>${esc(l.entity)}</td><td>${esc(l.entityId).slice(0, 8)}</td><td><span class="pill ${esc(l.status)}">${esc(l.status)}</span></td><td class="muted">${esc(l.opId).slice(0, 8)}</td></tr>`).join('')}
    </table>
    <h2>Diagnósticos</h2>
    <table><tr><th>Recibido</th><th>Tipo</th><th>Equipo</th><th>Resumen</th></tr>
    ${diags
      .slice(0, 20)
      .map((r) => {
        const d = (r.data ?? {}) as Record<string, any>;
        return `<tr><td>${time(r.receivedAt)}</td><td>${esc(d.kind)}</td><td>${esc(d.host)}</td><td>${esc(d.summary)}</td></tr>`;
      })
      .join('')}
    </table>
  </main></body></html>`;
}

export function renderQrSheet(fichas: Record<string, unknown>[], svgs: string[]): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Etiquetas QR — NDS</title>
  <style>body{font-family:system-ui,sans-serif;display:flex;flex-wrap:wrap;gap:16px;padding:24px}
  .tag{border:2px dashed #555;border-radius:12px;padding:12px;text-align:center;width:200px}
  .tag svg{width:180px;height:180px}.code{font-family:monospace;font-weight:bold}</style></head><body>
  ${fichas
    .map(
      (f, i) => `<div class="tag">${svgs[i]}<div class="code">${esc(f.code)}</div><div>${esc(f.tipo)}</div><small>${esc(f.modelo)}</small></div>`,
    )
    .join('')}
  </body></html>`;
}
