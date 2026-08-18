// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NextIntlClientProvider } from 'next-intl'
import type { ReactElement } from 'react'
import { StepEditor, type BuilderStep } from './automation-builder'
import { useChannels } from '@/hooks/use-channels'

afterEach(cleanup)

vi.mock('@/hooks/use-channels', () => ({
  useChannels: vi.fn(),
}))

const messages = {
  Automations: {
    builder: {
      config: {
        messageText: 'Message text',
        placeholderMessageText: 'Hi! Thanks for reaching out…',
        channelOverride: 'Send via (optional)',
      },
    },
  },
  WhatsappChannels: {
    selectChannel: 'Select a channel',
    accountDefault: 'Account default',
  },
}

function renderWithIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  )
}

const TWO_CHANNELS = [
  { id: 'ch-1', account_id: 'a', provider: 'meta' as const, label: 'Sales', status: 'connected' as const, is_default: true, created_at: '', updated_at: '' },
  { id: 'ch-2', account_id: 'a', provider: 'uazapi' as const, label: 'Support', status: 'connected' as const, is_default: false, created_at: '', updated_at: '' },
]

const ONE_CHANNEL = [TWO_CHANNELS[0]]

const sendMessageStep: BuilderStep = {
  cid: 'c1',
  step_type: 'send_message',
  step_config: { text: '' },
}

describe('StepEditor send_message channel override', () => {
  it('calls onChange with channel_id when a channel is picked', async () => {
    vi.mocked(useChannels).mockReturnValue({
      channels: TWO_CHANNELS,
      loading: false,
      reload: vi.fn(),
    })

    const user = userEvent.setup()
    const onChange = vi.fn()
    renderWithIntl(<StepEditor step={sendMessageStep} onChange={onChange} />)

    expect(screen.getByText('Send via (optional)')).toBeInTheDocument()

    const comboboxes = screen.getAllByRole('combobox')
    await user.click(comboboxes[0])
    const option = await screen.findByText('Support (uazapi)')
    await user.click(option)

    expect(onChange).toHaveBeenCalledWith({
      ...sendMessageStep,
      step_config: { ...sendMessageStep.step_config, channel_id: 'ch-2' },
    })
  })

  it('renders nothing for the channel row when the account has fewer than 2 channels', () => {
    vi.mocked(useChannels).mockReturnValue({
      channels: ONE_CHANNEL,
      loading: false,
      reload: vi.fn(),
    })

    renderWithIntl(<StepEditor step={sendMessageStep} onChange={vi.fn()} />)

    expect(screen.queryByText('Send via (optional)')).not.toBeInTheDocument()
  })
})
