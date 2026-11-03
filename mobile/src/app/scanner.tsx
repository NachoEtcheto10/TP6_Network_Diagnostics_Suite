import { useEffect, useRef, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { CameraView, scanFromURLAsync, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { resolveScanner } from '@/lib/scannerBus';
import { Button, C, Card, Field, Muted, Notice, Screen, Wrap } from '@/components/ui';

const BARCODE_TYPES = ['qr', 'code128', 'code39', 'ean13', 'ean8', 'datamatrix'] as const;

/**
 * Camara compartida: modo "code" (QR/barras) o "photo" (evidencia).
 * En web usa la webcam del navegador (requiere localhost o HTTPS).
 */
export default function ScannerScreen() {
  const { mode } = useLocalSearchParams<{ mode: 'code' | 'photo' }>();
  const [permission, requestPermission] = useCameraPermissions();
  const camRef = useRef<CameraView>(null);
  const handled = useRef(false);
  const [manual, setManual] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [facing, setFacing] = useState<'back' | 'front'>('back');
  const [cameraReady, setCameraReady] = useState(false);

  // Si se cierra el modal sin resultado, liberar a quien espera
  useEffect(() => () => resolveScanner(null), []);

  const finish = (r: Parameters<typeof resolveScanner>[0]) => {
    if (handled.current) return;
    handled.current = true;
    resolveScanner(r);
    router.back();
  };

  const onScanned = (r: BarcodeScanningResult) => {
    if (r.data) finish({ kind: 'code', data: r.data, type: r.type });
  };

  async function takePicture() {
    setBusy(true);
    try {
      // En web el primer cuadro de la webcam puede tardar unos ms aun despues de onCameraReady
      for (let attempt = 0; ; attempt++) {
        try {
          const pic = await camRef.current?.takePictureAsync({ quality: 0.8 });
          if (pic) finish({ kind: 'photo', uri: pic.uri, width: pic.width, height: pic.height });
          break;
        } catch (e) {
          if (attempt >= 10 || !/enough camera data/i.test((e as Error).message)) throw e;
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function scanFromImage() {
    setError(null);
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'] });
    if (res.canceled || !res.assets[0]) return;
    try {
      const found = await scanFromURLAsync(res.assets[0].uri, [...BARCODE_TYPES]);
      if (found[0]) onScanned(found[0]);
      else setError('No se encontró ningún código en la imagen.');
    } catch (e) {
      setError(`No se pudo leer la imagen: ${(e as Error).message}`);
    }
  }

  const isCode = mode !== 'photo';

  return (
    <Screen>
      <Stack.Screen options={{ title: isCode ? 'Escanear QR / código de barras' : 'Tomar foto' }} />
      {!permission ? null : !permission.granted ? (
        <Card title="Permiso de cámara">
          <Muted>Se necesita la cámara para {isCode ? 'leer la etiqueta del equipo' : 'fotografiar la instalación'}.</Muted>
          <Button title="Permitir cámara" onPress={requestPermission} />
        </Card>
      ) : (
        <View style={{ borderRadius: 12, overflow: 'hidden', backgroundColor: '#000', aspectRatio: Platform.OS === 'web' ? 4 / 3 : 3 / 4 }}>
          <CameraView
            ref={camRef}
            style={{ flex: 1 }}
            facing={facing}
            onCameraReady={() => setCameraReady(true)}
            onMountError={(e) => setError(`No se pudo abrir la cámara: ${e.message}`)}
            barcodeScannerSettings={isCode ? { barcodeTypes: [...BARCODE_TYPES] } : undefined}
            onBarcodeScanned={isCode ? onScanned : undefined}
          />
          {isCode && (
            <View pointerEvents="none" style={{ position: 'absolute', top: '20%', left: '20%', right: '20%', bottom: '20%', borderWidth: 3, borderColor: '#4ADE80', borderRadius: 12 }} />
          )}
        </View>
      )}
      <Wrap>
        {!isCode && (
          <Button title={cameraReady ? 'Capturar' : 'Iniciando cámara…'} icon="📷" onPress={takePicture} loading={busy} disabled={!permission?.granted || !cameraReady} />
        )}
        <Button
          title="Cambiar cámara"
          variant="ghost"
          onPress={() => {
            setCameraReady(false);
            setFacing((f) => (f === 'back' ? 'front' : 'back'));
          }}
        />
        <Button title="Cancelar" variant="ghost" onPress={() => finish(null)} />
      </Wrap>
      {error && <Notice tone="err" text={error} />}
      {isCode && (
        <Card title="Alternativas">
          <Button title="Leer código desde una imagen" icon="🖼️" variant="secondary" onPress={scanFromImage} />
          <Wrap>
            <Field label="Ingresar código manualmente" value={manual} onChangeText={setManual} placeholder="NDS-ONT-0001" autoCapitalize="characters" />
            <Button title="Usar código" onPress={() => manual.trim() && finish({ kind: 'code', data: manual.trim(), type: 'manual' })} disabled={!manual.trim()} />
          </Wrap>
          <Text style={{ color: C.muted, fontSize: 12 }}>Etiquetas de prueba: abrí http://localhost:4000/qr en otra pestaña o imprimilas.</Text>
        </Card>
      )}
    </Screen>
  );
}
