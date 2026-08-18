// src/components/settings/uazapi-channel-form.tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Loader2, CheckCircle2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 2 * 60 * 1000;

type Stage = 'form' | 'creating' | 'qr' | 'connected' | 'timed-out';

export function UazapiChannelForm({ onConnected }: { onConnected: () => void }) {
  const t = useTranslations('Settings.whatsapp.channels');
  const tf = useTranslations('Settings.whatsapp.channels.form');

  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [stage, setStage] = useState<Stage>('form');
  const [channelId, setChannelId] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | null>(null);

  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollDeadline = useRef<number>(0);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  function stopPolling() {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }

  async function pollOnce(id: string) {
    try {
      const res = await fetch(`/api/uazapi/instance/${id}`);
      const data = await res.json();
      if (data.status === 'connected') {
        stopPolling();
        setPhone(data.phone ?? null);
        setStage('connected');
        return;
      }
      if (data.status === 'error') {
        stopPolling();
        toast.error(data.message || tf('createFailed'));
        setStage('form');
        return;
      }
      if (data.qrCode) setQrCode(data.qrCode);
    } catch (err) {
      console.error('UAZAPI poll failed:', err);
    } finally {
      if (pollTimer.current && Date.now() > pollDeadline.current) {
        stopPolling();
        setStage('timed-out');
      }
    }
  }

  function startPolling(id: string) {
    pollDeadline.current = Date.now() + POLL_TIMEOUT_MS;
    stopPolling();
    pollTimer.current = setInterval(() => pollOnce(id), POLL_INTERVAL_MS);
  }

  async function handleCreate() {
    if (!label.trim() || !baseUrl.trim()) {
      toast.error('Fill in both fields');
      return;
    }
    setStage('creating');
    try {
      const res = await fetch('/api/uazapi/instance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim(), base_url: baseUrl.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || tf('createFailed'));
        setStage('form');
        return;
      }
      setChannelId(data.channelId);
      setQrCode(data.qrCode ?? null);
      setStage('qr');
      startPolling(data.channelId);
    } catch (err) {
      console.error('UAZAPI create failed:', err);
      toast.error(tf('createFailed'));
      setStage('form');
    }
  }

  function handleCheckAgain() {
    if (!channelId) return;
    setStage('qr');
    startPolling(channelId);
  }

  if (stage === 'connected') {
    return (
      <div className="space-y-4 py-2">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCircle2 className="size-5 text-emerald-400" />
            {tf('connected', { phone: phone ?? '' })}
          </DialogTitle>
        </DialogHeader>
        <Button onClick={onConnected} className="w-full">
          {t('addChannel')}
        </Button>
      </div>
    );
  }

  if (stage === 'qr' || stage === 'timed-out') {
    return (
      <div className="space-y-4 py-2">
        <DialogHeader>
          <DialogTitle>{tf('scanQr')}</DialogTitle>
        </DialogHeader>
        {qrCode && (
          <div className="flex justify-center">
            <img
              src={qrCode.startsWith('data:') ? qrCode : `data:image/png;base64,${qrCode}`}
              alt="QR code"
              className="size-56 rounded border border-border bg-white p-2"
            />
          </div>
        )}
        {stage === 'qr' ? (
          <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {tf('waitingForScan')}
          </p>
        ) : (
          <div className="space-y-2 text-center">
            <p className="text-sm text-amber-400">{tf('timedOut')}</p>
            <Button variant="outline" onClick={handleCheckAgain}>
              {tf('checkAgain')}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 py-2">
      <DialogHeader>
        <DialogTitle>{t('providerUazapi')}</DialogTitle>
        <DialogDescription>{t('providerUazapiDesc')}</DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label className="text-muted-foreground">{tf('label')}</Label>
        <Input
          placeholder={tf('labelPlaceholder')}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
        />
      </div>
      <div className="space-y-2">
        <Label className="text-muted-foreground">{tf('baseUrl')}</Label>
        <Input
          placeholder={tf('baseUrlPlaceholder')}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
        />
      </div>
      <Button onClick={handleCreate} disabled={stage === 'creating'} className="w-full">
        {stage === 'creating' ? (
          <>
            <Loader2 className="size-4 animate-spin" /> {tf('creating')}
          </>
        ) : (
          tf('create')
        )}
      </Button>
    </div>
  );
}
