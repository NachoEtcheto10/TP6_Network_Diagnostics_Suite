import { useMemo, useState } from 'react';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { agent } from '@/lib/agent';
import { fmtDate } from '@/lib/format';
import { updateDevice } from '@/lib/outbox';
import { awaitScannerResult } from '@/lib/scannerBus';
import { useStore } from '@/lib/store';
import type { Ficha } from '@/lib/types';
import { DiagnosticItem } from '@/components/DiagnosticItem';
import { Badge, Button, Card, Empty, Muted, Notice, Row, Screen, Wrap } from '@/components/ui';

export default function DeviceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const device = useStore((s) => s.devices[id]);
  const diagnostics = useStore((s) => s.diagnostics);
  const outbox = useStore((s) => s.outbox);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null);

  const history = useMemo(
    () =>
      Object.values(diagnostics)
        .filter((d) => d.deviceId === id || (device && d.host.split(':')[0] === device.ip && d.kind !== 'scan'))
        .sort((a, b) => b.createdAt - a.createdAt),
    [diagnostics, id, device],
  );
  const pendingIds = useMemo(() => new Set(outbox.map((o) => o.entityId)), [outbox]);

  if (!device) {
    return (
      <Screen>
        <Empty text="Equipo no encontrado." />
      </Screen>
    );
  }

  async function fetchFicha(code: string) {
    setBusy(true);
    try {
      const ficha = (await agent.ficha(code)) as Ficha;
      updateDevice(device.id, { qrCode: code, ficha });
      setMsg({ tone: 'ok', text: `Equipo asociado a la ficha ${code}.` });
    } catch (e) {
      updateDevice(device.id, { qrCode: code });
      setMsg({ tone: 'warn', text: `Código guardado. Ficha no disponible: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  async function scanQr() {
    const wait = awaitScannerResult();
    router.push({ pathname: '/scanner', params: { mode: 'code' } });
    const r = await wait;
    if (r?.kind === 'code') await fetchFicha(r.data.trim());
  }

  const ficha = device.ficha;

  return (
    <Screen>
      <Stack.Screen options={{ title: device.hostname?.split('.')[0] ?? device.ip }} />
      <Card title="Identificación">
        <Wrap>
          {device.isGateway && <Badge tone="info" text="Gateway" />}
          {device.isSelf && <Badge tone="muted" text="Equipo del agente" />}
          {pendingIds.has(device.id) && <Badge tone="warn" text="Pendiente de sync" />}
        </Wrap>
        <Row label="IP" value={device.ip} monoValue />
        <Row label="MAC" value={device.mac} monoValue />
        <Row label="Fabricante" value={device.vendor} />
        <Row label="Hostnames" value={device.hostnames.join('\n')} />
        <Row label="Puertos abiertos" value={device.openPorts.map((p) => `${p.port}/${p.service}`).join(', ')} />
        <Row label="Servicios mDNS" value={device.services.join('\n')} />
        <Row label="RTT" value={device.rttMs != null ? `${device.rttMs} ms` : null} />
        <Row label="Detectado por" value={device.sources.join(', ')} />
        <Row label="Primera vez" value={fmtDate(device.firstSeen)} />
        <Row label="Última vez" value={fmtDate(device.lastSeen)} />
      </Card>

      <Card title="Acciones">
        <Wrap>
          <Button title="Consultar SNMP" icon="📊" onPress={() => router.navigate({ pathname: '/snmp', params: { host: device.ip } })} />
          <Button
            title="Diagnóstico SSH"
            icon="⌨️"
            variant="secondary"
            onPress={() => router.navigate({ pathname: '/ssh', params: { host: device.ip } })}
          />
        </Wrap>
      </Card>

      <Card title="Ficha técnica (QR)">
        {device.qrCode ? <Row label="Código" value={device.qrCode} monoValue /> : <Muted>Escaneá la etiqueta QR/código de barras del equipo.</Muted>}
        {ficha && (
          <>
            <Row label="Tipo" value={ficha.tipo as string} />
            <Row label="Modelo" value={ficha.modelo as string} />
            <Row label="Fabricante" value={ficha.fabricante as string} />
            <Row label="Serie" value={ficha.serie as string} />
            <Row label="Firmware" value={ficha.firmware as string} />
            <Row label="Notas" value={ficha.notas as string} />
          </>
        )}
        <Wrap>
          <Button title={device.qrCode ? 'Re-escanear QR' : 'Escanear QR'} icon="🔳" variant="secondary" onPress={scanQr} loading={busy} />
          {device.qrCode && !ficha && <Button title="Reintentar ficha" variant="ghost" onPress={() => fetchFicha(device.qrCode!)} />}
        </Wrap>
        {msg && <Notice tone={msg.tone} text={msg.text} />}
      </Card>

      <Card title={`Historial de diagnósticos (${history.length})`}>
        {history.length === 0 && <Empty text="Sin diagnósticos para este equipo." />}
        {history.map((d) => (
          <DiagnosticItem key={d.id} d={d} pending={pendingIds.has(d.id)} />
        ))}
      </Card>
    </Screen>
  );
}
