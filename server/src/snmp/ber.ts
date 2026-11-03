/**
 * Codificador/decodificador BER (Basic Encoding Rules, ASN.1) simplificado.
 *
 * Implementa SOLO el subconjunto de tipos que usa SNMP v1/v2c (RFC 1157 / RFC 3416):
 *   - Universales: INTEGER, OCTET STRING, NULL, OBJECT IDENTIFIER, SEQUENCE
 *   - Aplicacion (RFC 2578): IpAddress, Counter32, Gauge32, TimeTicks, Opaque, Counter64
 *   - Excepciones v2c: noSuchObject, noSuchInstance, endOfMibView
 *   - PDUs (context-specific, construidos): GetRequest, GetNextRequest, GetResponse, ...
 *
 * Cada TLV es: [tag 1 byte][longitud (forma corta o larga)][valor].
 */

export const Tag = {
  Integer: 0x02,
  OctetString: 0x04,
  Null: 0x05,
  ObjectIdentifier: 0x06,
  Sequence: 0x30,
  IpAddress: 0x40,
  Counter32: 0x41,
  Gauge32: 0x42,
  TimeTicks: 0x43,
  Opaque: 0x44,
  Counter64: 0x46,
  NoSuchObject: 0x80,
  NoSuchInstance: 0x81,
  EndOfMibView: 0x82,
  GetRequest: 0xa0,
  GetNextRequest: 0xa1,
  GetResponse: 0xa2,
  SetRequest: 0xa3,
  Trap: 0xa4,
  GetBulkRequest: 0xa5,
} as const;

export const TagName: Record<number, string> = Object.fromEntries(
  Object.entries(Tag).map(([k, v]) => [v, k]),
);

export class BerError extends Error {}

// ---------------------------------------------------------------------------
// Longitud
// ---------------------------------------------------------------------------

export function encodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function decodeLength(buf: Buffer, offset: number): { length: number; size: number } {
  if (offset >= buf.length) throw new BerError('Longitud truncada');
  const first = buf[offset];
  if (first < 0x80) return { length: first, size: 1 };
  const count = first & 0x7f;
  if (count === 0) throw new BerError('Longitud indefinida no soportada');
  if (count > 4) throw new BerError(`Longitud de ${count} bytes no soportada`);
  if (offset + count >= buf.length) throw new BerError('Longitud truncada');
  let length = 0;
  for (let i = 1; i <= count; i++) length = length * 256 + buf[offset + i];
  return { length, size: 1 + count };
}

export function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
}

// ---------------------------------------------------------------------------
// Primitivos
// ---------------------------------------------------------------------------

/** INTEGER con signo en complemento a dos, minima cantidad de bytes. */
export function encodeInteger(value: number, tag: number = Tag.Integer): Buffer {
  if (!Number.isInteger(value)) throw new BerError(`Entero invalido: ${value}`);
  const bytes: number[] = [];
  let n = BigInt(value);
  // Generar bytes hasta que el bit de signo del byte mas alto sea coherente.
  for (;;) {
    const byte = Number(n & 0xffn);
    bytes.unshift(byte);
    n >>= 8n;
    const signBit = (byte & 0x80) !== 0;
    if ((n === 0n && !signBit) || (n === -1n && signBit)) break;
  }
  return tlv(tag, Buffer.from(bytes));
}

/** Enteros sin signo de aplicacion (Counter32, Gauge32, TimeTicks, Counter64). */
export function encodeUnsigned(value: number | bigint, tag: number): Buffer {
  let n = BigInt(value);
  if (n < 0n) throw new BerError(`Valor sin signo negativo: ${value}`);
  const bytes: number[] = [];
  do {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  } while (n > 0n);
  if (bytes[0] & 0x80) bytes.unshift(0x00); // evitar que se interprete como negativo
  return tlv(tag, Buffer.from(bytes));
}

export function decodeInteger(value: Buffer): number {
  if (value.length === 0) throw new BerError('INTEGER vacio');
  if (value.length > 6) throw new BerError('INTEGER demasiado grande');
  let u = 0;
  for (const b of value) u = u * 256 + b;
  // Complemento a dos: si el bit mas alto esta encendido, el valor es negativo.
  return value[0] & 0x80 ? u - 2 ** (8 * value.length) : u;
}

export function decodeUnsigned(value: Buffer): bigint {
  let n = 0n;
  for (const b of value) n = (n << 8n) | BigInt(b);
  return n;
}

export function encodeOctetString(value: string | Buffer): Buffer {
  return tlv(Tag.OctetString, typeof value === 'string' ? Buffer.from(value, 'utf8') : value);
}

export function encodeNull(): Buffer {
  return Buffer.from([Tag.Null, 0x00]);
}

/** OID: los dos primeros arcos se combinan como 40*X+Y; el resto en base 128. */
export function encodeOid(oid: string): Buffer {
  const arcs = parseOid(oid);
  if (arcs.length < 2) throw new BerError(`OID invalido: ${oid}`);
  const bytes: number[] = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) bytes.push(...base128(arc));
  return tlv(Tag.ObjectIdentifier, Buffer.from(bytes));
}

function base128(n: number): number[] {
  const out = [n & 0x7f];
  n = Math.floor(n / 128);
  while (n > 0) {
    out.unshift((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  return out;
}

export function parseOid(oid: string): number[] {
  const clean = oid.trim().replace(/^\./, '');
  if (!/^\d+(\.\d+)+$/.test(clean)) throw new BerError(`OID invalido: ${oid}`);
  const arcs = clean.split('.').map(Number);
  if (arcs[0] > 2 || (arcs[0] < 2 && arcs[1] >= 40)) throw new BerError(`OID invalido: ${oid}`);
  return arcs;
}

export function decodeOid(value: Buffer): string {
  if (value.length === 0) throw new BerError('OID vacio');
  const first = value[0];
  const arcs: number[] = first < 80 ? [Math.floor(first / 40), first % 40] : [2, first - 80];
  let n = 0;
  for (let i = 1; i < value.length; i++) {
    n = n * 128 + (value[i] & 0x7f);
    if (!(value[i] & 0x80)) {
      arcs.push(n);
      n = 0;
    }
  }
  return arcs.join('.');
}

export function encodeIpAddress(ip: string): Buffer {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !(p >= 0 && p <= 255))) throw new BerError(`IP invalida: ${ip}`);
  return tlv(Tag.IpAddress, Buffer.from(parts));
}

export function sequence(...items: Buffer[]): Buffer {
  return tlv(Tag.Sequence, Buffer.concat(items));
}

// ---------------------------------------------------------------------------
// Lector generico de TLVs
// ---------------------------------------------------------------------------

export interface Tlv {
  tag: number;
  value: Buffer;
  /** bytes totales que ocupa este TLV (tag + longitud + valor) */
  size: number;
}

export function readTlv(buf: Buffer, offset = 0): Tlv {
  if (offset >= buf.length) throw new BerError('Fin de datos inesperado');
  const tag = buf[offset];
  const { length, size } = decodeLength(buf, offset + 1);
  const start = offset + 1 + size;
  const end = start + length;
  if (end > buf.length) throw new BerError(`TLV truncado (tag 0x${tag.toString(16)})`);
  return { tag, value: buf.subarray(start, end), size: 1 + size + length };
}

/** Lee todos los TLVs hijos de un tipo construido (SEQUENCE, PDU). */
export function readChildren(value: Buffer): Tlv[] {
  const out: Tlv[] = [];
  let offset = 0;
  while (offset < value.length) {
    const t = readTlv(value, offset);
    out.push(t);
    offset += t.size;
  }
  return out;
}

export function expectTag(t: Tlv, tag: number, what: string): Tlv {
  if (t.tag !== tag) {
    throw new BerError(`Se esperaba ${what} (0x${tag.toString(16)}) y llego 0x${t.tag.toString(16)}`);
  }
  return t;
}

export function hexDump(buf: Buffer): string {
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i += 16) {
    const chunk = buf.subarray(i, i + 16);
    const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    lines.push(`${i.toString(16).padStart(4, '0')}  ${hex}`);
  }
  return lines.join('\n');
}
