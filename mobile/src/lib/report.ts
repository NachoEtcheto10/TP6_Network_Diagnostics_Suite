/**
 * Capa de reporting: arma el HTML del reporte de instalacion y lo convierte a PDF.
 *  - Android/iOS: expo-print genera el archivo PDF y expo-sharing lo comparte.
 *  - Web: se abre el dialogo de impresion del navegador sobre el HTML del
 *    reporte; elegir "Guardar como PDF" produce el archivo.
 */
import { Platform } from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { escapeHtml as e, fmtBps, fmtDate } from './format';
import { formatCoords, mapsUrl } from './evidence';
import type { Device, Diagnostic, Installation } from './types';
import type { SnmpInterfacesResult, SnmpSystemResult, SshResult } from './agent';

function diagnosticRows(diags: Diagnostic[]) {
  return diags
    .map((d) => {
      let detail = '';
      if (d.kind === 'snmp-system' && d.ok) {
        const s = (d.data as SnmpSystemResult).system;
        detail = `sysName: <b>${e(s.sysName)}</b><br>Uptime: ${e(s.sysUpTimeText)}<br>${e(s.sysDescr)}`;
      } else if (d.kind === 'snmp-interfaces' && d.ok) {
        const r = d.data as SnmpInterfacesResult;
        detail = r.interfaces
          .map((i) => `${e(i.descr)} [${e(i.operStatus)}] ↓${fmtBps(i.inBps)} ↑${fmtBps(i.outBps)}`)
          .join('<br>');
      } else if (d.kind === 'ssh' && d.ok) {
        const r = d.data as SshResult;
        detail = `<code>$ ${e(r.command)}</code><pre>${e(r.stdout.slice(0, 1200))}</pre>`;
      } else {
        detail = e(d.summary);
      }
      return `<tr><td>${fmtDate(d.createdAt)}</td><td>${e(d.kind)}</td><td>${e(d.host)}</td><td class="${d.ok ? 'ok' : 'err'}">${d.ok ? 'OK' : 'Error'}</td><td>${detail}</td></tr>`;
    })
    .join('');
}

export function buildReportHtml(inst: Installation, devices: Device[], diags: Diagnostic[]): string {
  const photos = inst.photos
    .map(
      (p, i) => `<figure><img src="${p.dataUri}"><figcaption>Foto ${i + 1} · ${fmtDate(p.takenAt)}<br>GPS: ${e(formatCoords(p.location))}</figcaption></figure>`,
    )
    .join('');
  const ficha = inst.ficha
    ? `<table class="kv">${Object.entries(inst.ficha)
        .filter(([, v]) => typeof v !== 'object')
        .map(([k, v]) => `<tr><th>${e(k)}</th><td>${e(v)}</td></tr>`)
        .join('')}</table>`
    : '<p class="muted">Sin ficha técnica asociada.</p>';

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Reporte ${e(inst.siteName)}</title>
<style>
  @page { margin: 14mm; }
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; color:#0f172a; font-size: 11px; }
  h1 { font-size: 20px; margin: 0 } h2 { font-size: 13px; border-bottom: 2px solid #2563eb; padding-bottom: 3px; margin-top: 18px; color:#1e3a8a }
  .head { display:flex; justify-content:space-between; align-items:flex-end; border-bottom: 3px solid #0f172a; padding-bottom: 8px }
  .muted { color:#64748b } table { width:100%; border-collapse: collapse } td, th { border-bottom: 1px solid #e2e8f0; padding: 4px 6px; text-align:left; vertical-align: top }
  table.kv th { width: 30%; color:#475569; font-weight:600 } pre { white-space: pre-wrap; font-size: 9px; background:#f1f5f9; padding:4px; margin:2px 0 }
  .ok { color:#15803d; font-weight:bold } .err { color:#b91c1c; font-weight:bold }
  .photos { display:flex; flex-wrap:wrap; gap:8px } figure { margin:0; width: 48%; page-break-inside: avoid }
  figure img { width:100%; border-radius:4px; border:1px solid #cbd5e1 } figcaption { font-size: 9px; color:#475569 }
  .sign { margin-top: 40px; display:flex; gap: 40px } .sign div { flex:1; border-top:1px solid #0f172a; text-align:center; padding-top:4px }
</style></head><body>
<div class="head"><div><h1>Reporte de instalación</h1><div class="muted">Network Diagnostics Suite · ID ${e(inst.id.slice(0, 8))}</div></div>
<div style="text-align:right">Generado: ${fmtDate(Date.now())}<br>Técnico: <b>${e(inst.technician || '—')}</b></div></div>

<h2>Sitio</h2>
<table class="kv">
<tr><th>Sitio</th><td>${e(inst.siteName)}</td></tr>
<tr><th>Cliente</th><td>${e(inst.client)}</td></tr>
<tr><th>Dirección</th><td>${e(inst.address)}</td></tr>
<tr><th>Ubicación GPS</th><td>${e(formatCoords(inst.location))}${inst.location ? ` · <a href="${mapsUrl(inst.location)}">ver mapa</a>` : ''}</td></tr>
<tr><th>Registrado</th><td>${fmtDate(inst.createdAt)} (última edición ${fmtDate(inst.updatedAt)})</td></tr>
<tr><th>Código de equipo (QR)</th><td>${e(inst.equipmentCode ?? '—')}</td></tr>
</table>

<h2>Ficha técnica del equipo</h2>${ficha}

<h2>Equipos relevados en la red (${devices.length})</h2>
${
  devices.length
    ? `<table><tr><th>IP</th><th>MAC</th><th>Hostname</th><th>Fabricante</th><th>Puertos</th></tr>${devices
        .map(
          (d) =>
            `<tr><td>${e(d.ip)}${d.isGateway ? ' (gateway)' : ''}</td><td>${e(d.mac)}</td><td>${e(d.hostname)}</td><td>${e(d.vendor)}</td><td>${e(d.openPorts.map((p) => p.port).join(', '))}</td></tr>`,
        )
        .join('')}</table>`
    : '<p class="muted">No se asociaron equipos.</p>'
}

<h2>Diagnósticos (${diags.length})</h2>
${diags.length ? `<table><tr><th>Fecha</th><th>Tipo</th><th>Host</th><th>Estado</th><th>Detalle</th></tr>${diagnosticRows(diags)}</table>` : '<p class="muted">Sin diagnósticos asociados.</p>'}

<h2>Notas técnicas</h2><p>${e(inst.notes || '—').replace(/\n/g, '<br>')}</p>

<h2>Evidencia fotográfica (${inst.photos.length})</h2>
<div class="photos">${photos || '<p class="muted">Sin fotos.</p>'}</div>

<div class="sign"><div>Firma técnico</div><div>Firma cliente</div></div>
</body></html>`;
}

/** Genera el PDF. Devuelve la URI del archivo en mobile, o null en web (dialogo de impresion). */
export async function exportPdf(html: string, fileName: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow!.document;
    doc.open();
    doc.write(html);
    doc.close();
    const prevTitle = document.title;
    document.title = fileName; // nombre sugerido del PDF en Chrome/Edge
    await new Promise<void>((resolve) => {
      const imgs = Array.from(doc.images);
      let pending = imgs.length;
      if (!pending) return resolve();
      imgs.forEach((img) => {
        if (img.complete) {
          if (--pending === 0) resolve();
        } else {
          img.onload = img.onerror = () => {
            if (--pending === 0) resolve();
          };
        }
      });
      setTimeout(resolve, 3000);
    });
    iframe.contentWindow!.focus();
    iframe.contentWindow!.print();
    setTimeout(() => {
      document.title = prevTitle;
      iframe.remove();
    }, 1000);
    return null;
  }
  const { uri } = await Print.printToFileAsync({ html });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: fileName, UTI: 'com.adobe.pdf' });
  }
  return uri;
}
