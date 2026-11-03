import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useStore } from '@/lib/store';
import { fmtDate } from '@/lib/format';
import type { Diagnostic } from '@/lib/types';
import { DiagnosticItem } from '@/components/DiagnosticItem';
import { Badge, C, Card, Empty, Field, Muted, Notice, Screen, Segmented } from '@/components/ui';

type View_ = 'equipos' | 'sitios' | 'todos';

export default function HistoryScreen() {
  const devices = useStore((s) => s.devices);
  const diagnostics = useStore((s) => s.diagnostics);
  const installations = useStore((s) => s.installations);
  const outbox = useStore((s) => s.outbox);
  const [view, setView] = useState<View_>('equipos');
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const pendingIds = useMemo(() => new Set(outbox.map((o) => o.entityId)), [outbox]);

  const all = useMemo(() => Object.values(diagnostics).sort((a, b) => b.createdAt - a.createdAt), [diagnostics]);
  const matches = (d: Diagnostic) => !query || `${d.host} ${d.summary} ${d.kind}`.toLowerCase().includes(query);

  const byDevice = useMemo(() => {
    const map = new Map<string, Diagnostic[]>();
    for (const d of all) {
      if (d.kind === 'scan') continue;
      const dev = d.deviceId ?? Object.values(devices).find((x) => x.ip === d.host.split(':')[0])?.id ?? `host:${d.host.split(':')[0]}`;
      if (!map.has(dev)) map.set(dev, []);
      map.get(dev)!.push(d);
    }
    return [...map.entries()];
  }, [all, devices]);

  const sites = useMemo(() => Object.values(installations).sort((a, b) => b.updatedAt - a.updatedAt), [installations]);

  return (
    <Screen>
      <Notice tone="info" text="Todo el historial se lee del almacenamiento local: se puede consultar sin conexión." />
      <Segmented<View_>
        value={view}
        onChange={setView}
        options={[
          { value: 'equipos', label: 'Por equipo' },
          { value: 'sitios', label: 'Por sitio' },
          { value: 'todos', label: `Todos (${all.length})` },
        ]}
      />
      <Field label="Buscar" value={q} onChangeText={setQ} placeholder="IP, hostname, sitio, comando…" />

      {view === 'equipos' &&
        (byDevice.length === 0 ? (
          <Empty text="Sin diagnósticos SNMP/SSH todavía." />
        ) : (
          byDevice.map(([devId, list]) => {
            const dev = devices[devId];
            const title = dev ? `${dev.ip} · ${dev.hostname?.split('.')[0] ?? dev.mac ?? ''}` : devId.replace('host:', '');
            const filtered = list.filter((d) => matches(d) || title.toLowerCase().includes(query));
            if (filtered.length === 0) return null;
            return (
              <Card
                key={devId}
                title={title}
                right={
                  dev ? (
                    <Pressable onPress={() => router.push({ pathname: '/device/[id]', params: { id: dev.id } })}>
                      <Text style={{ color: C.primary, fontWeight: '600' }}>Ver equipo ›</Text>
                    </Pressable>
                  ) : undefined
                }
              >
                {filtered.slice(0, 8).map((d) => (
                  <DiagnosticItem key={d.id} d={d} pending={pendingIds.has(d.id)} />
                ))}
                {filtered.length > 8 && <Muted>… y {filtered.length - 8} más</Muted>}
              </Card>
            );
          })
        ))}

      {view === 'sitios' &&
        (sites.length === 0 ? (
          <Empty text="Sin instalaciones registradas." />
        ) : (
          sites
            .filter((s) => !query || `${s.siteName} ${s.client} ${s.address}`.toLowerCase().includes(query))
            .map((s) => {
              const diags = all.filter((d) => d.deviceId && s.deviceIds.includes(d.deviceId) && d.kind !== 'scan');
              return (
                <Card
                  key={s.id}
                  title={s.siteName}
                  right={
                    <Pressable onPress={() => router.push({ pathname: '/installation/[id]', params: { id: s.id } })}>
                      <Text style={{ color: C.primary, fontWeight: '600' }}>Abrir ›</Text>
                    </Pressable>
                  }
                >
                  <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                    <Badge tone={s.status === 'completed' ? 'ok' : 'muted'} text={s.status === 'completed' ? 'Completada' : 'Borrador'} />
                    <Badge tone="info" text={`${s.deviceIds.length} equipos`} />
                    <Badge tone="info" text={`${s.photos.length} fotos`} />
                  </View>
                  <Muted>
                    {s.client} · {s.address} · {fmtDate(s.updatedAt)}
                  </Muted>
                  {diags.slice(0, 6).map((d) => (
                    <DiagnosticItem key={d.id} d={d} pending={pendingIds.has(d.id)} />
                  ))}
                  {diags.length === 0 && <Muted>Sin diagnósticos de los equipos asociados.</Muted>}
                </Card>
              );
            })
        ))}

      {view === 'todos' && (
        <Card>
          {all.filter(matches).length === 0 && <Empty text="Sin resultados." />}
          {all
            .filter(matches)
            .slice(0, 100)
            .map((d) => (
              <DiagnosticItem key={d.id} d={d} pending={pendingIds.has(d.id)} />
            ))}
        </Card>
      )}
    </Screen>
  );
}
