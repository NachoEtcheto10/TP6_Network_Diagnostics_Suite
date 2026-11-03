/**
 * Cliente SNMP v1/v2c sobre UDP crudo (node:dgram). Sin librerias SNMP externas:
 * los paquetes se arman con pdu.ts / ber.ts.
 */
import dgram from 'node:dgram';
import { randomInt } from 'node:crypto';
import { Tag, hexDump } from './ber.ts';
import { ErrorStatus, buildGetRequest, compareOid, decodeMessage, type SnmpVersion, type VarBind } from './pdu.ts';
import { IF_COLUMNS, IF_NUMBER, IF_STATUS, SYSTEM, formatTimeTicks, ifOid, oidName } from './mib.ts';

export interface SnmpTarget {
  host: string;
  port?: number;
  community?: string;
  version?: SnmpVersion;
  timeoutMs?: number;
  retries?: number;
}

export interface PacketTrace {
  pdu: string;
  requestId: number;
  request: string; // hex dump
  response?: string;
  rttMs?: number;
}

export class SnmpError extends Error {
  trace: PacketTrace[];
  constructor(message: string, trace: PacketTrace[]) {
    super(message);
    this.trace = trace;
  }
}

const MAX_OIDS_PER_PDU = 10;

/** Envia una PDU y espera la GetResponse con el mismo request-id. */
async function request(
  t: SnmpTarget,
  oids: string[],
  pduType: number,
  trace: PacketTrace[],
): Promise<VarBind[]> {
  const port = t.port ?? 161;
  const version = t.version ?? 'v2c';
  const community = t.community ?? 'public';
  const timeoutMs = t.timeoutMs ?? 2000;
  const retries = t.retries ?? 1;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const requestId = randomInt(1, 0x7fffffff);
    const packet = buildGetRequest(version, community, requestId, oids, pduType);
    const entry: PacketTrace = {
      pdu: pduType === Tag.GetNextRequest ? 'GetNextRequest' : 'GetRequest',
      requestId,
      request: hexDump(packet),
    };
    trace.push(entry);

    const result = await new Promise<{ msg: ReturnType<typeof decodeMessage>; raw: Buffer } | null>(
      (resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        const started = performance.now();
        const timer = setTimeout(() => {
          socket.close();
          resolve(null);
        }, timeoutMs);
        socket.on('error', (err) => {
          clearTimeout(timer);
          socket.close();
          reject(err);
        });
        socket.on('message', (raw) => {
          try {
            const msg = decodeMessage(raw);
            if (msg.requestId !== requestId) return; // respuesta vieja/ajena: se ignora
            entry.rttMs = Math.round(performance.now() - started);
            entry.response = hexDump(raw);
            clearTimeout(timer);
            socket.close();
            resolve({ msg, raw });
          } catch (err) {
            clearTimeout(timer);
            socket.close();
            reject(err);
          }
        });
        socket.send(packet, port, t.host);
      },
    );

    if (!result) continue; // timeout -> reintento
    const { msg } = result;
    if (msg.errorStatus !== 0) {
      const name = ErrorStatus[msg.errorStatus] ?? `error ${msg.errorStatus}`;
      const failed = msg.errorIndex > 0 ? oids[msg.errorIndex - 1] : undefined;
      throw new SnmpError(
        `El agente respondio ${name}${failed ? ` en ${oidName(failed)} (${failed})` : ''}`,
        trace,
      );
    }
    return msg.varbinds;
  }
  throw new SnmpError(
    `Sin respuesta de ${t.host}:${port} tras ${retries + 1} intento(s). ` +
      'Verifica que SNMP este habilitado, la community y el firewall (UDP/161).',
    trace,
  );
}

export async function snmpGet(t: SnmpTarget, oids: string[], trace: PacketTrace[] = []) {
  const out: VarBind[] = [];
  for (let i = 0; i < oids.length; i += MAX_OIDS_PER_PDU) {
    out.push(...(await request(t, oids.slice(i, i + MAX_OIDS_PER_PDU), Tag.GetRequest, trace)));
  }
  return out;
}

/** Recorre un subarbol con GetNextRequest sucesivos (walk simplificado). */
export async function snmpWalk(t: SnmpTarget, base: string, max = 32, trace: PacketTrace[] = []) {
  const out: VarBind[] = [];
  let current = base;
  while (out.length < max) {
    const [vb] = await request(t, [current], Tag.GetNextRequest, trace);
    if (!vb || vb.value.type === 'EndOfMibView' || !vb.oid.startsWith(base + '.')) break;
    if (compareOid(vb.oid, current) <= 0) break; // agente defectuoso: evita loops
    out.push(vb);
    current = vb.oid;
  }
  return out;
}

function display(vb: VarBind): string | number | null {
  const v = vb.value;
  if (v.type === 'NoSuchObject' || v.type === 'NoSuchInstance' || v.type === 'EndOfMibView') return null;
  if (v.type === 'Integer') return v.value;
  return v.value as string | null;
}

export async function querySystem(t: SnmpTarget) {
  const trace: PacketTrace[] = [];
  const oids = Object.values(SYSTEM);
  const varbinds = await snmpGet(t, oids, trace);
  const values: Record<string, string | number | null> = {};
  for (const vb of varbinds) values[oidName(vb.oid)] = display(vb);
  const ticks = Number(values.sysUpTime ?? 0);
  return {
    system: {
      sysDescr: values.sysDescr ?? null,
      sysObjectID: values.sysObjectID ?? null,
      sysUpTime: values.sysUpTime ?? null,
      sysUpTimeText: values.sysUpTime != null ? formatTimeTicks(ticks) : null,
      sysContact: values.sysContact ?? null,
      sysName: values.sysName ?? null,
      sysLocation: values.sysLocation ?? null,
    },
    varbinds: varbinds.map((vb) => ({ oid: vb.oid, name: oidName(vb.oid), type: vb.value.type, value: display(vb) })),
    trace,
  };
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

const COUNTER_WRAP = 2 ** 32;

/**
 * Trafico de interfaces: descubre los ifIndex con un walk sobre ifDescr y toma dos
 * muestras de ifInOctets/ifOutOctets separadas `sampleMs` para calcular bits/s.
 */
export async function queryInterfaces(t: SnmpTarget, sampleMs = 2000, maxIfs = 16) {
  const trace: PacketTrace[] = [];
  const [ifNumberVb] = await snmpGet(t, [IF_NUMBER], trace);
  const descrs = await snmpWalk(t, `1.3.6.1.2.1.2.2.1.${IF_COLUMNS.ifDescr}`, maxIfs, trace);
  const indexes = descrs.map((vb) => Number(vb.oid.split('.').pop()));

  const cols = [
    IF_COLUMNS.ifSpeed,
    IF_COLUMNS.ifPhysAddress,
    IF_COLUMNS.ifAdminStatus,
    IF_COLUMNS.ifOperStatus,
    IF_COLUMNS.ifInOctets,
    IF_COLUMNS.ifOutOctets,
    IF_COLUMNS.ifInErrors,
    IF_COLUMNS.ifOutErrors,
  ];
  const sample = async () => {
    const vbs = await snmpGet(t, indexes.flatMap((i) => cols.map((c) => ifOid(c, i))), trace);
    return { at: performance.now(), map: new Map(vbs.map((vb) => [vb.oid, display(vb)])) };
  };
  const counterOids = indexes.flatMap((i) => [ifOid(IF_COLUMNS.ifInOctets, i), ifOid(IF_COLUMNS.ifOutOctets, i)]);

  const first = await sample();
  let second: { at: number; map: Map<string, string | number | null> } | null = null;
  if (sampleMs > 0 && indexes.length > 0) {
    await new Promise((r) => setTimeout(r, sampleMs));
    const vbs = await snmpGet(t, counterOids, trace);
    second = { at: performance.now(), map: new Map(vbs.map((vb) => [vb.oid, display(vb)])) };
  }

  const num = (v: string | number | null | undefined) => (v == null ? null : Number(v));
  const rate = (oid: string) => {
    if (!second) return null;
    const a = num(first.map.get(oid));
    const b = num(second.map.get(oid));
    if (a == null || b == null) return null;
    const delta = b >= a ? b - a : b + COUNTER_WRAP - a; // Counter32 dio la vuelta
    return Math.round((delta * 8) / ((second.at - first.at) / 1000));
  };

  const interfaces: InterfaceStats[] = indexes.map((i, k) => {
    const g = (col: number) => first.map.get(ifOid(col, i));
    return {
      index: i,
      descr: String(display(descrs[k]) ?? `if${i}`),
      speed: num(g(IF_COLUMNS.ifSpeed)),
      mac: (g(IF_COLUMNS.ifPhysAddress) as string) || null,
      adminStatus: IF_STATUS[Number(g(IF_COLUMNS.ifAdminStatus))] ?? '?',
      operStatus: IF_STATUS[Number(g(IF_COLUMNS.ifOperStatus))] ?? '?',
      inOctets: num(second?.map.get(ifOid(IF_COLUMNS.ifInOctets, i)) ?? g(IF_COLUMNS.ifInOctets)) ?? 0,
      outOctets: num(second?.map.get(ifOid(IF_COLUMNS.ifOutOctets, i)) ?? g(IF_COLUMNS.ifOutOctets)) ?? 0,
      inErrors: num(g(IF_COLUMNS.ifInErrors)),
      outErrors: num(g(IF_COLUMNS.ifOutErrors)),
      inBps: rate(ifOid(IF_COLUMNS.ifInOctets, i)),
      outBps: rate(ifOid(IF_COLUMNS.ifOutOctets, i)),
    };
  });

  return { ifNumber: display(ifNumberVb), sampleMs: second ? sampleMs : 0, interfaces, trace };
}
