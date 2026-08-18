// src/components/settings/channels-list.tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Plus,
  Star,
  Trash2,
  Pencil,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { SettingsPanelHead } from './settings-panel-head';
import { WhatsAppConfig } from './whatsapp-config';
import { UazapiChannelForm } from './uazapi-channel-form';
import type { Channel } from '@/types';

type ChannelWithDetail = Channel & {
  meta?: { phone_number_id: string; waba_id: string | null; registered_at: string | null; last_registration_error: string | null };
  uazapi?: { instance_id: string; base_url: string; connected_phone: string | null; profile_name: string | null; last_error: string | null };
};

function statusBadge(status: Channel['status'], t: (key: string) => string) {
  switch (status) {
    case 'connected':
      return (
        <Badge variant="secondary" className="gap-1 text-emerald-400">
          <CheckCircle2 className="size-3" /> {status}
        </Badge>
      );
    case 'error':
      return (
        <Badge variant="destructive" className="gap-1">
          <XCircle className="size-3" /> {t('connectionError')}
        </Badge>
      );
    case 'connecting':
      return (
        <Badge variant="outline" className="gap-1">
          <Loader2 className="size-3 animate-spin" /> {t('connecting')}
        </Badge>
      );
    default:
      return <Badge variant="outline">{t('notConnected')}</Badge>;
  }
}

function ChannelCard({
  channel,
  onChanged,
}: {
  channel: ChannelWithDetail;
  onChanged: () => void;
}) {
  const t = useTranslations('Settings.whatsapp.channels');
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(channel.label);
  const [saving, setSaving] = useState(false);

  async function patch(body: Record<string, unknown>) {
    setSaving(true);
    try {
      const res = await fetch(`/api/channels/${channel.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || 'Failed to update channel');
        return;
      }
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    if (!confirm(t('removeConfirm'))) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/channels/${channel.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || 'Failed to remove channel');
        return;
      }
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  const detail =
    channel.provider === 'meta'
      ? channel.meta?.phone_number_id
      : channel.uazapi?.connected_phone || channel.uazapi?.instance_id;

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            {editing ? (
              <Input
                autoFocus
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onBlur={() => {
                  setEditing(false);
                  if (label.trim() && label !== channel.label) patch({ label: label.trim() });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
                className="h-7 max-w-48"
              />
            ) : (
              <span className="font-medium text-foreground">{channel.label}</span>
            )}
            <Badge variant="outline" className="uppercase">{channel.provider}</Badge>
            {channel.is_default && (
              <Badge variant="secondary" className="gap-1">
                <Star className="size-3" /> {t('default')}
              </Badge>
            )}
            {statusBadge(channel.status, t)}
          </div>
          {detail && <p className="truncate text-xs text-muted-foreground">{detail}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="icon-sm" disabled={saving} onClick={() => setEditing(true)}>
            <Pencil className="size-4" />
          </Button>
          {!channel.is_default && (
            <Button variant="outline" size="sm" disabled={saving} onClick={() => patch({ is_default: true })}>
              {t('setDefault')}
            </Button>
          )}
          <Button
            variant="outline"
            size="icon-sm"
            disabled={saving}
            onClick={handleRemove}
            className="border-red-900 text-red-400 hover:bg-red-950/40"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ChannelsList() {
  const t = useTranslations('Settings.whatsapp');
  const tc = useTranslations('Settings.whatsapp.channels');
  const [channels, setChannels] = useState<ChannelWithDetail[] | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addStep, setAddStep] = useState<'choose' | 'meta' | 'uazapi'>('choose');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/channels');
      if (!res.ok) {
        toast.error(tc('loadFailed'));
        setChannels([]);
        return;
      }
      const data = await res.json();
      setChannels(data.channels ?? []);
    } catch {
      toast.error(tc('loadFailed'));
      setChannels([]);
    }
  }, [tc]);

  useEffect(() => {
    load();
  }, [load]);

  function closeAdd() {
    setAddOpen(false);
    setAddStep('choose');
    load();
  }

  // meta_channels has UNIQUE(account_id) — an account can only ever have
  // one Meta channel. Picking "Meta" from the chooser when one already
  // exists lands on <WhatsAppConfig />, which fetches and pre-fills that
  // existing row and updates it on submit, not a fresh add — so the card
  // must be disabled once a Meta channel is already connected.
  const hasMetaChannel = (channels ?? []).some((c) => c.provider === 'meta');

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-foreground">{tc('heading')}</h3>
          <p className="text-xs text-muted-foreground">{tc('headingDesc')}</p>
        </div>
        <Button onClick={() => setAddOpen(true)} size="sm" className="gap-1.5">
          <Plus className="size-4" /> {tc('addChannel')}
        </Button>
      </div>

      {channels === null ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      ) : channels.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {tc('empty')}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {channels.map((c) => (
            <ChannelCard key={c.id} channel={c} onChanged={load} />
          ))}
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={(open) => (open ? setAddOpen(true) : closeAdd())}>
        <DialogContent className="sm:max-w-lg">
          {addStep === 'choose' && (
            <>
              <DialogHeader>
                <DialogTitle>{tc('chooseProvider')}</DialogTitle>
                <DialogDescription>{tc('chooseProviderDesc')}</DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Card
                  className={
                    hasMetaChannel
                      ? 'cursor-not-allowed opacity-50'
                      : 'cursor-pointer hover:border-primary'
                  }
                  aria-disabled={hasMetaChannel}
                  onClick={() => {
                    if (!hasMetaChannel) setAddStep('meta');
                  }}
                >
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm">{tc('providerMeta')}</CardTitle>
                    <p className="text-xs text-muted-foreground">
                      {hasMetaChannel ? tc('providerMetaTaken') : tc('providerMetaDesc')}
                    </p>
                  </CardHeader>
                </Card>
                <Card
                  className="cursor-pointer hover:border-primary"
                  onClick={() => setAddStep('uazapi')}
                >
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm">{tc('providerUazapi')}</CardTitle>
                    <p className="text-xs text-muted-foreground">{tc('providerUazapiDesc')}</p>
                  </CardHeader>
                </Card>
              </div>
            </>
          )}
          {addStep === 'meta' && <WhatsAppConfig />}
          {addStep === 'uazapi' && <UazapiChannelForm onConnected={closeAdd} />}
        </DialogContent>
      </Dialog>
    </section>
  );
}
