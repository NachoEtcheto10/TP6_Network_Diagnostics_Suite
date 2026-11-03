import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { agent, type LocalInterface } from '@/lib/agent';
import { useAgentHealth } from '@/lib/hooks';
import { addDiagnostic, saveDevices } from '@/lib/outbox';
import { getState, setState, useStore } from '@/lib/store';
import { fmtDate, timeAgo } from '@/lib/format';
import type { Device } from '@/lib/types';
import { Badge, Button, C, Card, Chip, Empty, Muted, Notice, Screen, Wrap, mono } from '@/components/ui';

const ipNum = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);

export default function NetworkScreen() {
  const { health, error: agentError, check } = useAgentHealth();
  const devices = useStore((s) => s.devices);
  const lastScan = useStore((s) => s.lastScan);
  const [ifaces, setIfaces] = useState<LocalInterface[]>([]);
  const [iface, setIface] = useState<string | undefined>();
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!health) return;
    agent
      .interfaces()
      .then((list) => {
        setIfaces(list);
        setIface((cur) => cur ?? list[0]?.address);
      })
      .catch(() => {});
  }, [health]);

  const list = useMemo(
    () => Object.values(devices).sort((a, b) => ipNum(a.ip) - ipNum(b.ip)),
    [devices],
  );

  async function scan() {
    setScanning(true);
    setError(null);
    try {
      const r = await agent.scan(iface);
      const now = Date.now();
      const existing = getState().devices;
      const found: Device[] = r.devices.map((d) => {
        const id = d.mac ?? d.ip;
        const prev = existing[id] ?? Object.values(existing).find((x) => x.ip === d.ip && !x.mac);
        return {
          ...d,
          id,
          firstSeen: prev?.firstSeen ?? now,
          lastSeen: now,
          qrCode: prev?.qrCode ?? null,
          ficha: prev?.ficha ?? null,
          updatedAt: now,
        };
      });
      saveDevices(found);
      setState(() => ({
        lastScan: { at: now, iface: `${r.interface.name} (${r.interface.address})`, range: r.range, gateway: r.gateway, durationMs: r.durationMs, count: found.length },
      }));
      addDiagnostic({
        kind: 'scan',
        deviceId: null,
        host: r.interface.scanRange,
        ok: true,
        summary: `${found.length} equipos activos en ${r.range} (${(r.durationMs / 1000).toFixed(1)} s)`,
        data: { range: r.range, gateway: r.gateway, hostsProbed: r.hostsProbed, devices: found.map((d) => ({ ip: d.ip, mac: d.mac, hostname: d.hostname })) },
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanning(false);
    }
  }

  return (
    <Screen onRefresh={check}>
      {!health && (
        <Notice
          tone="err"
          text={`Agente de red no disponible (${agentError ?? '...'}). Iniciá el agente en la PC: "cd server && npm start". Los datos guardados siguen disponibles offline.`}
        />
      )}

      <Card
        title="Escaneo de la red local"
        right={health ? <Badge tone="ok" text="Agente conectado" /> : <Badge tone="err" text="Agente offline" />}
      >
        <Muted>
          Barrido de la subred con sondas TCP/UDP (fuerza la resolución ARP), lectura de la tabla ARP, mDNS/Bonjour, NetBIOS y DNS inverso.
        </Muted>
        {ifaces.length > 0 && (
          <>
            <Text style={{ fontSize: 12, color: C.muted, fontWeight: '600', marginTop: 4 }}>Interfaz</Text>
            <Wrap>
              {ifaces.map((i) => (
                <Chip
                  key={i.address}
                  label={`${i.name} · ${i.scanRange}${i.likelyVpn ? ' (VPN)' : ''}`}
                  selected={iface === i.address}
                  onPress={() => setIface(i.address)}
                />
              ))}
            </Wrap>
          </>
        )}
        <Button title={scanning ? 'Escaneando… (~5-10 s)' : 'Escanear red'} icon="📡" onPress={scan} loading={scanning} disabled={!health} />
        {error && <Notice tone="err" text={error} />}
        {lastScan && (
          <Muted>
            Último escaneo {timeAgo(lastScan.at)} · {lastScan.iface} · rango {lastScan.range} · gateway {lastScan.gateway ?? '?'} ·{' '}
            {lastScan.count} equipos en {(lastScan.durationMs / 1000).toFixed(1)} s
          </Muted>
        )}
      </Card>

      <Card title={`Equipos (${list.length})`}>
        {list.length === 0 && <Empty text="Todavía no se escaneó la red." />}
        {list.map((d) => {
          const stale = lastScan && d.lastSeen < lastScan.at;
          return (
            <Pressable
              key={d.id}
              onPress={() => router.push({ pathname: '/device/[id]', params: { id: d.id } })}
              style={({ pressed }) => ({
                paddingVertical: 10,
                borderTopWidth: 1,
                borderTopColor: C.border,
                opacity: stale ? 0.5 : pressed ? 0.7 : 1,
              })}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Text style={{ fontFamily: mono, fontWeight: '700', fontSize: 15, color: C.text }}>{d.ip}</Text>
                {d.isGateway && <Badge tone="info" text="Gateway" />}
                {d.isSelf && <Badge tone="muted" text="Este equipo (agente)" />}
                {d.qrCode && <Badge tone="ok" text={`QR ${d.qrCode}`} />}
                {stale && <Badge tone="warn" text={`no visto ${timeAgo(d.lastSeen)}`} />}
              </View>
              <Text style={{ color: C.text, marginTop: 2 }}>{d.hostname ?? 'Sin hostname'}</Text>
              <Muted>
                {d.mac ?? 'MAC desconocida'}
                {d.vendor ? ` · ${d.vendor}` : ''}
                {d.openPorts.length ? ` · puertos ${d.openPorts.map((p) => `${p.port}/${p.service}`).join(', ')}` : ''}
              </Muted>
              {d.services.length > 0 && <Muted>mDNS: {d.services.slice(0, 3).join(' · ')}</Muted>}
              <Muted style={{ fontSize: 11 }}>
                Detectado por: {d.sources.join(', ')} · visto {fmtDate(d.lastSeen)}
              </Muted>
            </Pressable>
          );
        })}
      </Card>
    </Screen>
  );
}
