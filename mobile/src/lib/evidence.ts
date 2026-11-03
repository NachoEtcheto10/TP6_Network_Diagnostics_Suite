/** Capa de evidencia: geolocalizacion y fotos comprimidas georreferenciadas. */
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { uuid } from './store';
import type { GeoPoint, Photo } from './types';

export async function getLocation(): Promise<GeoPoint> {
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') throw new Error('Permiso de ubicacion denegado');
  const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  return {
    latitude: pos.coords.latitude,
    longitude: pos.coords.longitude,
    accuracy: pos.coords.accuracy ?? null,
    altitude: pos.coords.altitude ?? null,
    capturedAt: pos.timestamp || Date.now(),
  };
}

/** Intenta obtener GPS sin bloquear: si falla, la foto se guarda igual sin coordenadas. */
async function tryLocation(): Promise<GeoPoint | null> {
  try {
    return await Promise.race([
      getLocation(),
      new Promise<null>((r) => setTimeout(() => r(null), 8000)),
    ]);
  } catch {
    return null;
  }
}

const MAX_SIDE = 960;

/**
 * Redimensiona a <= 960 px y comprime a JPEG. Guardar la foto como data URI la
 * hace autocontenida: funciona offline, entra en el PDF y viaja en la outbox.
 */
export async function processPhoto(uri: string, width?: number, height?: number): Promise<Photo> {
  const ctx = ImageManipulator.manipulate(uri);
  // Se pasan ambas dimensiones: en web resize() con una sola en null produce NaN
  if (width && height && Math.max(width, height) > MAX_SIDE) {
    const scale = MAX_SIDE / Math.max(width, height);
    ctx.resize({ width: Math.round(width * scale), height: Math.round(height * scale) });
  }
  const [image, location] = await Promise.all([ctx.renderAsync(), tryLocation()]);
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.6, base64: true });
  return {
    id: uuid(),
    dataUri: `data:image/jpeg;base64,${saved.base64}`,
    width: saved.width,
    height: saved.height,
    takenAt: Date.now(),
    location,
  };
}

export async function pickPhotoFromLibrary(): Promise<Photo | null> {
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
  if (res.canceled || !res.assets[0]) return null;
  const a = res.assets[0];
  return processPhoto(a.uri, a.width, a.height);
}

export const formatCoords = (g: GeoPoint | null | undefined) =>
  g ? `${g.latitude.toFixed(6)}, ${g.longitude.toFixed(6)}${g.accuracy != null ? ` (±${Math.round(g.accuracy)} m)` : ''}` : 'Sin ubicación';

export const mapsUrl = (g: GeoPoint) =>
  `https://www.openstreetmap.org/?mlat=${g.latitude}&mlon=${g.longitude}#map=18/${g.latitude}/${g.longitude}`;
