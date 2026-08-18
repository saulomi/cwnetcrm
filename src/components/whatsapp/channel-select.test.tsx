// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import { ChannelSelect } from './channel-select';
import type { Channel } from '@/types';

afterEach(cleanup);

const messages = {
  WhatsappChannels: {
    selectChannel: 'Select a channel',
    accountDefault: 'Account default',
  },
};

function renderWithIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

const channels: Channel[] = [
  { id: 'ch-1', account_id: 'a', provider: 'meta', label: 'Sales', status: 'connected', is_default: true, created_at: '', updated_at: '' },
  { id: 'ch-2', account_id: 'a', provider: 'uazapi', label: 'Support', status: 'connected', is_default: false, created_at: '', updated_at: '' },
  { id: 'ch-3', account_id: 'a', provider: 'uazapi', label: 'Stale', status: 'disconnected', is_default: false, created_at: '', updated_at: '' },
];

describe('ChannelSelect', () => {
  it('lists only connected channels by default', async () => {
    const user = userEvent.setup();
    renderWithIntl(<ChannelSelect channels={channels} value={null} onChange={vi.fn()} />);
    await user.click(screen.getByRole('combobox'));
    expect(await screen.findByText('Sales (meta)')).toBeInTheDocument();
    expect(screen.getByText('Support (uazapi)')).toBeInTheDocument();
    expect(screen.queryByText('Stale (uazapi)')).not.toBeInTheDocument();
  });

  it('includes disconnected channels when connectedOnly=false', async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <ChannelSelect channels={channels} value={null} onChange={vi.fn()} connectedOnly={false} />,
    );
    await user.click(screen.getByRole('combobox'));
    expect(await screen.findByText('Stale (uazapi)')).toBeInTheDocument();
  });

  it('shows an "account default" option only when allowDefault is set, and emits null for it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithIntl(
      <ChannelSelect channels={channels} value={null} onChange={onChange} allowDefault />,
    );
    await user.click(screen.getByRole('combobox'));
    const defaultOption = await screen.findByText('Account default');
    await user.click(defaultOption);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('does not show an "account default" option when allowDefault is unset', async () => {
    const user = userEvent.setup();
    renderWithIntl(<ChannelSelect channels={channels} value={null} onChange={vi.fn()} />);
    await user.click(screen.getByRole('combobox'));
    await screen.findByText('Sales (meta)');
    expect(screen.queryByText('Account default')).not.toBeInTheDocument();
  });

  it('emits the channel id when a real channel is picked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithIntl(<ChannelSelect channels={channels} value={null} onChange={onChange} />);
    await user.click(screen.getByRole('combobox'));
    const option = await screen.findByText('Support (uazapi)');
    await user.click(option);
    expect(onChange).toHaveBeenCalledWith('ch-2');
  });
});
