/**
 * Credenciales SSH de equipos. Regla: NUNCA en texto plano.
 *  - Android/iOS: expo-secure-store (Android Keystore / iOS Keychain).
 *  - Web: el navegador no ofrece un almacen seguro equivalente, asi que la
 *    contrasena se guarda SOLO en memoria durante la sesion (se pierde al recargar).
 * El usuario si se recuerda (no es secreto). Nada de esto viaja en la outbox.
 */
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

export interface Credential {
  username: string;
  password: string;
}

const memory = new Map<string, Credential>();
const keyFor = (host: string, port: number) => `nds_cred_${host.replace(/[^\w.-]/g, '_')}_${port}`;

export const secureStorageAvailable = Platform.OS !== 'web';

export async function saveCredential(host: string, port: number, cred: Credential) {
  const key = keyFor(host, port);
  if (secureStorageAvailable) {
    await SecureStore.setItemAsync(key, JSON.stringify(cred), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } else {
    memory.set(key, cred);
  }
}

export async function loadCredential(host: string, port: number): Promise<Credential | null> {
  const key = keyFor(host, port);
  if (secureStorageAvailable) {
    const raw = await SecureStore.getItemAsync(key);
    return raw ? (JSON.parse(raw) as Credential) : null;
  }
  return memory.get(key) ?? null;
}

export async function deleteCredential(host: string, port: number) {
  const key = keyFor(host, port);
  if (secureStorageAvailable) await SecureStore.deleteItemAsync(key);
  memory.delete(key);
}
