// src/lib/whatsapp/meta-provider.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createMetaProvider } from './meta-provider'

const sendTextMessage = vi.fn(async () => ({ messageId: 'wamid.text' }))
const sendMediaMessage = vi.fn(async () => ({ messageId: 'wamid.media' }))
const sendTemplateMessage = vi.fn(async () => ({ messageId: 'wamid.tpl' }))
const sendInteractiveButtons = vi.fn(async () => ({ messageId: 'wamid.btn' }))
const sendInteractiveList = vi.fn(async () => ({ messageId: 'wamid.list' }))
const verifyPhoneNumber = vi.fn(async () => ({
  id: 'pn-1',
  display_phone_number: '+15550000000',
}))

vi.mock('./meta-api', () => ({
  sendTextMessage: (...args: unknown[]) =>
    (sendTextMessage as unknown as (...a: unknown[]) => unknown)(...args),
  sendMediaMessage: (...args: unknown[]) =>
    (sendMediaMessage as unknown as (...a: unknown[]) => unknown)(...args),
  sendTemplateMessage: (...args: unknown[]) =>
    (sendTemplateMessage as unknown as (...a: unknown[]) => unknown)(...args),
  sendInteractiveButtons: (...args: unknown[]) =>
    (sendInteractiveButtons as unknown as (...a: unknown[]) => unknown)(...args),
  sendInteractiveList: (...args: unknown[]) =>
    (sendInteractiveList as unknown as (...a: unknown[]) => unknown)(...args),
  verifyPhoneNumber: (...args: unknown[]) =>
    (verifyPhoneNumber as unknown as (...a: unknown[]) => unknown)(...args),
}))

const CONFIG = { phoneNumberId: 'pn-1', accessToken: 'tok-1' }

describe('createMetaProvider', () => {
  it('sendText forwards phoneNumberId + accessToken + args to sendTextMessage', async () => {
    const provider = createMetaProvider(CONFIG)
    const result = await provider.sendText({
      to: '+15551234567',
      text: 'hi',
      contextMessageId: 'wamid.parent',
    })
    expect(result).toEqual({ messageId: 'wamid.text' })
    expect(sendTextMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
      to: '+15551234567',
      text: 'hi',
      contextMessageId: 'wamid.parent',
    })
  })

  it('sendMedia forwards to sendMediaMessage', async () => {
    const provider = createMetaProvider(CONFIG)
    await provider.sendMedia({
      to: '+15551234567',
      kind: 'image',
      link: 'https://x/y.jpg',
      caption: 'cap',
    })
    expect(sendMediaMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
      to: '+15551234567',
      kind: 'image',
      link: 'https://x/y.jpg',
      caption: 'cap',
    })
  })

  it('sendTemplate forwards to sendTemplateMessage', async () => {
    const provider = createMetaProvider(CONFIG)
    await provider.sendTemplate({
      to: '+15551234567',
      templateName: 'order_update',
      language: 'en',
      params: ['A123'],
    })
    expect(sendTemplateMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
      to: '+15551234567',
      templateName: 'order_update',
      language: 'en',
      params: ['A123'],
    })
  })

  it('sendInteractiveButtons forwards to sendInteractiveButtons', async () => {
    const provider = createMetaProvider(CONFIG)
    await provider.sendInteractiveButtons({
      to: '+15551234567',
      bodyText: 'Pick one',
      buttons: [{ id: 'a', title: 'A' }],
    })
    expect(sendInteractiveButtons).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
      to: '+15551234567',
      bodyText: 'Pick one',
      buttons: [{ id: 'a', title: 'A' }],
    })
  })

  it('sendInteractiveList forwards to sendInteractiveList', async () => {
    const provider = createMetaProvider(CONFIG)
    await provider.sendInteractiveList({
      to: '+15551234567',
      bodyText: 'Choose',
      buttonLabel: 'Menu',
      sections: [{ rows: [{ id: 'r1', title: 'Row 1' }] }],
    })
    expect(sendInteractiveList).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
      to: '+15551234567',
      bodyText: 'Choose',
      buttonLabel: 'Menu',
      sections: [{ rows: [{ id: 'r1', title: 'Row 1' }] }],
    })
  })

  it('verifyConnection reports connected on success', async () => {
    const provider = createMetaProvider(CONFIG)
    const info = await provider.verifyConnection()
    expect(info).toEqual({ connected: true })
    expect(verifyPhoneNumber).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
    })
  })

  it('verifyConnection reports disconnected with the error detail on failure', async () => {
    verifyPhoneNumber.mockRejectedValueOnce(new Error('Meta API error: 401'))
    const provider = createMetaProvider(CONFIG)
    const info = await provider.verifyConnection()
    expect(info).toEqual({ connected: false, detail: 'Meta API error: 401' })
  })
})
