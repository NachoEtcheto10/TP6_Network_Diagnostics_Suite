import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSyncStatus } from '@/lib/hooks';
import { useStore } from '@/lib/store';

/** Indicador de conectividad + operaciones pendientes en la cabecera. */
export function SyncPill() {
  const st = useSyncStatus();
  const outbox = useStore((s) => s.outbox);
  const pending = outbox.length;
  const offline = !st.canSync;
  const color = offline ? '#F87171' : st.backendReachable === false ? '#FBBF24' : '#4ADE80';
  const label = offline
    ? st.forcedOffline
      ? 'Sin conexión (simulado)'
      : 'Sin conexión'
    : st.flushing
      ? 'Sincronizando…'
      : st.backendReachable === false
        ? 'Backend caído'
        : 'En línea';
  return (
    <Pressable onPress={() => router.navigate('/sync')} style={{ marginRight: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#1E293B', paddingVertical: 5, paddingHorizontal: 10, borderRadius: 99 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
        <Text style={{ color: '#E2E8F0', fontSize: 12, fontWeight: '600' }}>
          {label}
          {pending ? ` · ${pending} en cola` : ''}
        </Text>
      </View>
    </Pressable>
  );
}
