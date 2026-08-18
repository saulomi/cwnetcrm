// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import { NodeConfigForm } from './node-config-form';
import { useChannels } from '@/hooks/use-channels';
import type { BuilderNode } from '../shared';

afterEach(cleanup);

vi.mock('@/hooks/use-channels', () => ({
  useChannels: vi.fn(),
}));

const messages = {
  Flows: {
    builder: {
      form: {
        textToCustomer: 'Text sent to the customer',
        advancesTo: 'Advances to',
        pickNextNode: 'Pick a next node…',
        none: '— None —',
        channelOverride: 'Send via (optional)',
      },
    },
  },
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

const TWO_CHANNELS = [
  { id: 'ch-1', account_id: 'a', provider: 'meta' as const, label: 'Sales', status: 'connected' as const, is_default: true, created_at: '', updated_at: '' },
  { id: 'ch-2', account_id: 'a', provider: 'uazapi' as const, label: 'Support', status: 'connected' as const, is_default: false, created_at: '', updated_at: '' },
];

const ONE_CHANNEL = [TWO_CHANNELS[0]];

const sendMessageNode: BuilderNode = {
  node_key: 'n1',
  node_type: 'send_message',
  config: { text: '', next_node_key: '' },
};

describe('NodeConfigForm send_message channel override', () => {
  it('calls onUpdateConfig with channel_id when a channel is picked', async () => {
    vi.mocked(useChannels).mockReturnValue({
      channels: TWO_CHANNELS,
      loading: false,
      reload: vi.fn(),
    });

    const user = userEvent.setup();
    const onUpdateConfig = vi.fn();
    renderWithIntl(
      <NodeConfigForm
        node={sendMessageNode}
        allNodes={[sendMessageNode]}
        showAdvanced={false}
        onUpdateConfig={onUpdateConfig}
      />,
    );

    expect(screen.getByText('Send via (optional)')).toBeInTheDocument();

    const comboboxes = screen.getAllByRole('combobox');
    await user.click(comboboxes[0]);
    const option = await screen.findByText('Support (uazapi)');
    await user.click(option);

    expect(onUpdateConfig).toHaveBeenCalledWith({ channel_id: 'ch-2' });
  });

  it('renders nothing for the channel row when the account has fewer than 2 channels', () => {
    vi.mocked(useChannels).mockReturnValue({
      channels: ONE_CHANNEL,
      loading: false,
      reload: vi.fn(),
    });

    renderWithIntl(
      <NodeConfigForm
        node={sendMessageNode}
        allNodes={[sendMessageNode]}
        showAdvanced={false}
        onUpdateConfig={vi.fn()}
      />,
    );

    expect(screen.queryByText('Send via (optional)')).not.toBeInTheDocument();
  });
});
