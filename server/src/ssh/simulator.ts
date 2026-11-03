/**
 * Servidor SSH de laboratorio (equipo simulado) para la demo cuando no hay un
 * equipo real con SSH. Acepta un unico usuario y responde a los comandos del
 * catalogo con salidas de ejemplo. NO ejecuta nada en el host.
 */
import os from 'node:os';
import ssh2 from 'ssh2';
import { timingSafeEqual } from 'node:crypto';

const { Server, utils } = ssh2;

export interface SshSimOptions {
  port: number;
  username: string;
  password: string;
}

const safeEq = (a: string, b: string) => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

function fakeOutput(command: string): { out: string; code: number } {
  const up = os.uptime();
  const d = Math.floor(up / 86400);
  const h = Math.floor((up % 86400) / 3600);
  const m = Math.floor((up % 3600) / 60);
  const now = new Date();
  const outputs: Record<string, string> = {
    uptime: ` ${now.toTimeString().slice(0, 8)} up ${d} days, ${h}:${String(m).padStart(2, '0')},  1 user,  load average: 0.08, 0.05, 0.01`,
    'uname -a': 'Linux nds-lab-ont01 5.10.176 #0 SMP Tue Mar 4 2026 armv7l GNU/Linux',
    'ip -brief address': [
      'lo               UNKNOWN        127.0.0.1/8',
      'eth0             UP             100.64.12.34/22',
      'br-lan           UP             192.168.100.1/24',
      'wlan0            UP',
    ].join('\n'),
    'ip route': [
      'default via 100.64.12.1 dev eth0 proto dhcp src 100.64.12.34 metric 10',
      '100.64.12.0/22 dev eth0 proto kernel scope link src 100.64.12.34',
      '192.168.100.0/24 dev br-lan proto kernel scope link src 192.168.100.1',
    ].join('\n'),
    'ss -tuln': [
      'Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port',
      'udp   UNCONN 0      0            0.0.0.0:161       0.0.0.0:*',
      'udp   UNCONN 0      0            0.0.0.0:53        0.0.0.0:*',
      'tcp   LISTEN 0      128          0.0.0.0:22        0.0.0.0:*',
      'tcp   LISTEN 0      128          0.0.0.0:80        0.0.0.0:*',
    ].join('\n'),
    'free -m': [
      '              total        used        free      shared  buff/cache   available',
      'Mem:            249          71         112           2          65         163',
      'Swap:             0           0           0',
    ].join('\n'),
    'df -h': [
      'Filesystem      Size  Used Avail Use% Mounted on',
      '/dev/root       12.5M 12.5M     0 100% /rom',
      'overlayfs:/overlay 46.2M  1.9M 44.3M   4% /',
      'tmpfs          124.6M  2.1M 122.5M   2% /tmp',
    ].join('\n'),
    'ping -c 4 8.8.8.8': [
      'PING 8.8.8.8 (8.8.8.8): 56 data bytes',
      '64 bytes from 8.8.8.8: seq=0 ttl=117 time=14.212 ms',
      '64 bytes from 8.8.8.8: seq=1 ttl=117 time=13.877 ms',
      '64 bytes from 8.8.8.8: seq=2 ttl=117 time=15.104 ms',
      '64 bytes from 8.8.8.8: seq=3 ttl=117 time=14.006 ms',
      '',
      '--- 8.8.8.8 ping statistics ---',
      '4 packets transmitted, 4 packets received, 0% packet loss',
      'round-trip min/avg/max = 13.877/14.299/15.104 ms',
    ].join('\n'),
    'show version': 'Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.0(2)SE11 [SIMULADO]\nnds-lab uptime is ' + `${d} days, ${h} hours, ${m} minutes`,
    'show ip interface brief': [
      'Interface              IP-Address      OK? Method Status                Protocol',
      'Vlan1                  192.168.100.2   YES NVRAM  up                    up',
      'FastEthernet0/1        unassigned      YES unset  up                    up',
      'FastEthernet0/2        unassigned      YES unset  down                  down',
    ].join('\n'),
    'show clock': `*${now.toUTCString()}`,
    '/system resource print': [
      `                   uptime: ${d}d${h}h${m}m`,
      '                  version: 7.14.2 (stable) [SIMULADO]',
      '              free-memory: 180.2MiB',
      '             total-memory: 256.0MiB',
      '                 cpu-load: 3%',
      '               board-name: hEX',
    ].join('\n'),
    'display version': 'Huawei Versatile Routing Platform Software\nVRP (R) software, Version 5.170 [SIMULADO]',
  };
  if (command in outputs) return { out: outputs[command] + '\n', code: 0 };
  return { out: `sh: ${command.split(' ')[0]}: not found\n`, code: 127 };
}

export function startSshSimulator(opts: SshSimOptions) {
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  const server = new Server({ hostKeys: [hostKey], banner: 'NDS-Lab equipo simulado (TP6)' }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && safeEq(ctx.username, opts.username) && safeEq(ctx.password, opts.password)) {
        return ctx.accept();
      }
      return ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          const { out, code } = fakeOutput(info.command.trim());
          setTimeout(() => {
            stream.write(out);
            stream.exit(code);
            stream.end();
          }, 250);
        });
      });
    });
    client.on('error', () => {});
  });
  return new Promise<typeof server>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
