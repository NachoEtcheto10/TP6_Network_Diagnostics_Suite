/**
 * Almacen local offline-first.
 *
 * Todo el estado vive en memoria y se persiste por "colecciones" en
 * AsyncStorage (localStorage en web, SQLite/archivos en Android/iOS).
 * Las pantallas leen SIEMPRE de aqui, nunca de la red: la red solo alimenta
 * el almacen (scan, SNMP, SSH) y la outbox lo replica al backend cuando hay
 * conectividad. Ver docs/DOCUMENTO_TECNICO.md (seccion Offline-first).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { randomUUID } from 'expo-crypto';
import type { Device, Diagnostic, Installation, OutboxOp, ScanMeta, Settings, SyncLogEntry } from './types';

export interface State {
  ready: boolean;
  settings: Settings;
  devices: Record<string, Device>;
  diagnostics: Record<string, Diagnostic>;
  installations: Record<string, Installation>;
  outbox: OutboxOp[];
  syncLog: SyncLogEntry[];
  knownHosts: Record<string, string>; // host:port -> huella SSH (TOFU)
  lastScan: ScanMeta | null;
  lastSyncAt: number | null;
}

type PersistedKey = Exclude<keyof State, 'ready'>;
const PERSISTED: PersistedKey[] = [
  'settings',
  'devices',
  'diagnostics',
  'installations',
  'outbox',
  'syncLog',
  'knownHosts',
  'lastScan',
  'lastSyncAt',
];
const PREFIX = 'nds:v1:';

/** URL por defecto del agente: misma maquina que sirve la app, puerto 4000. */
export function defaultAgentUrl(): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return `${window.location.protocol === 'https:' ? 'https' : 'http'}://${window.location.hostname}:4000`;
  }
  const hostUri = Constants.expoConfig?.hostUri; // ej. 192.168.0.16:8081 en desarrollo
  const host = hostUri?.split(':')[0];
  return `http://${host || '192.168.0.16'}:4000`;
}

let state: State = {
  ready: false,
  settings: { agentUrl: defaultAgentUrl(), technician: '', forceOffline: false, clientId: randomUUID() },
  devices: {},
  diagnostics: {},
  installations: {},
  outbox: [],
  syncLog: [],
  knownHosts: {},
  lastScan: null,
  lastSyncAt: null,
};

const listeners = new Set<() => void>();
const dirty = new Set<PersistedKey>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

export const getState = () => state;

export function setState(updater: (s: State) => Partial<State>) {
  const patch = updater(state);
  const next = { ...state, ...patch };
  for (const k of Object.keys(patch) as (keyof State)[]) {
    if (k !== 'ready' && patch[k] !== state[k]) dirty.add(k);
  }
  state = next;
  listeners.forEach((l) => l());
  // La outbox se persiste sin demora: es la garantia de no perder operaciones
  if ('outbox' in patch) void flushPersist().catch(() => {});
  else schedulePersist();
}

function schedulePersist() {
  if (persistTimer || dirty.size === 0) return;
  persistTimer = setTimeout(() => void flushPersist().catch(() => {}), 150);
}

// En web: guardar lo pendiente si la pestana se oculta o se cierra
if (Platform.OS === 'web' && typeof window !== 'undefined') {
  const save = () => void flushPersist().catch(() => {});
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && save());
}

export async function flushPersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  const keys = [...dirty];
  dirty.clear();
  try {
    await AsyncStorage.multiSet(keys.map((k) => [PREFIX + k, JSON.stringify(state[k])]));
  } catch (e) {
    // En web localStorage tiene ~5-10 MB: avisar si las fotos lo llenan
    console.warn('No se pudo persistir el estado local', e);
    keys.forEach((k) => dirty.add(k));
    throw e;
  }
}

export async function loadState() {
  const pairs = await AsyncStorage.multiGet(PERSISTED.map((k) => PREFIX + k));
  const loaded: Partial<State> = {};
  for (const [key, value] of pairs) {
    if (value == null) continue;
    try {
      (loaded as Record<string, unknown>)[key.slice(PREFIX.length)] = JSON.parse(value);
    } catch {
      /* coleccion corrupta: se ignora */
    }
  }
  // Operaciones que quedaron "en vuelo" si la app se cerro a mitad de un envio
  const outbox = (loaded.outbox ?? []).map((op) => (op.status === 'syncing' ? { ...op, status: 'retrying' as const } : op));
  state = {
    ...state,
    ...loaded,
    outbox,
    settings: { ...state.settings, ...(loaded.settings ?? {}) },
    ready: true,
  };
  listeners.forEach((l) => l());
}

export function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Hook: el selector debe devolver una referencia estable (una coleccion), no un objeto nuevo. */
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

export async function clearLocalData() {
  await AsyncStorage.multiRemove(PERSISTED.map((k) => PREFIX + k));
  const settings = state.settings;
  state = {
    ...state,
    devices: {},
    diagnostics: {},
    installations: {},
    outbox: [],
    syncLog: [],
    knownHosts: {},
    lastScan: null,
    lastSyncAt: null,
    settings,
  };
  dirty.add('settings');
  listeners.forEach((l) => l());
  schedulePersist();
}

export const uuid = () => randomUUID();
