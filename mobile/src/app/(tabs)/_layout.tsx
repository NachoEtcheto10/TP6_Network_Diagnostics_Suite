import { Text } from 'react-native';
import { Tabs } from 'expo-router/js-tabs';
import { SyncPill } from '@/components/SyncPill';
import { C } from '@/components/ui';

const icon = (glyph: string) =>
  function TabIcon({ focused }: { focused: boolean }) {
    return <Text style={{ fontSize: 18, opacity: focused ? 1 : 0.55 }}>{glyph}</Text>;
  };

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: C.header },
        headerTintColor: '#fff',
        headerTitleStyle: { fontWeight: '700' },
        headerRight: () => <SyncPill />,
        tabBarActiveTintColor: C.primary,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        sceneStyle: { backgroundColor: C.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Red', headerTitle: 'Descubrimiento de red', tabBarIcon: icon('📡') }} />
      <Tabs.Screen name="snmp" options={{ title: 'SNMP', headerTitle: 'Consulta SNMP', tabBarIcon: icon('📊') }} />
      <Tabs.Screen name="ssh" options={{ title: 'SSH', headerTitle: 'Diagnóstico SSH', tabBarIcon: icon('⌨️') }} />
      <Tabs.Screen name="instalaciones" options={{ title: 'Instalaciones', tabBarIcon: icon('📋') }} />
      <Tabs.Screen name="historial" options={{ title: 'Historial', tabBarIcon: icon('🕘') }} />
      <Tabs.Screen name="sync" options={{ title: 'Sync', headerTitle: 'Sincronización', tabBarIcon: icon('🔄') }} />
    </Tabs>
  );
}
