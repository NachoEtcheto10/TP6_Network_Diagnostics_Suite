import { useState } from 'react';
import { Platform, Switch, Text, View } from 'react-native';
import { useAgentHealth, useSyncStatus, useTick } from '@/lib/hooks';
import { discardOp, flush, retryOp, setForceOffline } from '@/lib/outbox';
import { clearLocalData, defaultAgentUrl, setState, useStore } from '@/lib/store';
import { fmtBytes, fmtDate, timeAgo } from '@/lib/format';
import type { OutboxOp, SyncLogEntry } from '@/lib/types';
import { Badge, Button, C, Card, Empty, Field, Muted, Notice, Row, Screen, Wrap, mono } from '@/components/ui';

const ENTITY_LABEL = { device: 'Equipo', diagnostic: 'Diagnóstico', installation: 'Instalación', report: 'Reporte PDF' } as const;

const STATUS_TONE: Record<OutboxOp['status'], 'warn' | 'info' | 'err' | 'muted'> = {
  pending: 'muted',
  syncing: 'info',
  retrying: 'warn',
  failed: 'err',
};

const RESULT_TONE: Record<SyncLogEntry['result'], 'ok' | 'warn' | 'err' | 'info'> = {
  applied: 'ok',
  duplicate: 'info',
  conflict: 'warn',
  rejected: 'err',
  error: 'err',
};

export default function SyncScreen() {
  useTick(1000);
  const st = useSyncStatus();
  const { health, check } = useAgentHealth();
  const outbox = useStore((s) => s.outbox);
  const log = useStore((s) => s.syncLog);
  const settings = useStore((s) => s.settings);
  const lastSyncAt = useStore((s) => s.lastSyncAt);
  const [url, setUrl] = useState(settings.agentUrl);
  const totalBytes = outbox.reduce((a, o) => a + o.bytes, 0);

  return (
    <Screen>
      <Card title="Estado de conectividad">
        <Row
          label="Red del dispositivo"
          value={
            <Badge
              tone={st.networkConnected === false ? 'err' : 'ok'}
              text={st.networkConnected === false ? 'Sin conexión' : `Conectado (${st.networkType})`}
            />
          }
        />
        <Row
          label="Backend"
          value={<Badge tone={health ? 'ok' : 'err'} text={health ? 'Alcanzable' : 'No alcanzable'} />}
        />
        <Row label="Última sync" value={lastSyncAt ? `${fmtDate(lastSyncAt)} (${timeAgo(lastSyncAt)})` : 'nunca'} />
        {st.lastError && <Row label="Último error" value={st.lastError} />}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 }}>
          <Switch value={settings.forceOffline} onValueChange={setForceOffline} />
          <Text style={{ color: C.text, flex: 1, fontWeight: '600' }}>Modo sin conexión (simular sitio sin cobertura)</Text>
        </View>
        <Muted>
          Con el modo activado la app sigue funcionando y todo se encola. Al desactivarlo (o al volver la red real), la cola se vacía automáticamente.
          {Platform.OS === 'web' ? ' También podés cortar la red real (Wi-Fi o DevTools → Network → Offline).' : ''}
        </Muted>
      </Card>

      <Card
        title={`Cola de salida / outbox (${outbox.length})`}
        right={<Muted>{fmtBytes(totalBytes)}</Muted>}
      >
        <Wrap>
          <Button title="Sincronizar ahora" icon="🔄" onPress={() => flush('manual')} loading={st.flushing} disabled={!st.canSync || outbox.length === 0} />
        </Wrap>
        {!st.canSync && outbox.length > 0 && <Notice tone="warn" text="Sin conexión: las operaciones quedan guardadas y se enviarán al reconectar." />}
        {outbox.length === 0 && <Empty text="No hay operaciones pendientes. Todo está sincronizado ✔" />}
        {[...outbox]
          .sort((a, b) => a.createdAt - b.createdAt)
          .map((o) => (
            <View key={o.opId} style={{ borderTopWidth: 1, borderTopColor: C.border, paddingTop: 8, gap: 3 }}>
              <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <Badge tone={STATUS_TONE[o.status]} text={o.status} />
                <Text style={{ fontWeight: '700', color: C.text }}>
                  {o.action === 'delete' ? 'Baja ' : ''}
                  {ENTITY_LABEL[o.entity]}
                </Text>
                <Text style={{ fontFamily: mono, fontSize: 11, color: C.muted }}>{o.entityId.slice(0, 8)}</Text>
                <Muted>{fmtBytes(o.bytes)}</Muted>
              </View>
              <Muted>
                Encolada {timeAgo(o.createdAt)} · intentos {o.attempts}
                {o.status === 'retrying' ? ` · próximo reintento ${timeAgo(o.nextAttemptAt)}` : ''}
              </Muted>
              {o.lastError && <Text style={{ color: C.err, fontSize: 12 }}>{o.lastError}</Text>}
              {(o.status === 'failed' || o.status === 'retrying') && (
                <Wrap>
                  <Button small variant="ghost" title="Reintentar" onPress={() => retryOp(o.opId)} />
                  {o.status === 'failed' && <Button small variant="ghost" title="Descartar" onPress={() => discardOp(o.opId)} />}
                </Wrap>
              )}
            </View>
          ))}
      </Card>

      <Card title="Registro de sincronización">
        {log.length === 0 && <Empty text="Sin actividad todavía." />}
        {log.slice(0, 30).map((l, i) => (
          <View key={`${l.opId}-${i}`} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingVertical: 3 }}>
            <Badge tone={RESULT_TONE[l.result]} text={l.result} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: C.text, fontSize: 13 }}>
                {ENTITY_LABEL[l.entity]} <Text style={{ fontFamily: mono, color: C.muted, fontSize: 11 }}>{l.entityId.slice(0, 8)}</Text>
              </Text>
              {l.detail && <Muted>{l.detail}</Muted>}
            </View>
            <Muted>{timeAgo(l.at)}</Muted>
          </View>
        ))}
      </Card>

      <Card title="Ajustes">
        <Field label="Técnico (para los reportes)" value={settings.technician} onChangeText={(v) => setState((s) => ({ settings: { ...s.settings, technician: v } }))} autoCapitalize="words" />
        <Field label="URL del agente / backend" value={url} onChangeText={setUrl} hint={`Por defecto: ${defaultAgentUrl()}`} />
        <Wrap>
          <Button
            small
            title="Guardar URL y probar"
            onPress={() => {
              setState((s) => ({ settings: { ...s.settings, agentUrl: url.trim() } }));
              setTimeout(check, 50);
            }}
          />
          <Button
            small
            variant="danger"
            title="Borrar datos locales"
            onPress={() => {
              const ok = Platform.OS === 'web' ? window.confirm('¿Borrar equipos, diagnósticos, instalaciones y la cola local?') : true;
              if (ok) void clearLocalData();
            }}
          />
        </Wrap>
        <Muted>ID de este cliente: {settings.clientId.slice(0, 8)} · Panel del backend: {settings.agentUrl}/</Muted>
      </Card>
    </Screen>
  );
}
