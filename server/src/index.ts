/**
 * NDS Agent: agente de red local + backend de sincronizacion.
 *
 * Por que existe: un navegador (y Expo Go) no puede abrir sockets UDP/TCP crudos.
 * Este proceso Node corre en la misma LAN y expone por HTTP las operaciones de
 * bajo nivel (barrido de subred, SNMP sobre UDP/161, SSH) que la app invoca.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { listInterfaces, scanNetwork } from './discovery/scan.ts';
import { querySystem, queryInterfaces, snmpGet, SnmpError, type SnmpTarget } from './snmp/client.ts';
import { oidName } from './snmp/mib.ts';
import { startSnmpSimulator } from './snmp/simulator.ts';
import { runDiagnostic } from './ssh/client.ts';
import { VENDORS } from './ssh/commands.ts';
import { startSshSimulator } from './ssh/simulator.ts';
import { ENTITIES, SyncStore, type Entity, type SyncOp } from './sync/store.ts';
import { renderDashboard, renderQrSheet } from './pages.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 4000);
const SNMP_SIM_PORT = Number(process.env.SNMP_SIM_PORT ?? 1161);
const SSH_SIM_PORT = Number(process.env.SSH_SIM_PORT ?? 2222);
const SIM_USER = process.env.SSH_SIM_USER ?? 'tecnico';
const SIM_PASS = process.env.SSH_SIM_PASS ?? 'nds2026';
const MAX_BODY = 25 * 1024 * 1024;

const store = new SyncStore(path.join(ROOT, 'data'));
const fichas: Record<string, unknown>[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'fichas.json'), 'utf8'));
const chaos = { failRate: 0 };
const sims = { snmp: false, ssh: false };

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Client-Id',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Cuerpo demasiado grande');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  const ctype = req.headers['content-type'] ?? '';
  if (ctype.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'JSON invalido');
  }
}

function snmpTarget(b: Record<string, any>): SnmpTarget {
  if (!b.host || typeof b.host !== 'string') throw new HttpError(400, 'Falta host');
  return {
    host: b.host.trim(),
    port: b.port ? Number(b.port) : 161,
    community: b.community || 'public',
    version: b.version === 'v1' ? 'v1' : 'v2c',
    timeoutMs: Math.min(Number(b.timeoutMs) || 2000, 10000),
    retries: Math.min(Number(b.retries ?? 1), 3),
  };
}

type Handler = (req: http.IncomingMessage, url: URL) => Promise<unknown>;
const routes: Record<string, Handler> = {
  'GET /api/health': async () => ({
    ok: true,
    name: 'nds-agent',
    time: Date.now(),
    platform: process.platform,
    lanAddress: listInterfaces()[0]?.address ?? '127.0.0.1',
    simulators: {
      snmp: sims.snmp ? { port: SNMP_SIM_PORT, community: 'public' } : null,
      ssh: sims.ssh ? { port: SSH_SIM_PORT, username: SIM_USER } : null,
    },
    chaos,
  }),

  'GET /api/network/interfaces': async () => listInterfaces(),

  'POST /api/discovery/scan': async (req) => {
    const b = await readJson(req);
    const result = await scanNetwork({ iface: b.iface });
    if (sims.snmp || sims.ssh) {
      const self = result.devices.find((d) => d.isSelf);
      if (self) {
        if (sims.snmp) self.services.push(`Agente SNMP simulado (UDP/${SNMP_SIM_PORT})`);
        if (sims.ssh) self.services.push(`Equipo SSH simulado (TCP/${SSH_SIM_PORT})`);
      }
    }
    return result;
  },

  'POST /api/snmp/system': async (req) => querySystem(snmpTarget(await readJson(req))),

  'POST /api/snmp/interfaces': async (req) => {
    const b = await readJson(req);
    return queryInterfaces(snmpTarget(b), Math.min(Number(b.sampleMs ?? 2000), 10000));
  },

  'POST /api/snmp/get': async (req) => {
    const b = await readJson(req);
    const oids: string[] = Array.isArray(b.oids) ? b.oids : [];
    if (oids.length === 0 || oids.length > 40) throw new HttpError(400, 'Enviar entre 1 y 40 OIDs');
    const trace: never[] = [];
    const vbs = await snmpGet(snmpTarget(b), oids, trace);
    return { varbinds: vbs.map((v) => ({ oid: v.oid, name: oidName(v.oid), ...v.value })), trace };
  },

  'GET /api/ssh/vendors': async () => VENDORS,

  'POST /api/ssh/exec': async (req) => {
    const b = await readJson(req);
    for (const k of ['host', 'username', 'password', 'vendor', 'commandId']) {
      if (!b[k]) throw new HttpError(400, `Falta ${k}`);
    }
    return runDiagnostic({
      host: String(b.host).trim(),
      port: b.port ? Number(b.port) : 22,
      username: String(b.username),
      password: String(b.password),
      vendor: String(b.vendor),
      commandId: String(b.commandId),
      expectedFingerprint: b.expectedFingerprint || undefined,
    });
  },

  'GET /api/fichas': async () => fichas,

  'POST /api/sync/push': async (req) => {
    const b = await readJson(req);
    if (chaos.failRate > 0 && Math.random() < chaos.failRate) {
      throw new HttpError(503, 'Fallo simulado del backend (modo caos)');
    }
    const ops: SyncOp[] = Array.isArray(b.ops) ? b.ops : [];
    if (ops.length > 50) throw new HttpError(400, 'Maximo 50 operaciones por lote');
    return { results: store.apply(ops.map((o) => ({ ...o, clientId: req.headers['x-client-id'] as string }))), serverTime: Date.now() };
  },

  'GET /api/sync/pull': async (_req, url) => ({ records: store.pull(Number(url.searchParams.get('since') ?? 0)), serverTime: Date.now() }),

  'GET /api/sync/records': async (_req, url) => {
    const e = url.searchParams.get('entity') as Entity | null;
    return store.list(e && ENTITIES.includes(e) ? e : undefined);
  },

  // ---- acciones del panel (demo) ----
  'POST /admin/chaos': async (req) => {
    const b = await readJson(req);
    chaos.failRate = Math.max(0, Math.min(1, Number(b.failRate) || 0));
    return { redirect: '/' };
  },
  'POST /admin/reset': async () => {
    store.reset();
    return { redirect: '/' };
  },
  'POST /admin/backoffice-edit': async (req) => {
    const b = await readJson(req);
    store.touchFromBackoffice('installation', String(b.id), {
      notes: `${b.notes ?? ''}`.trim() || 'Editado desde la oficina (prueba de conflicto)',
    });
    return { redirect: '/' };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') return send(res, 204, '');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, renderDashboard(store, chaos, { snmpPort: SNMP_SIM_PORT, sshPort: SSH_SIM_PORT, user: SIM_USER, pass: SIM_PASS }), 'text/html');
    }
    if (req.method === 'GET' && url.pathname === '/qr') {
      const svgs = await Promise.all(fichas.map((f) => QRCode.toString(String(f.code), { type: 'svg', margin: 1, width: 180 })));
      return send(res, 200, renderQrSheet(fichas, svgs), 'text/html');
    }
    const ficha = /^\/api\/fichas\/([\w-]+)$/.exec(url.pathname);
    if (req.method === 'GET' && ficha) {
      const f = fichas.find((x) => String(x.code).toUpperCase() === ficha[1].toUpperCase());
      if (!f) throw new HttpError(404, `No hay ficha tecnica para el codigo ${ficha[1]}`);
      return send(res, 200, f);
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) throw new HttpError(404, 'Ruta no encontrada');
    const result = (await handler(req, url)) as { redirect?: string };
    if (url.pathname.startsWith('/admin/') && result?.redirect) {
      res.writeHead(303, { Location: result.redirect });
      return res.end();
    }
    send(res, 200, result);
  } catch (err) {
    const e = err as Error & { status?: number; trace?: unknown };
    const status = e instanceof HttpError ? e.status : e instanceof SnmpError ? 504 : 502;
    if (!(e instanceof HttpError)) console.warn(`[${req.method} ${url.pathname}]`, e.message);
    send(res, status, { error: e.message, trace: e instanceof SnmpError ? e.trace : undefined });
  }
});

async function main() {
  if (process.env.NO_SIMULATORS !== '1') {
    try {
      await startSnmpSimulator({ port: SNMP_SIM_PORT, community: 'public' });
      sims.snmp = true;
    } catch (e) {
      console.warn(`No se pudo iniciar el agente SNMP simulado en UDP/${SNMP_SIM_PORT}:`, (e as Error).message);
    }
    try {
      await startSshSimulator({ port: SSH_SIM_PORT, username: SIM_USER, password: SIM_PASS });
      sims.ssh = true;
    } catch (e) {
      console.warn(`No se pudo iniciar el SSH simulado en TCP/${SSH_SIM_PORT}:`, (e as Error).message);
    }
  }
  server.listen(PORT, '0.0.0.0', () => {
    const lan = listInterfaces()[0];
    console.log('\n  NDS Agent (agente de red + backend de sync)');
    console.log(`  Panel:        http://localhost:${PORT}/`);
    console.log(`  QR de prueba: http://localhost:${PORT}/qr`);
    if (lan) console.log(`  En la LAN:    http://${lan.address}:${PORT}/  (${lan.name})`);
    if (sims.snmp) console.log(`  SNMP simulado: ${lan?.address ?? '127.0.0.1'} UDP/${SNMP_SIM_PORT}  community "public"`);
    if (sims.ssh) console.log(`  SSH simulado:  ${lan?.address ?? '127.0.0.1'} TCP/${SSH_SIM_PORT}  ${SIM_USER} / ${SIM_PASS}`);
    console.log('');
  });
}

main();
