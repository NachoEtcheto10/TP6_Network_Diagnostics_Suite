import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { PacketTrace as Trace } from '@/lib/agent';
import { C, Muted, Terminal } from './ui';

/** Muestra los paquetes SNMP crudos (hex) enviados y recibidos por el agente. */
export function PacketTrace({ trace }: { trace: Trace[] | undefined }) {
  const [open, setOpen] = useState(false);
  if (!trace?.length) return null;
  return (
    <View>
      <Pressable onPress={() => setOpen(!open)}>
        <Text style={{ color: C.primary, fontWeight: '600', fontSize: 13 }}>
          {open ? '▾' : '▸'} Paquetes SNMP en crudo ({trace.length} PDU{trace.length > 1 ? 's' : ''})
        </Text>
      </Pressable>
      {open &&
        trace.map((t, i) => (
          <View key={i} style={{ marginTop: 8, gap: 4 }}>
            <Muted>
              #{i + 1} {t.pdu} · request-id {t.requestId} · {t.response ? `RTT ${t.rttMs} ms` : 'sin respuesta (timeout)'}
            </Muted>
            <Terminal text={`>> ${t.pdu} (UDP)\n${t.request}${t.response ? `\n\n<< GetResponse\n${t.response}` : ''}`} maxHeight={220} />
          </View>
        ))}
    </View>
  );
}
