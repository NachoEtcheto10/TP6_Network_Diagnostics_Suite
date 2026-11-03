import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Tag,
  decodeInteger,
  decodeLength,
  decodeOid,
  encodeInteger,
  encodeLength,
  encodeOid,
  readTlv,
} from '../src/snmp/ber.ts';
import { buildGetRequest, decodeMessage } from '../src/snmp/pdu.ts';
import { querySystem, queryInterfaces, snmpGet } from '../src/snmp/client.ts';
import { startSnmpSimulator } from '../src/snmp/simulator.ts';

test('BER: longitudes forma corta y larga', () => {
  assert.deepEqual([...encodeLength(5)], [0x05]);
  assert.deepEqual([...encodeLength(200)], [0x81, 0xc8]);
  assert.deepEqual([...encodeLength(300)], [0x82, 0x01, 0x2c]);
  assert.deepEqual(decodeLength(Buffer.from([0x82, 0x01, 0x2c]), 0), { length: 300, size: 3 });
});

test('BER: enteros con signo (complemento a dos)', () => {
  for (const n of [0, 1, 127, 128, 255, 256, -1, -128, -129, 2147483647, -2147483648]) {
    const t = readTlv(encodeInteger(n));
    assert.equal(t.tag, Tag.Integer);
    assert.equal(decodeInteger(t.value), n, `roundtrip de ${n}`);
  }
  assert.deepEqual([...encodeInteger(128)], [0x02, 0x02, 0x00, 0x80]);
  assert.deepEqual([...encodeInteger(-1)], [0x02, 0x01, 0xff]);
});

test('BER: OIDs (vector de RFC / X.690)', () => {
  // sysDescr.0 = 06 08 2b 06 01 02 01 01 01 00
  assert.equal(encodeOid('1.3.6.1.2.1.1.1.0').toString('hex'), '06082b06010201010100');
  // arcos > 127 usan base 128 multibyte
  const oid = '1.3.6.1.4.1.8072.3.2.10';
  assert.equal(decodeOid(readTlv(encodeOid(oid)).value), oid);
});

test('PDU: GetRequest identico al que genera net-snmp', () => {
  // snmpget -v2c -c public host sysDescr.0  con request-id 1
  const pkt = buildGetRequest('v2c', 'public', 1, ['1.3.6.1.2.1.1.1.0']);
  assert.equal(
    pkt.toString('hex'),
    '3026020101040670756' + '26c6963a019020101020100020100300e300c06082b060102010101000500',
  );
  const msg = decodeMessage(pkt);
  assert.equal(msg.version, 'v2c');
  assert.equal(msg.community, 'public');
  assert.equal(msg.pduName, 'GetRequest');
  assert.equal(msg.varbinds[0].oid, '1.3.6.1.2.1.1.1.0');
});

test('Cliente <-> agente simulado por UDP real', async () => {
  const sock = await startSnmpSimulator({ port: 0, community: 'public' });
  const port = (sock.address() as { port: number }).port;
  try {
    const sys = await querySystem({ host: '127.0.0.1', port });
    assert.equal(sys.system.sysName, 'nds-lab-ont01');
    assert.match(String(sys.system.sysUpTimeText), /^\d+d \d\d:\d\d:\d\d$/);
    assert.ok(sys.trace[0].response, 'debe registrar la respuesta en hex');

    const ifs = await queryInterfaces({ host: '127.0.0.1', port }, 300);
    assert.equal(ifs.interfaces.length, 5);
    assert.equal(ifs.interfaces[1].mac, 'a4:c3:f0:11:22:33');
    assert.equal(ifs.interfaces[3].operStatus, 'down');
    assert.ok((ifs.interfaces[1].inBps ?? 0) > 0, 'trafico calculado');

    // OID inexistente en v2c -> excepcion noSuchObject, no error
    const [vb] = await snmpGet({ host: '127.0.0.1', port }, ['1.3.6.1.2.1.99.0']);
    assert.equal(vb.value.type, 'NoSuchObject');

    // v1 -> error-status noSuchName
    await assert.rejects(
      snmpGet({ host: '127.0.0.1', port, version: 'v1' }, ['1.3.6.1.2.1.99.0']),
      /noSuchName/,
    );

    // community incorrecta -> el agente descarta -> timeout
    await assert.rejects(
      snmpGet({ host: '127.0.0.1', port, community: 'mala', timeoutMs: 200, retries: 0 }, ['1.3.6.1.2.1.1.5.0']),
      /Sin respuesta/,
    );
  } finally {
    sock.close();
  }
});
