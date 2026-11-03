/**
 * Canal para devolver el resultado de la pantalla de camara (QR o foto) a la
 * pantalla que la abrio, sin serializar imagenes en la URL.
 */
export type ScannerResult = { kind: 'code'; data: string; type: string } | { kind: 'photo'; uri: string; width: number; height: number };

let pending: ((r: ScannerResult | null) => void) | null = null;

export function awaitScannerResult(): Promise<ScannerResult | null> {
  pending?.(null);
  return new Promise((resolve) => (pending = resolve));
}

export function resolveScanner(r: ScannerResult | null) {
  const p = pending;
  pending = null;
  p?.(r);
}
