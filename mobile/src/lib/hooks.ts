import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { agent, type Health } from './agent';
import { getSyncStatus, subscribeSyncStatus } from './outbox';
import { useStore } from './store';

export const useSyncStatus = () => useSyncExternalStore(subscribeSyncStatus, getSyncStatus, getSyncStatus);

/** Estado del agente de red (se consulta al montar y cada 10 s). */
export function useAgentHealth() {
  const url = useStore((s) => s.settings.agentUrl);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = useCallback(async () => {
    try {
      setHealth(await agent.health());
      setError(null);
    } catch (e) {
      setHealth(null);
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void check();
    const t = setInterval(check, 10000);
    return () => clearInterval(t);
  }, [check, url]);
  return { health, error, check };
}

/** Re-render periodico para textos relativos ("hace 5 s", cuenta regresiva de reintentos). */
export function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}
