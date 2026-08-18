// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import { Step4ScheduleSend } from './step4-schedule-send';
import { useChannels } from '@/hooks/use-channels';
import type { MessageTemplate } from '@/types';

afterEach(cleanup);

vi.mock('@/hooks/use-channels', () => ({
  useChannels: vi.fn(),
}));

// Chainable Supabase query-builder stub, matching the convention already
// established in src/components/inbox/message-thread.test.tsx — every
// builder method resolves via `.then` so calculateReach's
// `.from('contacts').select(...)` chain in this component's effect
// resolves without hitting a real Supabase client (no env vars in this
// test run) or leaving an unhandled rejection.
function createChainable(result: { count: number; data: unknown[]; error: null } = { count: 0, data: [], error: null }) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'order', 'eq', 'in', 'update', 'insert', 'delete']) {
    chain[method] = () => chain;
  }
  chain.then = (
    resolve: (value: typeof result) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => createChainable(),
  }),
}));

const messages = {
  Broadcasts: {
    wizard: {
      back: 'Back',
      cancel: 'Cancel',
      scheduleSend: {
        title: 'Review & Send',
        subtitle: 'Give your broadcast a name and confirm sending.',
        broadcastName: 'Broadcast Name',
        broadcastNamePlaceholder: 'e.g., Summer Promo',
        summary: 'Summary',
        template: 'Template:',
        audience: 'Audience:',
        audienceAll: 'All contacts',
        audienceTags: 'Filtered by tags',
        audienceField: 'Filtered by custom field',
        audienceCsv: 'CSV upload',
        saveDraft: 'Save as Draft',
        sendNow: 'Send Broadcast',
        sending: 'Sending...',
        confirmTitle: 'Confirm Broadcast',
        confirmDesc:
          'You are about to send this broadcast to <countTag>{count}</countTag> contacts using the <templateTag>{templateName}</templateTag> template. This action cannot be undone.',
        channel: 'Send from',
        uazapiWarning:
          'This channel uses an unofficial WhatsApp connection. Sending many messages back-to-back risks the number getting flagged. Consider adding a delay between sends.',
        delayLabel: 'Delay between sends',
        delayUnit: 'ms',
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

const template: MessageTemplate = {
  id: 'tpl-1',
  name: 'Promo',
  language: 'en_US',
} as MessageTemplate;

const TWO_CHANNELS = [
  {
    id: 'ch-meta',
    account_id: 'a',
    provider: 'meta' as const,
    label: 'Sales',
    status: 'connected' as const,
    is_default: true,
    created_at: '',
    updated_at: '',
  },
  {
    id: 'ch-uazapi',
    account_id: 'a',
    provider: 'uazapi' as const,
    label: 'Support',
    status: 'connected' as const,
    is_default: false,
    created_at: '',
    updated_at: '',
  },
];

const ONE_CHANNEL = [TWO_CHANNELS[0]];

function baseProps() {
  return {
    name: 'My Broadcast',
    onNameChange: vi.fn(),
    template,
    audience: { type: 'all' },
    onSend: vi.fn(),
    onBack: vi.fn(),
    isProcessing: false,
    progress: 0,
    channelId: null as string | null,
    onChannelIdChange: vi.fn(),
    sendDelayMs: null as number | null,
    onSendDelayMsChange: vi.fn(),
  };
}

describe('Step4ScheduleSend channel picker', () => {
  it('shows the UAZAPI warning + delay input only when a uazapi channel is selected', () => {
    vi.mocked(useChannels).mockReturnValue({
      channels: TWO_CHANNELS,
      loading: false,
      reload: vi.fn(),
    });

    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <Step4ScheduleSend {...baseProps()} channelId="ch-uazapi" />
      </NextIntlClientProvider>,
    );

    expect(
      screen.getByText(
        'This channel uses an unofficial WhatsApp connection. Sending many messages back-to-back risks the number getting flagged. Consider adding a delay between sends.',
      ),
    ).toBeInTheDocument();
    // The delay label's text nodes ("Delay between sends" / "ms") sit
    // alongside the <Input> element inside the same <label>, so
    // getByText can't match the full label string as one node — query
    // the number input itself (role="spinbutton" for type="number").
    expect(screen.getByRole('spinbutton')).toBeInTheDocument();

    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <Step4ScheduleSend {...baseProps()} channelId="ch-meta" />
      </NextIntlClientProvider>,
    );

    expect(
      screen.queryByText(
        'This channel uses an unofficial WhatsApp connection. Sending many messages back-to-back risks the number getting flagged. Consider adding a delay between sends.',
      ),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  it('auto-selects the only connected channel when nothing is chosen yet', () => {
    vi.mocked(useChannels).mockReturnValue({
      channels: ONE_CHANNEL,
      loading: false,
      reload: vi.fn(),
    });

    const onChannelIdChange = vi.fn();
    renderWithIntl(
      <Step4ScheduleSend {...baseProps()} channelId={null} onChannelIdChange={onChannelIdChange} />,
    );

    expect(onChannelIdChange).toHaveBeenCalledWith('ch-meta');
  });

  it('resets sendDelayMs to null when switching away from a UAZAPI channel', () => {
    vi.mocked(useChannels).mockReturnValue({
      channels: TWO_CHANNELS,
      loading: false,
      reload: vi.fn(),
    });

    const onSendDelayMsChange = vi.fn();
    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <Step4ScheduleSend
          {...baseProps()}
          channelId="ch-uazapi"
          sendDelayMs={2000}
          onSendDelayMsChange={onSendDelayMsChange}
        />
      </NextIntlClientProvider>,
    );

    expect(onSendDelayMsChange).not.toHaveBeenCalled();

    // Switch to a Meta channel — the delay input disappears, but
    // `sendDelayMs` is still 2000 in the parent's state until it reacts
    // to the callback below (matching how the real parent page wires
    // channelId/sendDelayMs as independent state).
    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <Step4ScheduleSend
          {...baseProps()}
          channelId="ch-meta"
          sendDelayMs={2000}
          onSendDelayMsChange={onSendDelayMsChange}
        />
      </NextIntlClientProvider>,
    );

    expect(onSendDelayMsChange).toHaveBeenCalledWith(null);
  });

  it('does not render the picker when there is only one connected channel', () => {
    vi.mocked(useChannels).mockReturnValue({
      channels: ONE_CHANNEL,
      loading: false,
      reload: vi.fn(),
    });

    renderWithIntl(<Step4ScheduleSend {...baseProps()} channelId="ch-meta" />);

    expect(screen.queryByText('Send from')).not.toBeInTheDocument();
  });
});
