/**
 * Backend minimo de sincronizacion (stub persistido en data/sync-db.json).
 *
 * Recibe lotes de operaciones de la outbox del cliente y las aplica con:
 *  - Idempotencia: cada operacion trae un `opId` (UUID). Si ya se aplico, se
 *    responde `duplicate` sin volver a aplicarla (reintentos seguros).
 *  - Resolucion de conflictos Last-Write-Wins por `updatedAt`: si el servidor
 *    tiene una version mas nueva del registro, la operacion se rechaza como
 *    `conflict` y se devuelve la version del servidor para que el cliente la adopte.
 */
import fs from 'node:fs';
import path from 'node:path';

export const ENTITIES = ['device', 'diagnostic', 'installation', 'report'] as const;
export type Entity = (typeof ENTITIES)[number];

export interface SyncOp {
  opId: string;
  entity: Entity;
  entityId: string;
  action: 'upsert' | 'delete';
  payload?: Record<string, unknown>;
  updatedAt: number;
  clientId?: string;
}

export interface StoredRecord {
  id: string;
  entity: Entity;
  data: Record<string, unknown> | null;
  deleted: boolean;
  updatedAt: number;
  serverVersion: number;
  receivedAt: number;
  clientId?: string;
}

export type OpResult =
  | { opId: string; status: 'applied'; serverVersion: number }
  | { opId: string; status: 'duplicate' }
  | { opId: string; status: 'conflict'; server: StoredRecord }
  | { opId: string; status: 'rejected'; error: string };

interface DbShape {
  records: Record<string, StoredRecord>;
  appliedOps: string[];
  log: { at: number; opId: string; entity: string; entityId: string; status: string; clientId?: string }[];
}

export class SyncStore {
  private file: string;
  private db: DbShape;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'sync-db.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, 'utf8'))
      : { records: {}, appliedOps: [], log: [] };
  }

  private persist() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db));
    fs.renameSync(tmp, this.file); // escritura atomica
  }

  apply(ops: SyncOp[]): OpResult[] {
    const applied = new Set(this.db.appliedOps);
    const results = ops.map((op): OpResult => {
      if (!op?.opId || !ENTITIES.includes(op.entity) || !op.entityId || typeof op.updatedAt !== 'number') {
        return { opId: op?.opId ?? '?', status: 'rejected', error: 'Operacion invalida' };
      }
      if (applied.has(op.opId)) return { opId: op.opId, status: 'duplicate' };

      const key = `${op.entity}:${op.entityId}`;
      const current = this.db.records[key];
      if (current && current.updatedAt > op.updatedAt) {
        this.log(op, 'conflict');
        applied.add(op.opId); // la decision ya se tomo; reintentos daran duplicate
        this.db.appliedOps.push(op.opId);
        return { opId: op.opId, status: 'conflict', server: current };
      }
      const rec: StoredRecord = {
        id: op.entityId,
        entity: op.entity,
        data: op.action === 'delete' ? null : (op.payload ?? {}),
        deleted: op.action === 'delete',
        updatedAt: op.updatedAt,
        serverVersion: (current?.serverVersion ?? 0) + 1,
        receivedAt: Date.now(),
        clientId: op.clientId,
      };
      this.db.records[key] = rec;
      applied.add(op.opId);
      this.db.appliedOps.push(op.opId);
      this.log(op, 'applied');
      return { opId: op.opId, status: 'applied', serverVersion: rec.serverVersion };
    });
    if (this.db.appliedOps.length > 5000) this.db.appliedOps = this.db.appliedOps.slice(-5000);
    this.persist();
    return results;
  }

  private log(op: SyncOp, status: string) {
    this.db.log.unshift({ at: Date.now(), opId: op.opId, entity: op.entity, entityId: op.entityId, status, clientId: op.clientId });
    this.db.log = this.db.log.slice(0, 200);
  }

  pull(since: number) {
    return Object.values(this.db.records).filter((r) => r.receivedAt > since);
  }

  list(entity?: Entity) {
    return Object.values(this.db.records)
      .filter((r) => !entity || r.entity === entity)
      .sort((a, b) => b.receivedAt - a.receivedAt);
  }

  get recentLog() {
    return this.db.log;
  }

  /** Edicion "desde la oficina" para demostrar conflictos: marca el registro como mas nuevo. */
  touchFromBackoffice(entity: Entity, id: string, patch: Record<string, unknown>) {
    const key = `${entity}:${id}`;
    const cur = this.db.records[key];
    if (!cur || !cur.data) return null;
    cur.data = { ...cur.data, ...patch, updatedAt: Date.now() };
    cur.updatedAt = Date.now();
    cur.serverVersion += 1;
    cur.receivedAt = Date.now();
    this.db.log.unshift({ at: Date.now(), opId: 'backoffice', entity, entityId: id, status: 'edited-backoffice' });
    this.persist();
    return cur;
  }

  reset() {
    this.db = { records: {}, appliedOps: [], log: [] };
    this.persist();
  }
}
