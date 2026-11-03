/**
 * Descubrimiento mDNS / DNS-SD (Bonjour) con paquetes DNS armados a mano
 * (RFC 1035 + RFC 6762/6763), sobre UDP multicast 224.0.0.251:5353.
 */
import dgram from 'node:dgram';

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

const TYPE = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, ANY: 255 } as const;

const SERVICE_TYPES = [
  '_services._dns-sd._udp.local',
  '_http._tcp.local',
  '_https._tcp.local',
  '_ssh._tcp.local',
  '_sftp-ssh._tcp.local',
  '_workstation._tcp.local',
  '_smb._tcp.local',
  '_device-info._tcp.local',
  '_printer._tcp.local',
  '_ipp._tcp.local',
  '_googlecast._tcp.local',
  '_airplay._tcp.local',
  '_raop._tcp.local',
  '_spotify-connect._tcp.local',
  '_hap._tcp.local',
  '_mqtt._tcp.local',
];

function encodeName(name: string): Buffer {
  const parts = name.split('.').filter(Boolean);
  return Buffer.concat([
    ...parts.map((p) => {
      const b = Buffer.from(p, 'utf8');
      return Buffer.concat([Buffer.from([b.length]), b]);
    }),
    Buffer.from([0]),
  ]);
}

export function buildQuery(names: string[], type: number = TYPE.PTR, unicastResponse = true): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // id 0 en mDNS
  header.writeUInt16BE(0, 2); // flags: query estandar
  header.writeUInt16BE(names.length, 4);
  const questions = names.map((n) => {
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(type, 0);
    tail.writeUInt16BE(unicastResponse ? 0x8001 : 0x0001, 2); // bit QU + clase IN
    return Buffer.concat([encodeName(n), tail]);
  });
  return Buffer.concat([header, ...questions]);
}

/** Lee un nombre DNS soportando punteros de compresion (0xC0). */
function readName(buf: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let pos = offset;
  let next = -1;
  let jumps = 0;
  while (pos < buf.length) {
    const len = buf[pos];
    if (len === 0) {
      pos += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (++jumps > 16) throw new Error('loop de compresion DNS');
      if (next < 0) next = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      continue;
    }
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return { name: labels.join('.'), next: next >= 0 ? next : pos };
}

export interface DnsRecord {
  name: string;
  type: number;
  data: string;
  port?: number;
}

export function parseResponse(buf: Buffer): DnsRecord[] {
  if (buf.length < 12) return [];
  const qd = buf.readUInt16BE(4);
  const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let pos = 12;
  for (let i = 0; i < qd; i++) pos = readName(buf, pos).next + 4;
  const out: DnsRecord[] = [];
  for (let i = 0; i < total && pos < buf.length; i++) {
    const { name, next } = readName(buf, pos);
    pos = next;
    const type = buf.readUInt16BE(pos);
    const rdlen = buf.readUInt16BE(pos + 8);
    const rdata = pos + 10;
    pos = rdata + rdlen;
    if (type === TYPE.A && rdlen === 4) {
      out.push({ name, type, data: [...buf.subarray(rdata, rdata + 4)].join('.') });
    } else if (type === TYPE.PTR) {
      out.push({ name, type, data: readName(buf, rdata).name });
    } else if (type === TYPE.SRV) {
      out.push({ name, type, port: buf.readUInt16BE(rdata + 4), data: readName(buf, rdata + 6).name });
    }
  }
  return out;
}

export interface MdnsHost {
  ip: string;
  hostnames: Set<string>;
  services: Set<string>;
}

/**
 * Envia consultas PTR por los tipos de servicio comunes y escucha `durationMs`.
 * Las respuestas se agrupan por IP de origen.
 */
export async function mdnsBrowse(durationMs = 2500, bindAddress?: string): Promise<Map<string, MdnsHost>> {
  const hosts = new Map<string, MdnsHost>();
  const get = (ip: string) => {
    let h = hosts.get(ip);
    if (!h) hosts.set(ip, (h = { ip, hostnames: new Set(), services: new Set() }));
    return h;
  };
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, bindAddress, () => resolve());
  });
  socket.on('error', () => {});
  if (bindAddress) {
    try {
      socket.setMulticastInterface(bindAddress);
    } catch {
      /* algunas plataformas no lo permiten */
    }
  }

  socket.on('message', (msg, rinfo) => {
    let records: DnsRecord[];
    try {
      records = parseResponse(msg);
    } catch {
      return;
    }
    const h = get(rinfo.address);
    for (const r of records) {
      if (r.type === TYPE.A) {
        get(r.data).hostnames.add(r.name.replace(/\.local$/, ''));
      } else if (r.type === TYPE.SRV) {
        h.hostnames.add(r.data.replace(/\.local$/, ''));
        h.services.add(`${r.name.replace(/\.local$/, '')}:${r.port}`);
      } else if (r.type === TYPE.PTR && !r.name.startsWith('_services')) {
        if (r.name.endsWith('.in-addr.arpa')) h.hostnames.add(r.data.replace(/\.local$/, ''));
        else h.services.add(r.data.replace(/\.local$/, ''));
      }
    }
  });

  // Algunas pilas (Windows) no permiten enviar QU; se envian ambas variantes.
  const send = (pkt: Buffer) => new Promise<void>((r) => socket.send(pkt, MDNS_PORT, MDNS_ADDR, () => r()));
  for (let i = 0; i < SERVICE_TYPES.length; i += 4) {
    await send(buildQuery(SERVICE_TYPES.slice(i, i + 4), TYPE.PTR, true));
  }
  await new Promise((r) => setTimeout(r, durationMs / 2));
  await send(buildQuery(SERVICE_TYPES.slice(0, 4), TYPE.PTR, false));
  await new Promise((r) => setTimeout(r, durationMs / 2));
  socket.close();

  for (const [ip, h] of hosts) if (h.hostnames.size === 0 && h.services.size === 0) hosts.delete(ip);
  return hosts;
}

/** Consulta PTR inversa (x.x.x.x.in-addr.arpa) directa al puerto 5353 de un host. */
export async function mdnsReverse(ips: string[], timeoutMs = 1200): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ips.length === 0) return out;
  const socket = dgram.createSocket('udp4');
  await new Promise<void>((r) => socket.bind(0, () => r()));
  socket.on('error', () => {});
  socket.on('message', (msg, rinfo) => {
    try {
      for (const r of parseResponse(msg)) {
        if (r.type === TYPE.PTR && r.name.endsWith('in-addr.arpa')) out.set(rinfo.address, r.data.replace(/\.local$/, ''));
      }
    } catch {
      /* ignorar */
    }
  });
  for (const ip of ips) {
    const rev = ip.split('.').reverse().join('.') + '.in-addr.arpa';
    socket.send(buildQuery([rev], TYPE.PTR, false), MDNS_PORT, ip);
  }
  await new Promise((r) => setTimeout(r, timeoutMs));
  socket.close();
  return out;
}
