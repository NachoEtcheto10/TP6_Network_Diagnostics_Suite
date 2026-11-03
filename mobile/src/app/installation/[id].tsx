import { useEffect, useMemo, useState } from 'react';
import { Alert, Image, Platform, Pressable, Text, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { agent } from '@/lib/agent';
import { formatCoords, getLocation, pickPhotoFromLibrary, processPhoto } from '@/lib/evidence';
import { fmtDate } from '@/lib/format';
import { deleteInstallation, recordReport, saveInstallation } from '@/lib/outbox';
import { buildReportHtml, exportPdf } from '@/lib/report';
import { awaitScannerResult } from '@/lib/scannerBus';
import { getState, useStore, uuid } from '@/lib/store';
import type { Ficha, Installation } from '@/lib/types';
import { Badge, Button, C, Card, Chip, Field, Muted, Notice, Row, Screen, Wrap } from '@/components/ui';

function blank(technician: string): Installation {
  const now = Date.now();
  return {
    id: uuid(),
    siteName: '',
    client: '',
    address: '',
    technician,
    equipmentCode: null,
    ficha: null,
    deviceIds: [],
    notes: '',
    location: null,
    photos: [],
    status: 'draft',
    reportGeneratedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function confirm(msg: string): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(window.confirm(msg));
  return new Promise((r) =>
    Alert.alert('Confirmar', msg, [
      { text: 'Cancelar', style: 'cancel', onPress: () => r(false) },
      { text: 'Sí', style: 'destructive', onPress: () => r(true) },
    ]),
  );
}

export default function InstallationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const stored = useStore((s) => (id && id !== 'new' ? s.installations[id] : undefined));
  const technician = useStore((s) => s.settings.technician);
  const devices = useStore((s) => s.devices);
  const diagnostics = useStore((s) => s.diagnostics);
  const outbox = useStore((s) => s.outbox);
  const [draft, setDraft] = useState<Installation>(() => stored ?? blank(technician));
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err' | 'warn' | 'info'; text: string } | null>(null);
  const isNew = !stored;
  const dirty = !stored || JSON.stringify(stored) !== JSON.stringify(draft);
  const pending = outbox.some((o) => o.entity === 'installation' && o.entityId === draft.id);

  // Si la sincronizacion adopto una version mas nueva del servidor (conflicto), reflejarla
  useEffect(() => {
    if (stored && stored.updatedAt > draft.updatedAt) {
      setDraft(stored);
      setMsg({ tone: 'warn', text: 'Conflicto resuelto: el servidor tenía una versión más nueva y se adoptó.' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored?.updatedAt]);

  const set = (patch: Partial<Installation>) => setDraft((d) => ({ ...d, ...patch }));
  const deviceList = useMemo(() => Object.values(devices).sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true })), [devices]);
  const relatedDiags = useMemo(
    () =>
      Object.values(diagnostics)
        .filter((d) => d.deviceId && draft.deviceIds.includes(d.deviceId) && d.kind !== 'scan')
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 15),
    [diagnostics, draft.deviceIds],
  );

  function save(patch: Partial<Installation> = {}, silent = false) {
    if (!draft.siteName.trim()) {
      setMsg({ tone: 'err', text: 'El nombre del sitio es obligatorio' });
      return null;
    }
    const saved = saveInstallation({ ...draft, ...patch });
    setDraft(saved);
    if (!silent) setMsg({ tone: 'ok', text: 'Guardado localmente y encolado para sincronizar.' });
    if (isNew) router.setParams({ id: saved.id });
    return saved;
  }

  async function captureGps() {
    setBusy('gps');
    try {
      set({ location: await getLocation() });
      setMsg(null);
    } catch (e) {
      setMsg({ tone: 'err', text: `GPS: ${(e as Error).message}` });
    } finally {
      setBusy(null);
    }
  }

  async function takePhoto() {
    const wait = awaitScannerResult();
    router.push({ pathname: '/scanner', params: { mode: 'photo' } });
    const r = await wait;
    if (!r || r.kind !== 'photo') return;
    setBusy('photo');
    try {
      const p = await processPhoto(r.uri, r.width, r.height);
      setDraft((d) => ({ ...d, photos: [...d.photos, p], location: d.location ?? p.location }));
    } catch (e) {
      setMsg({ tone: 'err', text: `Foto: ${(e as Error).message}` });
    } finally {
      setBusy(null);
    }
  }

  async function pickPhoto() {
    setBusy('photo');
    try {
      const p = await pickPhotoFromLibrary();
      if (p) setDraft((d) => ({ ...d, photos: [...d.photos, p], location: d.location ?? p.location }));
    } catch (e) {
      setMsg({ tone: 'err', text: `Foto: ${(e as Error).message}` });
    } finally {
      setBusy(null);
    }
  }

  async function scanEquipment() {
    const wait = awaitScannerResult();
    router.push({ pathname: '/scanner', params: { mode: 'code' } });
    const r = await wait;
    if (!r || r.kind !== 'code') return;
    const code = r.data.trim();
    set({ equipmentCode: code });
    setBusy('ficha');
    try {
      const ficha = (await agent.ficha(code)) as Ficha;
      set({ equipmentCode: code, ficha });
      setMsg({ tone: 'ok', text: `Ficha técnica de ${code} asociada.` });
    } catch (e) {
      setMsg({ tone: 'warn', text: `Código ${code} registrado. No se pudo obtener la ficha (${(e as Error).message}); podés reintentar luego.` });
    } finally {
      setBusy(null);
    }
  }

  async function retryFicha() {
    if (!draft.equipmentCode) return;
    setBusy('ficha');
    try {
      set({ ficha: (await agent.ficha(draft.equipmentCode)) as Ficha });
      setMsg(null);
    } catch (e) {
      setMsg({ tone: 'err', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function generatePdf() {
    const saved = save({ status: 'completed', reportGeneratedAt: Date.now() }, true);
    if (!saved) return;
    setBusy('pdf');
    try {
      const devs = saved.deviceIds.map((d) => getState().devices[d]).filter(Boolean);
      const html = buildReportHtml(saved, devs, relatedDiags);
      const uri = await exportPdf(html, `Reporte-${saved.siteName.replace(/\W+/g, '_')}`);
      recordReport(saved); // generar el reporte lo encola para sincronizacion
      setMsg({
        tone: 'ok',
        text: uri ? `PDF generado: ${uri}` : 'Se abrió el diálogo de impresión: elegí "Guardar como PDF". El reporte quedó encolado para sincronizar.',
      });
    } catch (e) {
      setMsg({ tone: 'err', text: `PDF: ${(e as Error).message}` });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: isNew ? 'Nueva instalación' : draft.siteName || 'Instalación' }} />
      {!isNew && (
        <Wrap>
          <Badge tone={draft.status === 'completed' ? 'ok' : 'muted'} text={draft.status === 'completed' ? 'Completada' : 'Borrador'} />
          <Badge tone={pending ? 'warn' : 'ok'} text={pending ? 'Pendiente de sincronizar' : 'Sincronizada'} />
          {dirty && <Badge tone="warn" text="Cambios sin guardar" />}
        </Wrap>
      )}

      <Card title="Datos del sitio">
        <Wrap>
          <Field label="Sitio *" value={draft.siteName} onChangeText={(v) => set({ siteName: v })} placeholder="Ej: Torre Norte - Azotea" autoCapitalize="sentences" />
          <Field label="Cliente" value={draft.client} onChangeText={(v) => set({ client: v })} autoCapitalize="words" />
        </Wrap>
        <Wrap>
          <Field label="Dirección" value={draft.address} onChangeText={(v) => set({ address: v })} autoCapitalize="sentences" />
          <Field label="Técnico" value={draft.technician} onChangeText={(v) => set({ technician: v })} autoCapitalize="words" />
        </Wrap>
        <Field label="Notas técnicas" value={draft.notes} onChangeText={(v) => set({ notes: v })} multiline autoCapitalize="sentences" placeholder="Potencia óptica, ubicación del equipo, observaciones…" />
      </Card>

      <Card title="Ubicación GPS">
        <Row label="Coordenadas" value={formatCoords(draft.location)} />
        {draft.location && <Row label="Capturada" value={fmtDate(draft.location.capturedAt)} />}
        <Button title={draft.location ? 'Actualizar ubicación' : 'Capturar ubicación'} icon="📍" variant="secondary" onPress={captureGps} loading={busy === 'gps'} />
      </Card>

      <Card title="Equipo instalado (QR / código de barras)">
        {draft.equipmentCode ? (
          <>
            <Row label="Código" value={draft.equipmentCode} monoValue />
            {draft.ficha ? (
              <>
                <Row label="Tipo" value={draft.ficha.tipo as string} />
                <Row label="Modelo" value={draft.ficha.modelo as string} />
                <Row label="Serie" value={draft.ficha.serie as string} />
                <Row label="Firmware" value={draft.ficha.firmware as string} />
                <Row label="Notas" value={draft.ficha.notas as string} />
              </>
            ) : (
              <Button small variant="ghost" title="Reintentar obtener ficha técnica" onPress={retryFicha} loading={busy === 'ficha'} />
            )}
          </>
        ) : (
          <Muted>Escaneá la etiqueta del equipo para asociar su ficha técnica.</Muted>
        )}
        <Button title="Escanear QR del equipo" icon="🔳" variant="secondary" onPress={scanEquipment} loading={busy === 'ficha'} />
      </Card>

      <Card title="Equipos de red relevados">
        {deviceList.length === 0 ? (
          <Muted>Escaneá la red desde la pestaña "Red" para poder asociar equipos.</Muted>
        ) : (
          <Wrap>
            {deviceList.map((d) => (
              <Chip
                key={d.id}
                label={`${d.ip}${d.hostname ? ` · ${d.hostname.split('.')[0]}` : ''}`}
                selected={draft.deviceIds.includes(d.id)}
                onPress={() =>
                  set({ deviceIds: draft.deviceIds.includes(d.id) ? draft.deviceIds.filter((x) => x !== d.id) : [...draft.deviceIds, d.id] })
                }
              />
            ))}
          </Wrap>
        )}
        {relatedDiags.length > 0 && <Muted>{relatedDiags.length} diagnósticos de estos equipos se incluirán en el reporte.</Muted>}
      </Card>

      <Card title={`Fotos (${draft.photos.length})`}>
        <Wrap>
          {draft.photos.map((p) => (
            <View key={p.id} style={{ width: 150, gap: 2 }}>
              <Image source={{ uri: p.dataUri }} style={{ width: 150, height: 112, borderRadius: 8, backgroundColor: '#E2E8F0' }} />
              <Muted style={{ fontSize: 10 }}>{fmtDate(p.takenAt)}</Muted>
              <Muted style={{ fontSize: 10 }}>{formatCoords(p.location)}</Muted>
              <Pressable onPress={() => set({ photos: draft.photos.filter((x) => x.id !== p.id) })}>
                <Text style={{ color: C.err, fontSize: 12 }}>Quitar</Text>
              </Pressable>
            </View>
          ))}
        </Wrap>
        <Wrap>
          <Button title="Tomar foto" icon="📷" variant="secondary" onPress={takePhoto} loading={busy === 'photo'} />
          <Button title="Elegir imagen" icon="🖼️" variant="ghost" onPress={pickPhoto} disabled={busy === 'photo'} />
        </Wrap>
        <Muted>Cada foto se georreferencia y se comprime (≤960 px, JPEG) para guardarse offline.</Muted>
      </Card>

      {msg && <Notice tone={msg.tone} text={msg.text} />}

      <Wrap>
        <Button title="Guardar" icon="💾" onPress={() => save()} disabled={!dirty} />
        <Button title="Generar reporte PDF" icon="📄" variant="success" onPress={generatePdf} loading={busy === 'pdf'} />
        {!isNew && (
          <Button
            title="Eliminar"
            variant="danger"
            onPress={async () => {
              if (await confirm('¿Eliminar esta instalación? La baja también se sincronizará.')) {
                deleteInstallation(draft.id);
                router.back();
              }
            }}
          />
        )}
      </Wrap>
    </Screen>
  );
}
