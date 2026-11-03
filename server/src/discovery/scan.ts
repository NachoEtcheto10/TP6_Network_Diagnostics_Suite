/**
 * Escaneo "ARP-like" de la subred local.
 *
 * Un proceso sin privilegios no puede emitir tramas ARP crudas, asi que se usa la
 * tecnica clasica: se envian sondas TCP/UDP a cada IP de la subred. Para enviar
 * cualquier paquete el sistema operativo primero debe resolver la MAC por ARP,
 * por lo que todos los hosts vivos quedan en la tabla ARP del SO, que luego se lee
 * (`arp -a` en Windows/macOS, `ip neigh` en Linux). Las sondas TCP ademas detectan
 * puertos abiertos (connect OK) o hosts vivos que rechazan (RST -> ECONNREFUSED).
 */
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mdnsBrowse, mdnsReverse } from './mdns.ts';
import { lookupVendor } from './oui.ts';

const exec = promisify(execFile);

export const PROBE_PORTS = [22, 23, 53, 80, 443, 445, 8080, 8291, 7547];
const PORT_NAMES: Record<number, string> = {
  22: 'ssh',
  23: 'telnet',
  53: 'dns',
  80: 'http',
  443: 'https',
  445: 'smb',
  8080: 'http-alt',
  8291: 'winbox',
  7547: 'tr-069',
};

export interface LocalInterface {
  name: string;
  address: string;
  netmask: string;
  mac: string;
  cidr: number;
  /** red /24 (o menor) que efectivamente se escanea */
  scanRange: string;
  private: boolean;
  likelyVpn: boolean;
}

const ipToInt = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const intToIp = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');
const maskToCidr = (mask: string) =>
  mask.split('.').reduce((a, o) => a + Number(o).toString(2).replace(/0/g, '').length, 0);

const isPrivate = (ip: string) =>
  /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

/** Calcula la porcion a escanear: nunca mas grande que una /24 alrededor de la IP propia. */
function scanBounds(address: string, cidr: number) {
  const effective = Math.max(cidr, 24);
  const size = 2 ** (32 - effective);
  const base = Math.floor(ipToInt(address) / size) * size;
  return { first: base + 1, last: base + size - 2, effective, base };
}

export function listInterfaces(): LocalInterface[] {
  const out: LocalInterface[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const cidr = maskToCidr(a.netmask);
      const { base, effective } = scanBounds(a.address, cidr);
      out.push({
        name,
        address: a.address,
        netmask: a.netmask,
        mac: a.mac,
        cidr,
        scanRange: `${intToIp(base)}/${effective}`,
        private: isPrivate(a.address),
        likelyVpn: /vpn|virtual|vmware|vbox|hyper-v|wsl|docker|tailscale|zerotier|radmin|hamachi/i.test(name),
      });
    }
  }
  // Primero las interfaces privadas que no parecen VPN/virtuales (Wi-Fi / Ethernet reales)
  return out.sort((a, b) => Number(b.private && !b.likelyVpn) - Number(a.private && !a.likelyVpn));
}

/** Sonda TCP: 'open' si conecta, 'closed' si el host responde RST, null si no hay respuesta. */
function tcpProbe(ip: string, port: number, timeoutMs: number): Promise<{ state: 'open' | 'closed'; rtt: number } | null> {
  return new Promise((resolve) => {
    const started = performance.now();
    const sock = new net.Socket();
    const done = (v: { state: 'open' | 'closed'; rtt: number } | null) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done({ state: 'open', rtt: Math.round(performance.now() - started) }));
    sock.once('timeout', () => done(null));
    sock.once('error', (err: NodeJS.ErrnoException) =>
      done(err.code === 'ECONNREFUSED' ? { state: 'closed', rtt: Math.round(performance.now() - started) } : null),
    );
    sock.connect(port, ip);
  });
}

async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

export interface ArpEntry {
  ip: string;
  mac: string;
}

export async function readArpTable(): Promise<ArpEntry[]> {
  const entries: ArpEntry[] = [];
  const rx = /(\d{1,3}(?:\.\d{1,3}){3})\D+?((?:[0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2})/gi;
  let text = '';
  try {
    if (process.platform === 'linux') {
      text = (await exec('ip', ['neigh', 'show'], { encoding: 'latin1' })).stdout;
    } else {
      text = (await exec('arp', ['-a'], { encoding: 'latin1' })).stdout;
    }
  } catch {
    try {
      text = (await exec('arp', ['-an'], { encoding: 'latin1' })).stdout;
    } catch {
      return entries;
    }
  }
  for (const line of text.split(/\r?\n/)) {
    if (/incomplete|FAILED/i.test(line)) continue;
    rx.lastIndex = 0;
    const m = rx.exec(line);
    if (!m) continue;
    const mac = m[2]
      .toLowerCase()
      .split(/[:-]/)
      .map((p) => p.padStart(2, '0'))
      .join(':');
    if (mac === 'ff:ff:ff:ff:ff:ff' || mac === '00:00:00:00:00:00' || mac.startsWith('01:00:5e')) continue;
    entries.push({ ip: m[1], mac });
  }
  return entries;
}

/**
 * Gateway por defecto de la interfaz escaneada. Puede haber varias rutas 0.0.0.0
 * (ej. VPNs); se elige la que sale por `ifaceAddress` o cuyo gateway cae en la subred.
 */
export async function defaultGateway(ifaceAddress: string, inRange: (ip: string) => boolean): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await exec('route', ['print', '-4', '0.0.0.0'], { encoding: 'latin1' });
      const routes = [...stdout.matchAll(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)/gm)];
      const match = routes.find((m) => m[2] === ifaceAddress) ?? routes.find((m) => inRange(m[1]));
      return match?.[1] ?? null;
    }
    if (process.platform === 'linux') {
      const { stdout } = await exec('ip', ['route', 'show', 'default']);
      const gws = [...stdout.matchAll(/via (\d+\.\d+\.\d+\.\d+)/g)].map((m) => m[1]);
      return gws.find(inRange) ?? gws[0] ?? null;
    }
    const { stdout } = await exec('route', ['-n', 'get', 'default']);
    return /gateway: (\d+\.\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * NetBIOS Node Status (NBSTAT, UDP/137, RFC 1002): devuelve el nombre de equipo
 * de hosts Windows/Samba. Paquete armado a mano.
 */
export async function netbiosNames(ips: string[], timeoutMs = 900): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ips.length === 0) return out;
  // Nombre "*" codificado (first-level encoding): '*' -> 'CK', 15 x 0x00 -> 'AA'
  const encoded = Buffer.from('CK' + 'A'.repeat(30), 'ascii');
  const packet = Buffer.concat([
    Buffer.from([0x13, 0x37, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from([0x20]),
    encoded,
    Buffer.from([0x00, 0x00, 0x21, 0x00, 0x01]), // fin de nombre, tipo NBSTAT, clase IN
  ]);
  const socket = dgram.createSocket('udp4');
  await new Promise<void>((r) => socket.bind(0, () => r()));
  socket.on('error', () => {});
  socket.on('message', (msg, rinfo) => {
    try {
      // header(12) + nombre(34) + type/class/ttl(8) + rdlength(2) -> num_names
      let pos = 12 + 34 + 8 + 2;
      const count = msg[pos++];
      for (let i = 0; i < count; i++) {
        const name = msg.toString('latin1', pos, pos + 15).trim();
        const suffix = msg[pos + 15];
        const flags = msg.readUInt16BE(pos + 16);
        pos += 18;
        if (suffix === 0x00 && !(flags & 0x8000)) {
          out.set(rinfo.address, name);
          break;
        }
      }
    } catch {
      /* respuesta malformada */
    }
  });
  for (const ip of ips) socket.send(packet, 137, ip);
  await new Promise((r) => setTimeout(r, timeoutMs));
  socket.close();
  return out;
}

async function reverseDns(ip: string): Promise<string | null> {
  try {
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error('timeout')), 1200)),
    ]);
    return names[0] ?? null;
  } catch {
    return null;
  }
}

export interface DiscoveredDevice {
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
}

export interface ScanResult {
  interface: LocalInterface;
  gateway: string | null;
  range: string;
  hostsProbed: number;
  durationMs: number;
  devices: DiscoveredDevice[];
}

export async function scanNetwork(opts: { iface?: string; timeoutMs?: number } = {}): Promise<ScanResult> {
  const t0 = performance.now();
  const ifaces = listInterfaces();
  const iface = ifaces.find((i) => i.address === opts.iface || i.name === opts.iface) ?? ifaces[0];
  if (!iface) throw new Error('No hay interfaces de red IPv4 activas');

  const { first, last } = scanBounds(iface.address, iface.cidr);
  const targets: string[] = [];
  for (let n = first; n <= last; n++) targets.push(intToIp(n));
  const inRange = (ip: string) => ipToInt(ip) >= first && ipToInt(ip) <= last;

  const timeoutMs = opts.timeoutMs ?? 600;
  const alive = new Map<string, { ports: Set<number>; rtt: number | null; sources: Set<string> }>();
  const mark = (ip: string, source: string) => {
    let a = alive.get(ip);
    if (!a) alive.set(ip, (a = { ports: new Set(), rtt: null, sources: new Set() }));
    a.sources.add(source);
    return a;
  };

  // mDNS en paralelo con el barrido
  const mdnsPromise = mdnsBrowse(2500, iface.address).catch(() => new Map());
  const gatewayPromise = defaultGateway(iface.address, inRange);

  // Datagrama UDP "despertador" a cada host: fuerza la resolucion ARP
  const udp = dgram.createSocket('udp4');
  await new Promise<void>((r) => udp.bind(0, iface.address, () => r()));
  udp.on('error', () => {});
  for (const ip of targets) udp.send(Buffer.from([0]), 9, ip);

  const jobs = targets.flatMap((ip) => PROBE_PORTS.map((port) => ({ ip, port })));
  await pool(jobs, 384, async ({ ip, port }) => {
    const r = await tcpProbe(ip, port, timeoutMs);
    if (!r) return;
    const a = mark(ip, 'tcp');
    if (r.state === 'open') a.ports.add(port);
    a.rtt = a.rtt == null ? r.rtt : Math.min(a.rtt, r.rtt);
  });
  udp.close();

  await new Promise((r) => setTimeout(r, 300));
  const arp = (await readArpTable()).filter((e) => inRange(e.ip));
  const macs = new Map<string, string>();
  for (const e of arp) {
    macs.set(e.ip, e.mac);
    mark(e.ip, 'arp');
  }
  // el propio equipo nunca aparece en su tabla ARP
  mark(iface.address, 'local');
  macs.set(iface.address, iface.mac.toLowerCase());

  const mdns = await mdnsPromise;
  for (const [ip] of mdns) if (inRange(ip)) mark(ip, 'mdns');

  const gateway = await gatewayPromise;
  const ips = [...alive.keys()].sort((a, b) => ipToInt(a) - ipToInt(b));
  const others = ips.filter((ip) => ip !== iface.address);
  const [nb, mdnsRev, rdns] = await Promise.all([
    netbiosNames(others),
    mdnsReverse(others),
    Promise.all(ips.map(async (ip) => [ip, await reverseDns(ip)] as const)),
  ]);
  const rdnsMap = new Map(rdns);

  const devices: DiscoveredDevice[] = ips.map((ip) => {
    const a = alive.get(ip)!;
    const m = mdns.get(ip);
    const hostnames = new Set<string>();
    if (ip === iface.address) hostnames.add(os.hostname());
    if (nb.get(ip)) {
      hostnames.add(nb.get(ip)!);
      a.sources.add('netbios');
    }
    if (mdnsRev.get(ip)) hostnames.add(mdnsRev.get(ip)!);
    m?.hostnames.forEach((h: string) => hostnames.add(h));
    const r = rdnsMap.get(ip);
    if (r && r !== ip) {
      hostnames.add(r);
      a.sources.add('dns');
    }
    const mac = macs.get(ip) ?? null;
    const randomizedMac = mac ? (parseInt(mac.slice(0, 2), 16) & 0x02) !== 0 : false;
    return {
      ip,
      mac,
      vendor: mac ? lookupVendor(mac) : null,
      randomizedMac,
      hostname: [...hostnames][0] ?? null,
      hostnames: [...hostnames],
      openPorts: [...a.ports].sort((x, y) => x - y).map((port) => ({ port, service: PORT_NAMES[port] ?? '?' })),
      services: m ? [...m.services] : [],
      isGateway: ip === gateway,
      isSelf: ip === iface.address,
      rttMs: a.rtt,
      sources: [...a.sources],
    };
  });

  return {
    interface: iface,
    gateway,
    range: `${intToIp(first)} - ${intToIp(last)}`,
    hostsProbed: targets.length,
    durationMs: Math.round(performance.now() - t0),
    devices,
  };
}
