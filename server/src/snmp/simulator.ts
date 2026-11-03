/**
 * Agente SNMP simulado (equipo de laboratorio). Escucha en UDP y responde
 * GetRequest / GetNextRequest con una MIB-II minima, usando el MISMO codec
 * BER que el cliente. Sirve para demostrar el flujo cuando no hay un equipo
 * real con SNMP habilitado en la LAN.
 *
 * Se comporta como un agente real: si la community no coincide, descarta el
 * paquete en silencio (el cliente vera un timeout).
 */
import dgram from 'node:dgram';
import os from 'node:os';
import { Tag } from './ber.ts';
import { compareOid, decodeMessage, encodeMessage, type SnmpValue, type VarBind } from './pdu.ts';

interface SimIf {
  descr: string;
  type: number;
  mtu: number;
  speed: number;
  mac: Buffer;
  oper: number;
  /** bytes/seg promedio para generar trafico creible */
  inRate: number;
  outRate: number;
}

const IFACES: SimIf[] = [
  { descr: 'lo', type: 24, mtu: 65536, speed: 10_000_000, mac: Buffer.alloc(6), oper: 1, inRate: 2_000, outRate: 2_000 },
  { descr: 'eth0 (WAN GPON)', type: 6, mtu: 1500, speed: 1_000_000_000, mac: Buffer.from('a4c3f0112233', 'hex'), oper: 1, inRate: 1_400_000, outRate: 220_000 },
  { descr: 'eth1 (LAN1)', type: 6, mtu: 1500, speed: 1_000_000_000, mac: Buffer.from('a4c3f0112234', 'hex'), oper: 1, inRate: 180_000, outRate: 1_200_000 },
  { descr: 'eth2 (LAN2)', type: 6, mtu: 1500, speed: 100_000_000, mac: Buffer.from('a4c3f0112235', 'hex'), oper: 2, inRate: 0, outRate: 0 },
  { descr: 'wlan0 (2.4GHz)', type: 71, mtu: 1500, speed: 300_000_000, mac: Buffer.from('a4c3f0112236', 'hex'), oper: 1, inRate: 90_000, outRate: 410_000 },
];

export interface SimulatorOptions {
  port: number;
  community: string;
  sysName?: string;
}

export function startSnmpSimulator(opts: SimulatorOptions) {
  const bootedAt = Date.now();
  const started = new Map<number, number>(); // contador base por interfaz
  IFACES.forEach((_, i) => started.set(i, Math.floor(Math.random() * 5e8)));

  const elapsed = () => (Date.now() - bootedAt) / 1000;
  const counter = (base: number, rate: number) => {
    // trafico con algo de ruido, acumulado; Counter32 hace wrap en 2^32
    const jitter = 0.85 + 0.3 * Math.abs(Math.sin(Date.now() / 7000));
    return String(Math.floor(base + rate * elapsed() * jitter) % 2 ** 32);
  };

  const mib = new Map<string, () => SnmpValue>();
  const str = (s: string): SnmpValue => ({ type: 'OctetString', value: s, hex: Buffer.from(s).toString('hex') });

  mib.set('1.3.6.1.2.1.1.1.0', () => str('NDS-Lab ONT/Router simulado - Linux 5.10 armv7l (agente SNMP del TP6)'));
  mib.set('1.3.6.1.2.1.1.2.0', () => ({ type: 'ObjectIdentifier', value: '1.3.6.1.4.1.8072.3.2.10' }));
  // sysUpTime real del host (en centesimas de segundo) para que sea creible
  mib.set('1.3.6.1.2.1.1.3.0', () => ({ type: 'TimeTicks', value: String(Math.floor(os.uptime() * 100)) }));
  mib.set('1.3.6.1.2.1.1.4.0', () => str('noc@nds-lab.local'));
  mib.set('1.3.6.1.2.1.1.5.0', () => str(opts.sysName ?? 'nds-lab-ont01'));
  mib.set('1.3.6.1.2.1.1.6.0', () => str('Laboratorio TP6 - Rack 1'));
  mib.set('1.3.6.1.2.1.2.1.0', () => ({ type: 'Integer', value: IFACES.length }));

  IFACES.forEach((ifc, i) => {
    const idx = i + 1;
    const o = (col: number) => `1.3.6.1.2.1.2.2.1.${col}.${idx}`;
    mib.set(o(1), () => ({ type: 'Integer', value: idx }));
    mib.set(o(2), () => str(ifc.descr));
    mib.set(o(3), () => ({ type: 'Integer', value: ifc.type }));
    mib.set(o(4), () => ({ type: 'Integer', value: ifc.mtu }));
    mib.set(o(5), () => ({ type: 'Gauge32', value: String(ifc.speed) }));
    mib.set(o(6), () => ({ type: 'OctetString', value: ifc.mac.toString('hex'), hex: ifc.mac.toString('hex') }));
    mib.set(o(7), () => ({ type: 'Integer', value: 1 }));
    mib.set(o(8), () => ({ type: 'Integer', value: ifc.oper }));
    mib.set(o(10), () => ({ type: 'Counter32', value: counter(started.get(i)!, ifc.inRate) }));
    mib.set(o(14), () => ({ type: 'Counter32', value: String(idx === 2 ? 3 : 0) }));
    mib.set(o(16), () => ({ type: 'Counter32', value: counter(started.get(i)! / 3, ifc.outRate) }));
    mib.set(o(20), () => ({ type: 'Counter32', value: '0' }));
  });

  const sorted = [...mib.keys()].sort(compareOid);

  const socket = dgram.createSocket('udp4');
  socket.on('message', (raw, rinfo) => {
    let req;
    try {
      req = decodeMessage(raw);
    } catch {
      return; // paquete malformado: un agente real lo descarta
    }
    if (req.community !== opts.community) return;
    if (req.pduType !== Tag.GetRequest && req.pduType !== Tag.GetNextRequest) return;

    let errorStatus = 0;
    let errorIndex = 0;
    const out: VarBind[] = req.varbinds.map((vb, i) => {
      let oid = vb.oid;
      if (req.pduType === Tag.GetNextRequest) {
        const next = sorted.find((k) => compareOid(k, vb.oid) > 0);
        if (!next) {
          if (req.version === 'v1' && !errorStatus) {
            errorStatus = 2;
            errorIndex = i + 1;
          }
          return { oid: vb.oid, value: { type: 'EndOfMibView', value: null } };
        }
        oid = next;
      } else if (!mib.has(oid)) {
        if (req.version === 'v1' && !errorStatus) {
          errorStatus = 2; // noSuchName
          errorIndex = i + 1;
        }
        return { oid, value: { type: 'NoSuchObject', value: null } };
      }
      return { oid, value: mib.get(oid)!() };
    });

    // En v1 con error se devuelven los varbinds originales sin tocar
    const varbinds = errorStatus ? req.varbinds : out;
    const packet = encodeMessage({
      version: req.version,
      community: req.community,
      pduType: Tag.GetResponse,
      requestId: req.requestId,
      errorStatus,
      errorIndex,
      varbinds,
    });
    socket.send(packet, rinfo.port, rinfo.address);
  });

  return new Promise<dgram.Socket>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(opts.port, () => {
      socket.off('error', reject);
      socket.on('error', (e) => console.error('[snmp-sim]', e.message));
      resolve(socket);
    });
  });
}
