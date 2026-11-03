import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { fmtDate } from '@/lib/format';
import type { Diagnostic } from '@/lib/types';
import { Badge, C, Muted } from './ui';

export const KIND_LABEL: Record<Diagnostic['kind'], string> = {
  scan: 'Escaneo LAN',
  'snmp-system': 'SNMP sistema',
  'snmp-interfaces': 'SNMP interfaces',
  ssh: 'SSH',
};

export function DiagnosticItem({ d, pending }: { d: Diagnostic; pending?: boolean }) {
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/diagnostic/[id]', params: { id: d.id } })}
      style={({ pressed }) => ({ paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.border, opacity: pressed ? 0.7 : 1, gap: 3 })}
    >
      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge tone={d.ok ? 'ok' : 'err'} text={d.ok ? 'OK' : 'Error'} />
        <Text style={{ fontWeight: '700', color: C.text }}>{KIND_LABEL[d.kind]}</Text>
        <Muted>{d.host}</Muted>
        {pending && <Badge tone="warn" text="sin sincronizar" />}
      </View>
      <Text style={{ color: C.text, fontSize: 13 }} numberOfLines={2}>
        {d.summary}
      </Text>
      <Muted style={{ fontSize: 11 }}>{fmtDate(d.createdAt)}</Muted>
    </Pressable>
  );
}
