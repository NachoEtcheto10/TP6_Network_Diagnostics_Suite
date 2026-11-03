/**
 * Catalogo de comandos de diagnostico PREDEFINIDOS por vendor.
 *
 * La app nunca envia comandos libres: solo un `commandId`. Asi se evita que la
 * herramienta se use como shell remoto arbitrario (y que un error de tipeo en
 * campo reconfigure un equipo). Todos los comandos son de solo lectura.
 */
export interface DiagCommand {
  id: string;
  label: string;
  command: string;
}

export interface Vendor {
  id: string;
  label: string;
  commands: DiagCommand[];
}

export const VENDORS: Vendor[] = [
  {
    id: 'linux',
    label: 'Linux / OpenWrt / ONT basada en Linux',
    commands: [
      { id: 'uptime', label: 'Uptime y carga', command: 'uptime' },
      { id: 'uname', label: 'Kernel y arquitectura', command: 'uname -a' },
      { id: 'interfaces', label: 'Interfaces y direcciones', command: 'ip -brief address' },
      { id: 'routes', label: 'Tabla de ruteo', command: 'ip route' },
      { id: 'listening', label: 'Puertos en escucha', command: 'ss -tuln' },
      { id: 'memory', label: 'Memoria', command: 'free -m' },
      { id: 'disk', label: 'Disco', command: 'df -h' },
      { id: 'ping', label: 'Ping a 8.8.8.8', command: 'ping -c 4 8.8.8.8' },
    ],
  },
  {
    id: 'cisco_ios',
    label: 'Cisco IOS',
    commands: [
      { id: 'version', label: 'show version', command: 'show version' },
      { id: 'ip_brief', label: 'show ip interface brief', command: 'show ip interface brief' },
      { id: 'interfaces', label: 'show interfaces', command: 'show interfaces' },
      { id: 'routes', label: 'show ip route', command: 'show ip route' },
      { id: 'arp', label: 'show arp', command: 'show arp' },
      { id: 'clock', label: 'show clock', command: 'show clock' },
    ],
  },
  {
    id: 'mikrotik',
    label: 'MikroTik RouterOS',
    commands: [
      { id: 'resource', label: 'Recursos del sistema', command: '/system resource print' },
      { id: 'interfaces', label: 'Interfaces', command: '/interface print' },
      { id: 'addresses', label: 'Direcciones IP', command: '/ip address print' },
      { id: 'routes', label: 'Rutas', command: '/ip route print' },
      { id: 'log', label: 'Ultimos logs', command: '/log print where topics~"error|warning"' },
    ],
  },
  {
    id: 'huawei_vrp',
    label: 'Huawei VRP / OLT',
    commands: [
      { id: 'version', label: 'display version', command: 'display version' },
      { id: 'ip_brief', label: 'display ip interface brief', command: 'display ip interface brief' },
      { id: 'interfaces', label: 'display interface brief', command: 'display interface brief' },
      { id: 'cpu', label: 'display cpu-usage', command: 'display cpu-usage' },
    ],
  },
  {
    id: 'windows',
    label: 'Windows (OpenSSH Server)',
    commands: [
      { id: 'hostname', label: 'Nombre de equipo', command: 'hostname' },
      { id: 'ipconfig', label: 'ipconfig', command: 'ipconfig' },
      { id: 'routes', label: 'Tabla de ruteo', command: 'route print -4' },
      { id: 'ping', label: 'Ping a 8.8.8.8', command: 'ping -n 4 8.8.8.8' },
    ],
  },
];

export function findCommand(vendorId: string, commandId: string): DiagCommand | undefined {
  return VENDORS.find((v) => v.id === vendorId)?.commands.find((c) => c.id === commandId);
}
