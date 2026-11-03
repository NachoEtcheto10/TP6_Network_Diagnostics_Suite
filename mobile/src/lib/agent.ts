/**
 * Cliente HTTP del NDS Agent (server/). El agente es quien abre los sockets
 * UDP/TCP crudos: el navegador y Expo Go no pueden hacerlo.
 */
import { getState } from './store';

export class AgentError extends Error {
  status: number;
  trace?: PacketTrace[];
  constructor(message: string, status: number, trace?: PacketTrace[]) {
    super(message);
    this.status = status;
    this.trace = trace;
  }
}

export interface PacketTrace {
  pdu: string;
  requestId: number;
  request: string;
  response?: string;
  rttMs?: number;
}

async function call<T>(path: string, body?: unknown, timeoutMs = 15000): Promise<T> {
  const { agentUrl, clientId } = getState().settings;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(agentUrl.replace(/\/+$/, '') + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? { 'X-Client-Id': clientId } : { 'Content-Type': 'application/json', 'X-Client-Id': clientId },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    const aborted = (e as Error).name === 'AbortError';
    throw new AgentError(
      aborted ? `El agente no respondio en ${timeoutMs / 1000} s` : `No se pudo contactar al agente en ${agentUrl}`,
      0,
    );
  } finally {
    clearTimeout(timer);
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string; trace?: PacketTrace[] };
  if (!res.ok) throw new AgentError(json.error ?? `HTTP ${res.status}`, res.status, json.trace);
  return json as T;
}

// ---------------------------------------------------------------------------

export interface Health {
  ok: boolean;
  platform: string;
  lanAddress: string;
  simulators: {
    snmp: { port: number; community: string } | null;
    ssh: { port: number; username: string } | null;
  };
}

export interface LocalInterface {
  name: string;
  address: string;
  netmask: string;
  scanRange: string;
  private: boolean;
  likelyVpn: boolean;
}

export interface ScanResult {
  interface: LocalInterface;
  gateway: string | null;
  range: string;
  hostsProbed: number;
  durationMs: number;
  devices: {
    ip: string;
    mac: string | null;
    vendor: string | null;
    randomizedMac: boolean;
    hostname: string | null;
    hostnames: string[];
    openPorts: { port: number; service: string }[];
    services: string[];
    isGateway: boolean;
    isSelf: boolean;
    rttMs: number | null;
    sources: string[];
  }[];
}

export interface SnmpParams {
  host: string;
  port?: number;
  community?: string;
  version?: 'v1' | 'v2c';
}

export interface SnmpSystemResult {
  system: {
    sysDescr: string | null;
    sysObjectID: string | null;
    sysUpTime: string | null;
    sysUpTimeText: string | null;
    sysContact: string | null;
    sysName: string | null;
    sysLocation: string | null;
  };
  varbinds: { oid: string; name: string; type: string; value: string | number | null }[];
  trace: PacketTrace[];
}

export interface InterfaceStats {
  index: number;
  descr: string;
  speed: number | null;
  mac: string | null;
  adminStatus: string;
  operStatus: string;
  inOctets: number;
  outOctets: number;
  inErrors: number | null;
  outErrors: number | null;
  inBps: number | null;
  outBps: number | null;
}

export interface SnmpInterfacesResult {
  ifNumber: number | null;
  sampleMs: number;
  interfaces: InterfaceStats[];
  trace: PacketTrace[];
}

export interface Vendor {
  id: string;
  label: string;
  commands: { id: string; label: string; command: string }[];
}

export interface SshResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  fingerprint: string;
  serverBanner: string | null;
}

export const agent = {
  health: () => call<Health>('/api/health', undefined, 4000),
  interfaces: () => call<LocalInterface[]>('/api/network/interfaces'),
  scan: (iface?: string) => call<ScanResult>('/api/discovery/scan', { iface }, 60000),
  snmpSystem: (p: SnmpParams) => call<SnmpSystemResult>('/api/snmp/system', p, 20000),
  snmpInterfaces: (p: SnmpParams & { sampleMs?: number }) =>
    call<SnmpInterfacesResult>('/api/snmp/interfaces', p, 40000),
  vendors: () => call<Vendor[]>('/api/ssh/vendors'),
  sshExec: (p: {
    host: string;
    port: number;
    username: string;
    password: string;
    vendor: string;
    commandId: string;
    expectedFingerprint?: string;
  }) => call<SshResult>('/api/ssh/exec', p, 30000),
  ficha: (code: string) => call<Record<string, unknown>>(`/api/fichas/${encodeURIComponent(code)}`, undefined, 6000),
  syncPush: (ops: unknown[]) =>
    call<{ results: SyncResult[]; serverTime: number }>('/api/sync/push', { ops }, 30000),
};

export type SyncResult =
  | { opId: string; status: 'applied'; serverVersion: number }
  | { opId: string; status: 'duplicate' }
  | { opId: string; status: 'conflict'; server: { id: string; entity: string; data: Record<string, unknown> | null; updatedAt: number } }
  | { opId: string; status: 'rejected'; error: string };
