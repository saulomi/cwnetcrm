import { describe, it, expect, vi } from 'vitest'
import { createUazapiProvider } from './uazapi-provider'
import type { MessageTemplate } from '@/types'

const sendUazapiText = vi.fn(async () => ({ messageId: 'uaz-text' }))
const sendUazapiMedia = vi.fn(async () => ({ messageId: 'uaz-media' }))
const sendUazapiMenu = vi.fn(async () => ({ messageId: 'uaz-menu' }))
const fetchUazapiInstanceStatus = vi.fn(async () => ({ status: 'connected' as const, phone: '5511999998888' }))

vi.mock('./uazapi-api', () => ({
  sendUazapiText: (...args: unknown[]) => (sendUazapiText as unknown as (...a: unknown[]) => unknown)(...args),
  sendUazapiMedia: (...args: unknown[]) => (sendUazapiMedia as unknown as (...a: unknown[]) => unknown)(...args),
  sendUazapiMenu: (...args: unknown[]) => (sendUazapiMenu as unknown as (...a: unknown[]) => unknown)(...args),
  fetchUazapiInstanceStatus: (...args: unknown[]) =>
    (fetchUazapiInstanceStatus as unknown as (...a: unknown[]) => unknown)(...args),
}))

const CONFIG = { baseUrl: 'https://demo.uazapi.example', instanceToken: 'tok-1' }

describe('createUazapiProvider', () => {
  it('sendText forwards to sendUazapiText', async () => {
    const provider = createUazapiProvider(CONFIG)
    const result = await provider.sendText({ to: '+5511999998888', text: 'hi' })
    expect(result).toEqual({ messageId: 'uaz-text' })
    expect(sendUazapiText).toHaveBeenCalledWith({
      baseUrl: CONFIG.baseUrl,
      instanceToken: CONFIG.instanceToken,
      to: '+5511999998888',
      text: 'hi',
    })
  })

  it('sendMedia forwards to sendUazapiMedia', async () => {
    const provider = createUazapiProvider(CONFIG)
    await provider.sendMedia({ to: '+5511999998888', kind: 'image', link: 'https://x/y.jpg', caption: 'cap' })
    expect(sendUazapiMedia).toHaveBeenCalledWith({
      baseUrl: CONFIG.baseUrl,
      instanceToken: CONFIG.instanceToken,
      to: '+5511999998888',
      kind: 'image',
      link: 'https://x/y.jpg',
      caption: 'cap',
    })
  })

  it('sendInteractiveButtons maps button titles to menu choices', async () => {
    const provider = createUazapiProvider(CONFIG)
    await provider.sendInteractiveButtons({
      to: '+5511999998888',
      bodyText: 'Pick one',
      buttons: [{ id: 'yes', title: 'Yes' }, { id: 'no', title: 'No' }],
    })
    expect(sendUazapiMenu).toHaveBeenCalledWith({
      baseUrl: CONFIG.baseUrl,
      instanceToken: CONFIG.instanceToken,
      to: '+5511999998888',
      text: 'Pick one',
      choices: ['Yes', 'No'],
    })
  })

  it('sendInteractiveList flattens every section row into one choice list', async () => {
    const provider = createUazapiProvider(CONFIG)
    await provider.sendInteractiveList({
      to: '+5511999998888',
      bodyText: 'Choose',
      buttonLabel: 'Open',
      sections: [
        { title: 'A', rows: [{ id: '1', title: 'One' }] },
        { title: 'B', rows: [{ id: '2', title: 'Two' }] },
      ],
    })
    expect(sendUazapiMenu).toHaveBeenCalledWith({
      baseUrl: CONFIG.baseUrl,
      instanceToken: CONFIG.instanceToken,
      to: '+5511999998888',
      text: 'Choose',
      choices: ['One', 'Two'],
    })
  })

  it('verifyConnection maps a connected instance', async () => {
    const provider = createUazapiProvider(CONFIG)
    const result = await provider.verifyConnection()
    expect(result).toEqual({ connected: true, detail: 'connected' })
  })

  describe('sendTemplate', () => {
    const template: MessageTemplate = {
      id: 't1',
      user_id: 'u1',
      name: 'promo',
      category: 'Marketing',
      body_text: 'Hi {{1}}, {{2}} is on sale',
      buttons: [{ type: 'QUICK_REPLY', text: 'Interested' }],
      created_at: '2026-01-01T00:00:00Z',
    }

    it('sends via the menu endpoint when the template has quick-reply buttons', async () => {
      const provider = createUazapiProvider(CONFIG)
      await provider.sendTemplate({
        to: '+5511999998888',
        templateName: 'promo',
        template,
        messageParams: { body: ['Ada', 'the widget'] },
      })
      expect(sendUazapiMenu).toHaveBeenCalledWith({
        baseUrl: CONFIG.baseUrl,
        instanceToken: CONFIG.instanceToken,
        to: '+5511999998888',
        text: 'Hi Ada, the widget is on sale',
        choices: ['Interested'],
      })
    })

    it('sends via the media endpoint when the template has a media header and no buttons', async () => {
      const provider = createUazapiProvider(CONFIG)
      const mediaTemplate: MessageTemplate = {
        ...template,
        buttons: undefined,
        header_type: 'image',
        header_media_url: 'https://x/banner.jpg',
      }
      await provider.sendTemplate({
        to: '+5511999998888',
        templateName: 'promo',
        template: mediaTemplate,
        messageParams: { body: ['Ada', 'the widget'] },
      })
      expect(sendUazapiMedia).toHaveBeenCalledWith({
        baseUrl: CONFIG.baseUrl,
        instanceToken: CONFIG.instanceToken,
        to: '+5511999998888',
        kind: 'image',
        link: 'https://x/banner.jpg',
        caption: 'Hi Ada, the widget is on sale',
      })
    })

    it('falls back to plain text when there is no media header and no buttons', async () => {
      const provider = createUazapiProvider(CONFIG)
      const textTemplate: MessageTemplate = { ...template, buttons: undefined }
      await provider.sendTemplate({
        to: '+5511999998888',
        templateName: 'promo',
        template: textTemplate,
        messageParams: { body: ['Ada', 'the widget'] },
      })
      expect(sendUazapiText).toHaveBeenCalledWith({
        baseUrl: CONFIG.baseUrl,
        instanceToken: CONFIG.instanceToken,
        to: '+5511999998888',
        text: 'Hi Ada, the widget is on sale',
      })
    })

    it('falls back to legacy params + templateName when no template row is available', async () => {
      const provider = createUazapiProvider(CONFIG)
      await provider.sendTemplate({ to: '+5511999998888', templateName: 'promo', params: ['Ada'] })
      expect(sendUazapiText).toHaveBeenCalledWith({
        baseUrl: CONFIG.baseUrl,
        instanceToken: CONFIG.instanceToken,
        to: '+5511999998888',
        text: 'Ada',
      })
    })
  })
})
