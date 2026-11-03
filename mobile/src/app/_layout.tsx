import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { loadState, useStore } from '@/lib/store';
import { startSyncEngine } from '@/lib/outbox';
import { C } from '@/components/ui';

export default function RootLayout() {
  const ready = useStore((s) => s.ready);

  useEffect(() => {
    loadState().then(startSyncEngine);
  }, []);

  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.header }}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: C.header },
          headerTintColor: '#fff',
          headerTitleStyle: { fontWeight: '700' },
          contentStyle: { backgroundColor: C.bg },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="device/[id]" options={{ title: 'Equipo' }} />
        <Stack.Screen name="installation/[id]" options={{ title: 'Instalación' }} />
        <Stack.Screen name="diagnostic/[id]" options={{ title: 'Diagnóstico' }} />
        <Stack.Screen name="scanner" options={{ title: 'Cámara', presentation: 'modal' }} />
      </Stack>
    </>
  );
}
