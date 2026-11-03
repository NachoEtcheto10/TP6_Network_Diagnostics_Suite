/**
 * Ejecucion remota de comandos de diagnostico predefinidos via SSH (ssh2).
 *
 * Manejo de credenciales:
 *  - La contrasena llega en el cuerpo del request, se usa para autenticar y se
 *    descarta. Nunca se escribe a disco ni se loguea.
 *  - Verificacion de host key estilo TOFU: se devuelve la huella SHA256; si la app
 *    envia `expectedFingerprint` y no coincide, se aborta (posible MITM).
 */
import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';
import { findCommand } from './commands.ts';

const { Client } = ssh2;

export interface SshRequest {
  host: string;
  port?: number;
  username: string;
  password: string;
  vendor: string;
  commandId: string;
  expectedFingerprint?: string;
  timeoutMs?: number;
}

export interface SshResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  fingerprint: string;
  serverBanner: string | null;
}

const MAX_OUTPUT = 64 * 1024;

export function runDiagnostic(req: SshRequest): Promise<SshResult> {
  const cmd = findCommand(req.vendor, req.commandId);
  if (!cmd) return Promise.reject(new Error(`Comando no permitido: ${req.vendor}/${req.commandId}`));

  return new Promise((resolve, reject) => {
    const conn = new Client();
    const started = performance.now();
    let fingerprint = '';
    let banner: string | null = null;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      conn.end();
      reject(err);
    };

    conn.on('banner', (b) => (banner = b.trim()));
    conn.on('error', (err) => {
      const msg =
        (err as { level?: string }).level === 'client-authentication'
          ? 'Autenticacion rechazada (usuario o contrasena incorrectos)'
          : err.message;
      fail(new Error(msg));
    });

    conn.on('ready', () => {
      conn.exec(cmd.command, (err, stream) => {
        if (err) return fail(err);
        let stdout = '';
        let stderr = '';
        let exitCode: number | null = null;
        stream.on('data', (d: Buffer) => {
          if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf8');
        });
        stream.stderr.on('data', (d: Buffer) => {
          if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf8');
        });
        stream.on('exit', (code: number | null) => (exitCode = code));
        stream.on('close', () => {
          if (settled) return;
          settled = true;
          conn.end();
          resolve({
            command: cmd.command,
            stdout,
            stderr,
            exitCode,
            durationMs: Math.round(performance.now() - started),
            fingerprint,
            serverBanner: banner,
          });
        });
      });
    });

    conn.connect({
      host: req.host,
      port: req.port ?? 22,
      username: req.username,
      password: req.password,
      readyTimeout: req.timeoutMs ?? 8000,
      tryKeyboard: true,
      hostVerifier: (key: Buffer) => {
        fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
        if (req.expectedFingerprint && req.expectedFingerprint !== fingerprint) {
          setImmediate(() =>
            fail(
              new Error(
                `La huella del host cambio (esperada ${req.expectedFingerprint}, recibida ${fingerprint}). ` +
                  'Posible ataque MITM o equipo reemplazado: conexion abortada.',
              ),
            ),
          );
          return false;
        }
        return true;
      },
    });
    // Algunos equipos piden keyboard-interactive en lugar de password
    conn.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => req.password)));
  });
}
