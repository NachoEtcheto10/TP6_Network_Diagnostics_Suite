import { Stack, useLocalSearchParams } from 'expo-router';
import { useStore } from '@/lib/store';
import { fmtDate } from '@/lib/format';
import { KIND_LABEL } from '@/components/DiagnosticItem';
import { Badge, Card, Empty, Row, Screen, Terminal } from '@/components/ui';

export default function DiagnosticScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const d = useStore((s) => s.diagnostics[id]);
  const device = useStore((s) => (d?.deviceId ? s.devices[d.deviceId] : undefined));
  if (!d) {
    return (
      <Screen>
        <Empty text="Diagnóstico no encontrado." />
      </Screen>
    );
  }
  const data = d.data as Record<string, unknown> | null;
  const ssh = d.kind === 'ssh' && data ? (data as { command: string; stdout: string; stderr: string }) : null;
  // No mostrar el volcado hex completo en el JSON (ya esta en la pantalla SNMP)
  const json = JSON.stringify(data, (k, v) => (k === 'request' || k === 'response' ? `[${String(v).split('\n').length} lineas hex]` : v), 2);

  return (
    <Screen>
      <Stack.Screen options={{ title: KIND_LABEL[d.kind] }} />
      <Card title="Resumen" right={<Badge tone={d.ok ? 'ok' : 'err'} text={d.ok ? 'OK' : 'Error'} />}>
        <Row label="Fecha" value={fmtDate(d.createdAt)} />
        <Row label="Host" value={d.host} monoValue />
        <Row label="Equipo" value={device ? `${device.ip} ${device.hostname ?? ''}` : 'No asociado'} />
        <Row label="Resultado" value={d.summary} />
      </Card>
      {ssh && (
        <Card title="Salida">
          <Terminal text={`$ ${ssh.command}\n${ssh.stdout}${ssh.stderr ? `\n[stderr]\n${ssh.stderr}` : ''}`} />
        </Card>
      )}
      {data && (
        <Card title="Datos (disponibles offline)">
          <Terminal text={json} maxHeight={500} />
        </Card>
      )}
    </Screen>
  );
}
