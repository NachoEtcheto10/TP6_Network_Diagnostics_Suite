/**
 * Subconjunto de la MIB-II (RFC 1213) usado por la app.
 * Grupo system: 1.3.6.1.2.1.1.x  |  Grupo interfaces: 1.3.6.1.2.1.2.x
 */
export const SYSTEM = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysObjectID: '1.3.6.1.2.1.1.2.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysContact: '1.3.6.1.2.1.1.4.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  sysLocation: '1.3.6.1.2.1.1.6.0',
} as const;

export const IF_NUMBER = '1.3.6.1.2.1.2.1.0';

/** Columnas de ifTable (1.3.6.1.2.1.2.2.1.<col>.<ifIndex>) */
export const IF_COLUMNS = {
  ifDescr: 2,
  ifType: 3,
  ifMtu: 4,
  ifSpeed: 5,
  ifPhysAddress: 6,
  ifAdminStatus: 7,
  ifOperStatus: 8,
  ifInOctets: 10,
  ifInErrors: 14,
  ifOutOctets: 16,
  ifOutErrors: 20,
} as const;

export const ifOid = (col: number, index: number) => `1.3.6.1.2.1.2.2.1.${col}.${index}`;

const NAMES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(SYSTEM).map(([k, v]) => [v, k])),
  [IF_NUMBER]: 'ifNumber',
};

export function oidName(oid: string): string {
  if (NAMES[oid]) return NAMES[oid];
  const m = /^1\.3\.6\.1\.2\.1\.2\.2\.1\.(\d+)\.(\d+)$/.exec(oid);
  if (m) {
    const col = Object.entries(IF_COLUMNS).find(([, c]) => c === Number(m[1]));
    if (col) return `${col[0]}.${m[2]}`;
  }
  return oid;
}

export const IF_STATUS: Record<number, string> = {
  1: 'up',
  2: 'down',
  3: 'testing',
  4: 'unknown',
  5: 'dormant',
  6: 'notPresent',
  7: 'lowerLayerDown',
};

/** TimeTicks (centesimas de segundo) a texto legible. */
export function formatTimeTicks(ticks: number): string {
  let s = Math.floor(ticks / 100);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  return `${d}d ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
