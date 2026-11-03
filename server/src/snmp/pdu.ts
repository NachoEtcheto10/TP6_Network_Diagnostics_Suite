/**
 * Mensajes SNMP v1/v2c construidos y parseados a mano sobre el codec BER.
 *
 *   Message ::= SEQUENCE {
 *     version    INTEGER  -- 0 = v1, 1 = v2c
 *     community  OCTET STRING
 *     data       PDU      -- [0] GetRequest, [1] GetNext, [2] Response, ...
 *   }
 *   PDU ::= SEQUENCE-like (tag de contexto) {
 *     request-id    INTEGER
 *     error-status  INTEGER
 *     error-index   INTEGER
 *     variable-bindings SEQUENCE OF SEQUENCE { name OID, value ANY }
 *   }
 */
import {
  BerError,
  Tag,
  TagName,
  decodeInteger,
  decodeOid,
  decodeUnsigned,
  encodeInteger,
  encodeIpAddress,
  encodeNull,
  encodeOctetString,
  encodeOid,
  encodeUnsigned,
  expectTag,
  readChildren,
  readTlv,
  sequence,
  tlv,
} from './ber.ts';

export type SnmpVersion = 'v1' | 'v2c';

export const ErrorStatus: Record<number, string> = {
  0: 'noError',
  1: 'tooBig',
  2: 'noSuchName',
  3: 'badValue',
  4: 'readOnly',
  5: 'genErr',
  6: 'noAccess',
  7: 'wrongType',
  8: 'wrongLength',
  9: 'wrongEncoding',
  10: 'wrongValue',
  11: 'noCreation',
  12: 'inconsistentValue',
  13: 'resourceUnavailable',
  14: 'commitFailed',
  15: 'undoFailed',
  16: 'authorizationError',
  17: 'notWritable',
  18: 'inconsistentName',
};

/** Valor de un varbind ya decodificado, con el tipo SNMP original. */
export type SnmpValue =
  | { type: 'Integer'; value: number }
  | { type: 'OctetString'; value: string; hex: string }
  | { type: 'Null'; value: null }
  | { type: 'ObjectIdentifier'; value: string }
  | { type: 'IpAddress'; value: string }
  | { type: 'Counter32' | 'Gauge32' | 'TimeTicks' | 'Counter64'; value: string }
  | { type: 'Opaque'; value: string }
  | { type: 'NoSuchObject' | 'NoSuchInstance' | 'EndOfMibView'; value: null };

export interface VarBind {
  oid: string;
  value: SnmpValue;
}

export interface SnmpMessage {
  version: SnmpVersion;
  community: string;
  pduType: number;
  pduName: string;
  requestId: number;
  errorStatus: number;
  errorIndex: number;
  varbinds: VarBind[];
}

// ---------------------------------------------------------------------------
// Codificacion
// ---------------------------------------------------------------------------

export function encodeValue(v: SnmpValue): Buffer {
  switch (v.type) {
    case 'Integer':
      return encodeInteger(v.value);
    case 'OctetString':
      // `hex` es la fuente de verdad: permite valores binarios (ej. MAC en ifPhysAddress)
      return encodeOctetString(Buffer.from(v.hex, 'hex'));
    case 'Null':
      return encodeNull();
    case 'ObjectIdentifier':
      return encodeOid(v.value);
    case 'IpAddress':
      return encodeIpAddress(v.value);
    case 'Counter32':
      return encodeUnsigned(BigInt(v.value) & 0xffffffffn, Tag.Counter32);
    case 'Gauge32':
      return encodeUnsigned(BigInt(v.value), Tag.Gauge32);
    case 'TimeTicks':
      return encodeUnsigned(BigInt(v.value) & 0xffffffffn, Tag.TimeTicks);
    case 'Counter64':
      return encodeUnsigned(BigInt(v.value), Tag.Counter64);
    case 'Opaque':
      return tlv(Tag.Opaque, Buffer.from(v.value, 'hex'));
    case 'NoSuchObject':
      return Buffer.from([Tag.NoSuchObject, 0]);
    case 'NoSuchInstance':
      return Buffer.from([Tag.NoSuchInstance, 0]);
    case 'EndOfMibView':
      return Buffer.from([Tag.EndOfMibView, 0]);
  }
}

export function encodeMessage(msg: {
  version: SnmpVersion;
  community: string;
  pduType: number;
  requestId: number;
  errorStatus?: number;
  errorIndex?: number;
  varbinds: VarBind[];
}): Buffer {
  const varbinds = sequence(
    ...msg.varbinds.map((vb) => sequence(encodeOid(vb.oid), encodeValue(vb.value))),
  );
  const pdu = tlv(
    msg.pduType,
    Buffer.concat([
      encodeInteger(msg.requestId),
      encodeInteger(msg.errorStatus ?? 0),
      encodeInteger(msg.errorIndex ?? 0),
      varbinds,
    ]),
  );
  return sequence(
    encodeInteger(msg.version === 'v1' ? 0 : 1),
    encodeOctetString(msg.community),
    pdu,
  );
}

/** Arma un GetRequest (o GetNextRequest) con valores NULL, como exige el protocolo. */
export function buildGetRequest(
  version: SnmpVersion,
  community: string,
  requestId: number,
  oids: string[],
  pduType: number = Tag.GetRequest,
): Buffer {
  return encodeMessage({
    version,
    community,
    pduType,
    requestId,
    varbinds: oids.map((oid) => ({ oid, value: { type: 'Null', value: null } })),
  });
}

// ---------------------------------------------------------------------------
// Decodificacion
// ---------------------------------------------------------------------------

function isPrintable(buf: Buffer): boolean {
  if (buf.length === 0) return true;
  for (const b of buf) {
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b < 0x20 || b === 0x7f) return false;
  }
  // Rechazar secuencias que no sean UTF-8 valido
  return !buf.toString('utf8').includes('�');
}

export function decodeValue(tag: number, value: Buffer): SnmpValue {
  switch (tag) {
    case Tag.Integer:
      return { type: 'Integer', value: decodeInteger(value) };
    case Tag.OctetString: {
      const hex = value.toString('hex');
      // Direcciones MAC (6 bytes binarios) y similares se muestran en hex
      const text = isPrintable(value)
        ? value.toString('utf8')
        : [...value].map((b) => b.toString(16).padStart(2, '0')).join(':');
      return { type: 'OctetString', value: text, hex };
    }
    case Tag.Null:
      return { type: 'Null', value: null };
    case Tag.ObjectIdentifier:
      return { type: 'ObjectIdentifier', value: decodeOid(value) };
    case Tag.IpAddress:
      return { type: 'IpAddress', value: [...value].join('.') };
    case Tag.Counter32:
      return { type: 'Counter32', value: decodeUnsigned(value).toString() };
    case Tag.Gauge32:
      return { type: 'Gauge32', value: decodeUnsigned(value).toString() };
    case Tag.TimeTicks:
      return { type: 'TimeTicks', value: decodeUnsigned(value).toString() };
    case Tag.Counter64:
      return { type: 'Counter64', value: decodeUnsigned(value).toString() };
    case Tag.Opaque:
      return { type: 'Opaque', value: value.toString('hex') };
    case Tag.NoSuchObject:
      return { type: 'NoSuchObject', value: null };
    case Tag.NoSuchInstance:
      return { type: 'NoSuchInstance', value: null };
    case Tag.EndOfMibView:
      return { type: 'EndOfMibView', value: null };
    default:
      throw new BerError(`Tipo SNMP no soportado: 0x${tag.toString(16)}`);
  }
}

export function decodeMessage(buf: Buffer): SnmpMessage {
  const root = expectTag(readTlv(buf), Tag.Sequence, 'SEQUENCE de mensaje');
  const [ver, comm, pdu] = readChildren(root.value);
  if (!ver || !comm || !pdu) throw new BerError('Mensaje SNMP incompleto');
  const versionNum = decodeInteger(expectTag(ver, Tag.Integer, 'version').value);
  if (versionNum !== 0 && versionNum !== 1) {
    throw new BerError(`Version SNMP no soportada: ${versionNum} (solo v1/v2c)`);
  }
  const community = expectTag(comm, Tag.OctetString, 'community').value.toString('utf8');
  if (pdu.tag < 0xa0 || pdu.tag > 0xa8) throw new BerError(`PDU desconocida 0x${pdu.tag.toString(16)}`);
  if (pdu.tag === Tag.Trap) throw new BerError('Traps SNMPv1 fuera del alcance implementado');

  const [reqId, errStatus, errIndex, vbList] = readChildren(pdu.value);
  if (!reqId || !errStatus || !errIndex || !vbList) throw new BerError('PDU incompleta');

  const varbinds: VarBind[] = readChildren(expectTag(vbList, Tag.Sequence, 'varbind list').value).map(
    (vb) => {
      const [name, val] = readChildren(expectTag(vb, Tag.Sequence, 'varbind').value);
      if (!name || !val) throw new BerError('Varbind incompleto');
      return {
        oid: decodeOid(expectTag(name, Tag.ObjectIdentifier, 'OID').value),
        value: decodeValue(val.tag, val.value),
      };
    },
  );

  return {
    version: versionNum === 0 ? 'v1' : 'v2c',
    community,
    pduType: pdu.tag,
    pduName: TagName[pdu.tag] ?? `0x${pdu.tag.toString(16)}`,
    requestId: decodeInteger(expectTag(reqId, Tag.Integer, 'request-id').value),
    errorStatus: decodeInteger(expectTag(errStatus, Tag.Integer, 'error-status').value),
    errorIndex: decodeInteger(expectTag(errIndex, Tag.Integer, 'error-index').value),
    varbinds,
  };
}

/** Compara OIDs arco por arco (orden lexicografico de la MIB). */
export function compareOid(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return pa.length - pb.length;
}
