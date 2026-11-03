/**
 * Tabla OUI reducida (primeros 3 bytes de la MAC -> fabricante), embebida para
 * funcionar offline. No es exhaustiva: cubre fabricantes frecuentes en
 * instalaciones de redes y laboratorio. Para el registro completo ver
 * https://standards-oui.ieee.org/oui/oui.txt
 */
const OUI: Record<string, string> = {
  'b8:27:eb': 'Raspberry Pi Foundation',
  'dc:a6:32': 'Raspberry Pi Trading',
  'e4:5f:01': 'Raspberry Pi Trading',
  '28:cd:c1': 'Raspberry Pi Trading',
  '24:0a:c4': 'Espressif',
  '30:ae:a4': 'Espressif',
  '24:6f:28': 'Espressif',
  '24:a4:3c': 'Ubiquiti',
  '04:18:d6': 'Ubiquiti',
  'fc:ec:da': 'Ubiquiti',
  '78:8a:20': 'Ubiquiti',
  '4c:5e:0c': 'MikroTik',
  '64:d1:54': 'MikroTik',
  'cc:2d:e0': 'MikroTik',
  'd4:ca:6d': 'MikroTik',
  'e4:8d:8c': 'MikroTik',
  '6c:3b:6b': 'MikroTik',
  'b8:69:f4': 'MikroTik',
  '00:50:56': 'VMware',
  '00:0c:29': 'VMware',
  '08:00:27': 'Oracle VirtualBox',
  '00:15:5d': 'Microsoft Hyper-V',
  '52:54:00': 'QEMU/KVM',
  '00:1b:21': 'Intel',
  '00:00:0c': 'Cisco',
  '00:1a:a1': 'Cisco',
  'a4:c3:f0': 'NDS-Lab (simulado)',
};

export function lookupVendor(mac: string): string | null {
  const prefix = mac.toLowerCase().slice(0, 8);
  if (OUI[prefix]) return OUI[prefix];
  if (parseInt(prefix.slice(0, 2), 16) & 0x02) return 'MAC privada/aleatoria (administrada localmente)';
  return null;
}
