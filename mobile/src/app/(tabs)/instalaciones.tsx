import { useMemo } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useStore } from '@/lib/store';
import { fmtDate } from '@/lib/format';
import { Badge, Button, C, Card, Empty, Muted, Screen } from '@/components/ui';

export default function InstallationsScreen() {
  const installations = useStore((s) => s.installations);
  const outbox = useStore((s) => s.outbox);
  const list = useMemo(() => Object.values(installations).sort((a, b) => b.updatedAt - a.updatedAt), [installations]);
  const pending = useMemo(() => new Set(outbox.filter((o) => o.entity === 'installation').map((o) => o.entityId)), [outbox]);

  return (
    <Screen>
      <Button title="Nueva instalación" icon="➕" onPress={() => router.push({ pathname: '/installation/[id]', params: { id: 'new' } })} />
      <Card title={`Instalaciones registradas (${list.length})`}>
        {list.length === 0 && <Empty text="Registrá una instalación con fotos, GPS y notas técnicas." />}
        {list.map((i) => (
          <Pressable
            key={i.id}
            onPress={() => router.push({ pathname: '/installation/[id]', params: { id: i.id } })}
            style={({ pressed }) => ({ flexDirection: 'row', gap: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: C.border, opacity: pressed ? 0.7 : 1 })}
          >
            {i.photos[0] ? (
              <Image source={{ uri: i.photos[0].dataUri }} style={{ width: 64, height: 64, borderRadius: 8 }} />
            ) : (
              <View style={{ width: 64, height: 64, borderRadius: 8, backgroundColor: '#E2E8F0', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 24 }}>📋</Text>
              </View>
            )}
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={{ fontWeight: '700', color: C.text }}>{i.siteName || 'Sin nombre'}</Text>
              <Muted>
                {i.client || 'Sin cliente'} · {i.photos.length} fotos · {i.location ? 'con GPS' : 'sin GPS'}
              </Muted>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                <Badge tone={i.status === 'completed' ? 'ok' : 'muted'} text={i.status === 'completed' ? 'Completada' : 'Borrador'} />
                {i.reportGeneratedAt && <Badge tone="info" text="PDF generado" />}
                <Badge tone={pending.has(i.id) ? 'warn' : 'ok'} text={pending.has(i.id) ? 'Pendiente de sync' : 'Sincronizada'} />
              </View>
              <Muted style={{ fontSize: 11 }}>Actualizada {fmtDate(i.updatedAt)}</Muted>
            </View>
          </Pressable>
        ))}
      </Card>
    </Screen>
  );
}
