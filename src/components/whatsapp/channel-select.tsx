'use client';

import { useTranslations } from 'next-intl';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { Channel } from '@/types';

const DEFAULT_SENTINEL = '__account_default__';

export interface ChannelSelectProps {
  channels: Channel[];
  value: string | null;
  onChange: (channelId: string | null) => void;
  allowDefault?: boolean;
  connectedOnly?: boolean;
  placeholder?: string;
  className?: string;
}

/**
 * Shared channel picker — inbox badge/switcher, broadcast wizard,
 * Flows/Automations send_message step config all render this instead
 * of hand-rolling a Select over `useChannels()`'s result.
 */
export function ChannelSelect({
  channels,
  value,
  onChange,
  allowDefault = false,
  connectedOnly = true,
  placeholder,
  className,
}: ChannelSelectProps) {
  const t = useTranslations('WhatsappChannels');
  const options = connectedOnly
    ? channels.filter((c) => c.status === 'connected')
    : channels;

  return (
    <Select
      value={value ?? DEFAULT_SENTINEL}
      onValueChange={(v) => onChange(v === DEFAULT_SENTINEL ? null : v)}
    >
      <SelectTrigger className={cn('bg-muted', className)}>
        <SelectValue placeholder={placeholder ?? t('selectChannel')} />
      </SelectTrigger>
      <SelectContent>
        {allowDefault && (
          <SelectItem value={DEFAULT_SENTINEL}>{t('accountDefault')}</SelectItem>
        )}
        {options.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            {c.label} ({c.provider})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
