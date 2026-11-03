/**
 * Cola de sincronizacion diferida (patron Outbox).
 *
 * 1. Toda escritura local (equipo, diagnostico, instalacion, reporte) se guarda en
 *    el almacen Y se encola como operacion con un `opId` unico (idempotencia).
 * 2. El motor intenta vaciar la cola cuando hay conectividad (NetInfo), cuando se
 *    encola algo nuevo y periodicamente.
 * 3. Errores de red/5xx -> reintento con backoff exponencial + jitter (max 60 s).
 * 4. Respuesta por operacion: applied/duplicate -> se quita de la cola;
 *    conflict -> gana el servidor (LWW por updatedAt) y se adopta su version;
 *    rejected -> queda como "failed" para revision manual (no se reintenta).
 */
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { agent, AgentError, type SyncResult } from './agent';
import { getState, setState, uuid } from './store';
import type { Device, Diagnostic, Installation, OutboxOp, SyncEntity, SyncLogEntry } from './types';

const BATCH_SIZE = 10;
const BASE_DELAY = 2000;
const MAX_DELAY = 60000;

export function backoffDelay(attempts: number) {
  const exp = Math.min(MAX_DELAY, BASE_DELAY * 2 ** Math.max(0, attempts - 1));
  return Math.round(exp * (0.8 + Math.random() * 0.4));
}

// ---------------------------------------------------------------------------
// Encolado (con compactacion)
// ---------------------------------------------------------------------------

export function enqueue(entity: SyncEntity, entityId: string, payload: Record<string, unknown> | null, action: 'upsert' | 'delete' = 'upsert') {
  const now = Date.now();
  const json = payload ? JSON.stringify(payload) : '';
  const op: OutboxOp = {
    opId: uuid(),
    entity,
    entityId,
    action,
    payload,
    updatedAt: (payload?.updatedAt as number) ?? now,
    createdAt: now,
    attempts: 0,
    status: 'pending',
    nextAttemptAt: now,
    lastError: null,
    bytes: json.length,
  };
  setState((s) => ({
    // Compactacion: si ya hay una operacion pendiente (no en vuelo) para la misma
    // entidad, se reemplaza por la nueva: solo importa el ultimo estado.
    outbox: [...s.outbox.filter((o) => !(o.entity === entity && o.entityId === entityId && o.status !== 'syncing')), op],
  }));
  queueMicrotask(() => void flush('enqueue'));
}

// ---------------------------------------------------------------------------
// Repositorios: escriben local + encolan
// ---------------------------------------------------------------------------

export function saveDevices(list: Device[]) {
  setState((s) => {
    const devices = { ...s.devices };
    for (const d of list) devices[d.id] = d;
    return { devices };
  });
  for (const d of list) enqueue('device', d.id, d as unknown as Record<string, unknown>);
}

export function updateDevice(id: string, patch: Partial<Device>) {
  const cur = getState().devices[id];
  if (!cur) return;
  saveDevices([{ ...cur, ...patch, updatedAt: Date.now() }]);
}

export function addDiagnostic(d: Omit<Diagnostic, 'id' | 'createdAt' | 'updatedAt'>): Diagnostic {
  const now = Date.now();
  const diag: Diagnostic = { ...d, id: uuid(), createdAt: now, updatedAt: now };
  setState((s) => ({ diagnostics: { ...s.diagnostics, [diag.id]: diag } }));
  enqueue('diagnostic', diag.id, diag as unknown as Record<string, unknown>);
  return diag;
}

export function saveInstallation(inst: Installation) {
  const next = { ...inst, updatedAt: Date.now() };
  setState((s) => ({ installations: { ...s.installations, [next.id]: next } }));
  enqueue('installation', next.id, next as unknown as Record<string, unknown>);
  return next;
}

export function deleteInstallation(id: string) {
  setState((s) => {
    const installations = { ...s.installations };
    delete installations[id];
    return { installations };
  });
  enqueue('installation', id, null, 'delete');
}

export function recordReport(inst: Installation) {
  const now = Date.now();
  enqueue('report', `${inst.id}:${now}`, {
    installationId: inst.id,
    siteName: inst.siteName,
    generatedAt: now,
    technician: inst.technician,
    photoCount: inst.photos.length,
    deviceCount: inst.deviceIds.length,
    hasGps: !!inst.location,
    updatedAt: now,
  });
}

// ---------------------------------------------------------------------------
// Motor de sincronizacion
// ---------------------------------------------------------------------------

let netState: NetInfoState | null = null;
let flushing = false;
let started = false;
const statusListeners = new Set<() => void>();

export interface SyncStatus {
  networkConnected: boolean | null;
  networkType: string;
  forcedOffline: boolean;
  canSync: boolean;
  flushing: boolean;
  backendReachable: boolean | null;
  lastError: string | null;
}

let status: SyncStatus = {
  networkConnected: null,
  networkType: 'unknown',
  forcedOffline: false,
  canSync: false,
  flushing: false,
  backendReachable: null,
  lastError: null,
};

function updateStatus(patch: Partial<SyncStatus>) {
  status = { ...status, ...patch };
  status.forcedOffline = getState().settings.forceOffline;
  status.canSync = status.networkConnected !== false && !status.forcedOffline;
  statusListeners.forEach((l) => l());
}

export const getSyncStatus = () => status;
export function subscribeSyncStatus(l: () => void) {
  statusListeners.add(l);
  return () => statusListeners.delete(l);
}

function log(entries: SyncLogEntry[]) {
  setState((s) => ({ syncLog: [...entries, ...s.syncLog].slice(0, 100) }));
}

/** Adopta la version del servidor tras un conflicto (gana el servidor). */
function adoptServerVersion(entity: SyncEntity, id: string, data: Record<string, unknown> | null) {
  if (!data) return;
  if (entity === 'installation') {
    setState((s) => ({ installations: { ...s.installations, [id]: data as unknown as Installation } }));
  } else if (entity === 'device') {
    setState((s) => ({ devices: { ...s.devices, [id]: data as unknown as Device } }));
  } else if (entity === 'diagnostic') {
    setState((s) => ({ diagnostics: { ...s.diagnostics, [id]: data as unknown as Diagnostic } }));
  }
}

export async function flush(reason: string = 'manual'): Promise<void> {
  updateStatus({});
  if (flushing || !status.canSync) return;
  const now = Date.now();
  const due = getState()
    .outbox.filter((o) => o.status !== 'failed' && o.status !== 'syncing' && (o.nextAttemptAt <= now || reason === 'manual' || reason === 'reconnect'))
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, BATCH_SIZE);
  if (due.length === 0) return;

  flushing = true;
  updateStatus({ flushing: true });
  const ids = new Set(due.map((o) => o.opId));
  setState((s) => ({ outbox: s.outbox.map((o) => (ids.has(o.opId) ? { ...o, status: 'syncing' } : o)) }));

  try {
    const { results } = await agent.syncPush(
      due.map((o) => ({ opId: o.opId, entity: o.entity, entityId: o.entityId, action: o.action, payload: o.payload, updatedAt: o.updatedAt })),
    );
    const byId = new Map<string, SyncResult>(results.map((r) => [r.opId, r]));
    const entries: SyncLogEntry[] = [];
    const done = new Set<string>();
    const failed = new Map<string, string>();
    for (const op of due) {
      const r = byId.get(op.opId);
      if (!r) continue;
      const base = { at: Date.now(), opId: op.opId, entity: op.entity, entityId: op.entityId };
      if (r.status === 'applied' || r.status === 'duplicate') {
        done.add(op.opId);
        entries.push({ ...base, result: r.status });
      } else if (r.status === 'conflict') {
        done.add(op.opId);
        adoptServerVersion(op.entity, op.entityId, r.server.data);
        entries.push({ ...base, result: 'conflict', detail: 'El servidor tenia una version mas nueva: se adopto la del servidor' });
      } else {
        failed.set(op.opId, r.error);
        entries.push({ ...base, result: 'rejected', detail: r.error });
      }
    }
    setState((s) => ({
      outbox: s.outbox
        .filter((o) => !done.has(o.opId))
        .map((o) =>
          failed.has(o.opId)
            ? { ...o, status: 'failed', lastError: failed.get(o.opId)!, attempts: o.attempts + 1 }
            : ids.has(o.opId) && o.status === 'syncing'
              ? { ...o, status: 'pending' }
              : o,
        ),
      lastSyncAt: Date.now(),
    }));
    log(entries);
    updateStatus({ backendReachable: true, lastError: null });
  } catch (e) {
    const err = e as AgentError;
    const msg = err.message;
    setState((s) => ({
      outbox: s.outbox.map((o) => {
        if (!ids.has(o.opId)) return o;
        const attempts = o.attempts + 1;
        return { ...o, status: 'retrying', attempts, lastError: msg, nextAttemptAt: Date.now() + backoffDelay(attempts) };
      }),
    }));
    log(due.slice(0, 1).map((o) => ({ at: Date.now(), opId: o.opId, entity: o.entity, entityId: o.entityId, result: 'error' as const, detail: `${msg} (${due.length} op. reprogramadas)` })));
    updateStatus({ backendReachable: err.status === 0 ? false : status.backendReachable, lastError: msg });
  } finally {
    flushing = false;
    updateStatus({ flushing: false });
  }
  // Si quedan operaciones vencidas, seguir vaciando
  if (getState().outbox.some((o) => o.status === 'pending' && o.nextAttemptAt <= Date.now())) {
    setTimeout(() => void flush('drain'), 50);
  }
}

export function setForceOffline(value: boolean) {
  setState((s) => ({ settings: { ...s.settings, forceOffline: value } }));
  updateStatus({});
  if (!value) void flush('reconnect');
}

export function retryOp(opId: string) {
  setState((s) => ({ outbox: s.outbox.map((o) => (o.opId === opId ? { ...o, status: 'pending', nextAttemptAt: Date.now() } : o)) }));
  void flush('manual');
}

export function discardOp(opId: string) {
  setState((s) => ({ outbox: s.outbox.filter((o) => o.opId !== opId) }));
}

export function startSyncEngine() {
  if (started) return;
  started = true;
  updateStatus({});
  NetInfo.addEventListener((s) => {
    const wasOffline = netState?.isConnected === false;
    netState = s;
    updateStatus({ networkConnected: s.isConnected, networkType: s.type });
    if (s.isConnected && wasOffline) void flush('reconnect'); // reconexion: reintento inmediato
  });
  setInterval(() => void flush('timer'), 3000);
  void flush('startup');
}
