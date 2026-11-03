import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { agent, AgentError, type PacketTrace as Trace, type SnmpInterfacesResult, type SnmpSystemResult } from '@/lib/agent';
import { useAgentHealth } from '@/lib/hooks';
import { addDiagnostic } from '@/lib/outbox';
import { getState } from '@/lib/store';
import { fmtBps, fmtBytes } from '@/lib/format';
import { PacketTrace } from '@/components/PacketTrace';
import { Badge, Button, C, Card, Chip, Field, Muted, Notice, Row, Screen, Wrap, mono } from '@/components/ui';

function deviceIdFor(host: string) {
  return Object.values(getState().devices).find((d) => d.ip === host)?.id ?? null;
}

export default function SnmpScreen() {
  const params = useLocalSearchParams<{ host?: string; port?: string }>();
  const { health } = useAgentHealth();
  const [host, setHost] = useState(params.host ?? '');
  const [port, setPort] = useState(params.port ?? '161');
  const [community, setCommunity] = useState('public');
  const [version, setVersion] = useState<'v1' | 'v2c'>('v2c');
  const [busy, setBusy] = useState<'sys' | 'if' | null>(null);
  const [sys, setSys] = useState<SnmpSystemResult | null>(null);
  const [ifs, setIfs] = useState<SnmpInterfacesResult | null>(null);
  const [error, setError] = useState<{ msg: string; trace?: Trace[] } | null>(null);

  useEffect(() => {
    if (params.host) setHost(params.host);
    if (params.port) setPort(params.port);
  }, [params.host, params.port]);

  const target = () => ({ host: host.trim(), port: Number(port) || 161, community, version });

  async function run(kind: 'sys' | 'if') {
    if (!host.trim()) return setError({ msg: 'Ingresá la IP del equipo' });
    setBusy(kind);
    setError(null);
    const t = target();
    try {
      if (kind === 'sys') {
        const r = await agent.snmpSystem(t);
        setSys(r);
        addDiagnostic({
          kind: 'snmp-system',
          deviceId: deviceIdFor(t.host),
          host: `${t.host}:${t.port}`,
          ok: true,
          summary: `${r.system.sysName ?? '?'} · uptime ${r.system.sysUpTimeText ?? '?'}`,
          data: r,
        });
      } else {
        const r = await agent.snmpInterfaces({ ...t, sampleMs: 2000 });
        setIfs(r);
        const up = r.interfaces.filter((i) => i.operStatus === 'up').length;
        addDiagnostic({
          kind: 'snmp-interfaces',
          deviceId: deviceIdFor(t.host),
          host: `${t.host}:${t.port}`,
          ok: true,
          summary: `${r.interfaces.length} interfaces (${up} up)`,
          data: r,
        });
      }
    } catch (e) {
      const err = e as AgentError;
      setError({ msg: err.message, trace: err.trace });
      addDiagnostic({ kind: kind === 'sys' ? 'snmp-system' : 'snmp-interfaces', deviceId: deviceIdFor(t.host), host: `${t.host}:${t.port}`, ok: false, summary: err.message, data: null });
    } finally {
      setBusy(null);
    }
  }

  const sim = health?.simulators.snmp;

  return (
    <Screen>
      <Card title="Equipo objetivo">
        <Wrap>
          <Field label="IP / host" value={host} onChangeText={setHost} placeholder="192.168.0.1" keyboardType="numbers-and-punctuation" />
          <Field label="Puerto UDP" value={port} onChangeText={setPort} keyboardType="number-pad" style={{ maxWidth: 110 }} />
          <Field label="Community" value={community} onChangeText={setCommunity} />
        </Wrap>
        <Wrap>
          <Text style={{ color: C.muted, fontSize: 12, fontWeight: '600' }}>Versión</Text>
          <Chip label="v2c" selected={version === 'v2c'} onPress={() => setVersion('v2c')} />
          <Chip label="v1" selected={version === 'v1'} onPress={() => setVersion('v1')} />
          {sim && health && (
            <Button
              small
              variant="ghost"
              title={`Usar equipo simulado (${health.lanAddress}:${sim.port})`}
              onPress={() => {
                setHost(health.lanAddress);
                setPort(String(sim.port));
                setCommunity(sim.community);
              }}
            />
          )}
        </Wrap>
        <Wrap>
          <Button title="Consultar sistema" icon="🛈" onPress={() => run('sys')} loading={busy === 'sys'} disabled={!!busy} />
          <Button title="Tráfico de interfaces" icon="📈" variant="secondary" onPress={() => run('if')} loading={busy === 'if'} disabled={!!busy} />
        </Wrap>
        <Muted>
          GetRequest/GetNextRequest SNMP {version} armados a mano (BER/ASN.1) y enviados por UDP. OIDs MIB-II: system (1.3.6.1.2.1.1) e ifTable (1.3.6.1.2.1.2.2).
        </Muted>
        {error && (
          <>
            <Notice tone="err" text={error.msg} />
            <PacketTrace trace={error.trace} />
          </>
        )}
      </Card>

      {sys && (
        <Card title="Grupo system (MIB-II)" right={<Badge tone="ok" text="GetResponse OK" />}>
          <Row label="sysName" value={sys.system.sysName} />
          <Row label="sysUpTime" value={`${sys.system.sysUpTimeText ?? '—'}  (${sys.system.sysUpTime ?? '?'} ticks)`} />
          <Row label="sysDescr" value={sys.system.sysDescr} />
          <Row label="sysObjectID" value={sys.system.sysObjectID} monoValue />
          <Row label="sysContact" value={sys.system.sysContact} />
          <Row label="sysLocation" value={sys.system.sysLocation} />
          <View style={{ marginTop: 6 }}>
            {sys.varbinds.map((v) => (
              <Text key={v.oid} style={{ fontFamily: mono, fontSize: 11, color: C.muted }} selectable>
                {v.oid} = {v.type}: {String(v.value)}
              </Text>
            ))}
          </View>
          <PacketTrace trace={sys.trace} />
        </Card>
      )}

      {ifs && (
        <Card title={`Interfaces (${ifs.interfaces.length})`} right={<Muted>muestra de {ifs.sampleMs / 1000} s</Muted>}>
          {ifs.interfaces.map((i) => (
            <View key={i.index} style={{ borderTopWidth: 1, borderTopColor: C.border, paddingTop: 8, gap: 2 }}>
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                <Text style={{ fontWeight: '700', color: C.text }}>
                  #{i.index} {i.descr}
                </Text>
                <Badge tone={i.operStatus === 'up' ? 'ok' : 'err'} text={i.operStatus} />
              </View>
              <Text style={{ fontFamily: mono, fontSize: 13, color: C.text }}>
                ↓ {fmtBps(i.inBps)}   ↑ {fmtBps(i.outBps)}
              </Text>
              <Muted>
                In {fmtBytes(i.inOctets)} · Out {fmtBytes(i.outOctets)} · Errores {i.inErrors ?? '?'}/{i.outErrors ?? '?'} · Vel. {fmtBps(i.speed)}
                {i.mac ? ` · ${i.mac}` : ''}
              </Muted>
            </View>
          ))}
          <PacketTrace trace={ifs.trace} />
        </Card>
      )}
    </Screen>
  );
}
