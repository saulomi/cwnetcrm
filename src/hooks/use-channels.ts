'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Channel } from '@/types';

/**
 * Shared fetch of the caller's account WhatsApp channels
 * (`GET /api/channels`), used by every channel picker in the app —
 * inbox badge/switcher, broadcast wizard, Flows/Automations
 * send_message step config. One fetch implementation so those four
 * surfaces can't drift on error handling or response shape.
 */
export function useChannels() {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/channels');
      if (!res.ok) {
        setChannels([]);
        return;
      }
      const data = await res.json();
      setChannels(data.channels ?? []);
    } catch {
      setChannels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, reloadTick]);

  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  return { channels, loading, reload };
}
