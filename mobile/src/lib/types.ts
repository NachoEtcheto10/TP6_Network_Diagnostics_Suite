export interface GeoPoint {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  altitude: number | null;
  capturedAt: number;
}

export interface Ficha {
  code: string;
  tipo?: string;
  modelo?: string;
  fabricante?: string;
  serie?: string;
  firmware?: string;
  notas?: string;
  [k: string]: unknown;
}

export interface Device {
  id: string; // MAC si se conoce, si no la IP
  ip: string;
  mac: string | null;
  vendor: string | null;
  randomizedMac?: boolean;
  hostname: string | null;
  hostnames: string[];
  openPorts: { port: number; service: string }[];
  services: string[];
  isGateway: boolean;
  isSelf: boolean;
  sources: string[];
  rttMs: number | null;
  firstSeen: number;
  lastSeen: number;
  qrCode?: string | null;
  ficha?: Ficha | null;
  updatedAt: number;
}

export type DiagnosticKind = 'scan' | 'snmp-system' | 'snmp-interfaces' | 'ssh';

export interface Diagnostic {
  id: string;
  kind: DiagnosticKind;
  deviceId: string | null;
  host: string;
  summary: string;
  ok: boolean;
  data: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface Photo {
  id: string;
  dataUri: string;
  width: number;
  height: number;
  takenAt: number;
  location: GeoPoint | null;
}

export interface Installation {
  id: string;
  siteName: string;
  client: string;
  address: string;
  technician: string;
  equipmentCode: string | null;
  ficha: Ficha | null;
  deviceIds: string[];
  notes: string;
  location: GeoPoint | null;
  photos: Photo[];
  status: 'draft' | 'completed';
  reportGeneratedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type SyncEntity = 'device' | 'diagnostic' | 'installation' | 'report';

export interface OutboxOp {
  opId: string; // clave de idempotencia
  entity: SyncEntity;
  entityId: string;
  action: 'upsert' | 'delete';
  payload: Record<string, unknown> | null;
  updatedAt: number;
  createdAt: number;
  attempts: number;
  status: 'pending' | 'syncing' | 'retrying' | 'failed';
  nextAttemptAt: number;
  lastError: string | null;
  bytes: number;
}

export interface SyncLogEntry {
  at: number;
  opId: string;
  entity: SyncEntity;
  entityId: string;
  result: 'applied' | 'duplicate' | 'conflict' | 'rejected' | 'error';
  detail?: string;
}

export interface Settings {
  agentUrl: string;
  technician: string;
  forceOffline: boolean;
  clientId: string;
}

export interface ScanMeta {
  at: number;
  iface: string;
  range: string;
  gateway: string | null;
  durationMs: number;
  count: number;
}
