import { useEffect, useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { agent, type SshResult, type Vendor } from '@/lib/agent';
import { deleteCredential, loadCredential, saveCredential, secureStorageAvailable } from '@/lib/credentials';
import { useAgentHealth } from '@/lib/hooks';
import { addDiagnostic } from '@/lib/outbox';
import { getState, setState, useStore } from '@/lib/store';
import { Badge, Button, C, Card, Chip, Field, Muted, Notice, Screen, Terminal, Wrap } from '@/components/ui';

export default function SshScreen() {
  const params = useLocalSearchParams<{ host?: string; port?: string }>();
  const { health } = useAgentHealth();
  const knownHosts = useStore((s) => s.knownHosts);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [vendor, setVendor] = useState('linux');
  const [host, setHost] = useState(params.host ?? '');
  const [port, setPort] = useState(params.port ?? '22');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [output, setOutput] = useState<(SshResult & { at: number })[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (params.host) setHost(params.host);
    if (params.port) setPort(params.port);
  }, [params.host, params.port]);

  useEffect(() => {
    if (!health) return;
    agent.vendors().then(setVendors).catch(() => {});
  }, [health]);

  // Al cambiar de equipo, recuperar credenciales guardadas de forma segura
  useEffect(() => {
    const h = host.trim();
    if (!h) return;
    let alive = true;
    loadCredential(h, Number(port) || 22).then((c) => {
      if (alive && c) {
        setUsername(c.username);
        setPassword(c.password);
        setRemember(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [host, port]);

  const hostKey = `${host.trim()}:${Number(port) || 22}`;
  const knownFp = knownHosts[hostKey];

  async function run(commandId: string) {
    if (!host.trim() || !username || !password) return setError('Completá host, usuario y contraseña');
    setRunning(commandId);
    setError(null);
    const p = Number(port) || 22;
    try {
      const r = await agent.sshExec({ host: host.trim(), port: p, username, password, vendor, commandId, expectedFingerprint: knownFp });
      if (!knownFp) setState((s) => ({ knownHosts: { ...s.knownHosts, [hostKey]: r.fingerprint } })); // TOFU
      if (remember) await saveCredential(host.trim(), p, { username, password });
      setOutput((o) => [{ ...r, at: Date.now() }, ...o].slice(0, 10));
      const dev = Object.values(getState().devices).find((d) => d.ip === host.trim());
      addDiagnostic({
        kind: 'ssh',
        deviceId: dev?.id ?? null,
        host: hostKey,
        ok: r.exitCode === 0,
        summary: `$ ${r.command} → exit ${r.exitCode ?? '?'} (${r.durationMs} ms)`,
        // La salida se guarda; la contrasena JAMAS forma parte del diagnostico
        data: { command: r.command, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, fingerprint: r.fingerprint, username, vendor },
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(null);
    }
  }

  const current = vendors.find((v) => v.id === vendor);
  const sim = health?.simulators.ssh;

  return (
    <Screen>
      <Card title="Conexión">
        <Wrap>
          <Field label="IP / host" value={host} onChangeText={setHost} placeholder="192.168.0.1" />
          <Field label="Puerto" value={port} onChangeText={setPort} keyboardType="number-pad" style={{ maxWidth: 100 }} />
        </Wrap>
        <Wrap>
          <Field label="Usuario" value={username} onChangeText={setUsername} />
          <Field label="Contraseña" value={password} onChangeText={setPassword} secureTextEntry />
        </Wrap>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Switch value={remember} onValueChange={setRemember} />
          <Text style={{ color: C.text, flex: 1 }}>
            {secureStorageAvailable ? 'Recordar en el llavero seguro (Keystore/Keychain)' : 'Recordar durante esta sesión (en web solo en memoria, nunca en disco)'}
          </Text>
          {remember && (
            <Button
              small
              variant="ghost"
              title="Olvidar"
              onPress={async () => {
                await deleteCredential(host.trim(), Number(port) || 22);
                setRemember(false);
                setPassword('');
              }}
            />
          )}
        </View>
        {sim && health && (
          <Button
            small
            variant="ghost"
            title={`Usar equipo simulado (${health.lanAddress}:${sim.port}, usuario ${sim.username})`}
            onPress={() => {
              setHost(health.lanAddress);
              setPort(String(sim.port));
              setUsername(sim.username);
              setVendor('linux');
            }}
          />
        )}
        {knownFp ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Badge tone="ok" text="Host conocido" />
            <Muted style={{ flex: 1 }}>{knownFp}</Muted>
            <Button
              small
              variant="ghost"
              title="Olvidar huella"
              onPress={() =>
                setState((s) => {
                  const k = { ...s.knownHosts };
                  delete k[hostKey];
                  return { knownHosts: k };
                })
              }
            />
          </View>
        ) : (
          <Muted>Primera conexión a este host: se guardará la huella de su clave (TOFU) y se verificará en las próximas.</Muted>
        )}
      </Card>

      <Card title="Comandos de diagnóstico">
        <Wrap>
          {vendors.map((v) => (
            <Chip key={v.id} label={v.label} selected={vendor === v.id} onPress={() => setVendor(v.id)} />
          ))}
        </Wrap>
        {!health && <Notice tone="warn" text="El agente de red no está disponible: no se puede abrir la sesión SSH." />}
        <Wrap>
          {current?.commands.map((c) => (
            <Button key={c.id} small variant="secondary" title={c.label} onPress={() => run(c.id)} loading={running === c.id} disabled={!!running} />
          ))}
        </Wrap>
        <Muted>Solo se permiten comandos predefinidos de lectura: la app no expone un shell libre.</Muted>
        {error && <Notice tone="err" text={error} />}
      </Card>

      {output.map((o, i) => (
        <Card key={o.at} title={i === 0 ? 'Salida' : undefined} right={i === 0 ? <Badge tone={o.exitCode === 0 ? 'ok' : 'err'} text={`exit ${o.exitCode ?? '?'} · ${o.durationMs} ms`} /> : undefined}>
          <Terminal text={`${username}@${host}$ ${o.command}\n${o.stdout}${o.stderr ? `\n[stderr]\n${o.stderr}` : ''}`} />
        </Card>
      ))}
    </Screen>
  );
}
