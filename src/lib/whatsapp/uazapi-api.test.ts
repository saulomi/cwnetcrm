import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  UazapiApiError,
  initUazapiInstance,
  connectUazapiInstance,
  fetchUazapiInstanceStatus,
  sendUazapiText,
  sendUazapiMedia,
  sendUazapiMenu,
  disconnectUazapiInstance,
} from './uazapi-api'

const BASE = 'https://demo.uazapi.example'
const TOKEN = 'inst-token-1'

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

describe('initUazapiInstance', () => {
  it('POSTs /instance/init and returns id + token', async () => {
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({ instance: { id: 'inst-1', token: TOKEN } })
    )
    const result = await initUazapiInstance({ baseUrl: BASE, name: 'Sales' })
    expect(result).toEqual({ id: 'inst-1', token: TOKEN })
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe(`${BASE}/instance/init`)
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: 'Sales' })
  })

  it('throws UazapiApiError on a non-2xx response', async () => {
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({ error: 'bad request' }, false, 400)
    )
    await expect(initUazapiInstance({ baseUrl: BASE, name: 'Sales' })).rejects.toBeInstanceOf(
      UazapiApiError
    )
  })
})

describe('connectUazapiInstance', () => {
  it('sends the instance token header and returns status + qrCode', async () => {
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({ instance: { status: 'connecting', qrcode: 'base64QR' } })
    )
    const result = await connectUazapiInstance({ baseUrl: BASE, instanceToken: TOKEN })
    expect(result).toEqual({ status: 'connecting', qrCode: 'base64QR' })
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe(`${BASE}/instance/connect`)
    expect((init as RequestInit & { headers: Record<string, string> }).headers.token).toBe(TOKEN)
  })
})

describe('fetchUazapiInstanceStatus', () => {
  it('maps a connected instance', async () => {
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({ instance: { status: 'connected', owner: '5511999998888', profileName: 'Ada' } })
    )
    const result = await fetchUazapiInstanceStatus({ baseUrl: BASE, instanceToken: TOKEN })
    expect(result).toEqual({ status: 'connected', phone: '5511999998888', profileName: 'Ada' })
  })
})

describe('sendUazapiText', () => {
  it('POSTs /send/text with number + text and returns the message id', async () => {
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({ id: 'uaz-msg-1' }))
    const result = await sendUazapiText({ baseUrl: BASE, instanceToken: TOKEN, to: '+55 11 99999-8888', text: 'oi' })
    expect(result).toEqual({ messageId: 'uaz-msg-1' })
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      number: '5511999998888',
      text: 'oi',
    })
  })

  it('falls back to messageid when id is absent', async () => {
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({ messageid: 'uaz-msg-2' }))
    const result = await sendUazapiText({ baseUrl: BASE, instanceToken: TOKEN, to: '5511999998888', text: 'oi' })
    expect(result).toEqual({ messageId: 'uaz-msg-2' })
  })
})

describe('sendUazapiMedia', () => {
  it('POSTs /send/media with the mapped kind and file link', async () => {
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({ id: 'uaz-msg-3' }))
    await sendUazapiMedia({
      baseUrl: BASE,
      instanceToken: TOKEN,
      to: '5511999998888',
      kind: 'image',
      link: 'https://x/y.jpg',
      caption: 'cap',
    })
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe(`${BASE}/send/media`)
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      number: '5511999998888',
      type: 'image',
      file: 'https://x/y.jpg',
      caption: 'cap',
    })
  })
})

describe('sendUazapiMenu', () => {
  it('POSTs /send/menu with the choices array', async () => {
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({ id: 'uaz-msg-4' }))
    await sendUazapiMenu({
      baseUrl: BASE,
      instanceToken: TOKEN,
      to: '5511999998888',
      text: 'Pick one',
      choices: ['Yes', 'No'],
    })
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe(`${BASE}/send/menu`)
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      number: '5511999998888',
      type: 'button',
      text: 'Pick one',
      choices: ['Yes', 'No'],
    })
  })
})

describe('disconnectUazapiInstance', () => {
  it('DELETEs /instance with the token header', async () => {
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({}))
    await disconnectUazapiInstance({ baseUrl: BASE, instanceToken: TOKEN })
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe(`${BASE}/instance`)
    expect((init as RequestInit).method).toBe('DELETE')
  })
})
