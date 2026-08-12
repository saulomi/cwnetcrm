// ============================================================
// Raw UAZAPI REST wrapper — mirrors meta-api.ts's shape (one function
// per endpoint, throws UazapiApiError on non-2xx, plain fetch).
//
// ENDPOINT SHAPES ARE BEST-EFFORT, NOT VERIFIED AGAINST A LIVE
// INSTANCE — see docs/superpowers/plans/2026-08-12-uazapi-provider-
// plan-4-provider-ui.md, Task 2, for the exact assumptions and why.
// Every other module in this codebase talks only to the typed
// functions below, never to raw UAZAPI JSON, so correcting a payload
// shape against a real instance later is a single-file change.
// ============================================================

export class UazapiApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'UazapiApiError'
    this.status = status
  }
}

async function throwUazapiError(response: Response, fallback: string): Promise<never> {
  let detail = fallback
  try {
    const body = await response.json()
    detail = body?.error || body?.message || fallback
  } catch {
    // Non-JSON error body — keep the fallback message.
  }
  throw new UazapiApiError(detail, response.status)
}

/** UAZAPI's documented `number` format — bare digits, no `+`/formatting. */
function toUazapiNumber(phone: string): string {
  return phone.replace(/\D/g, '')
}

function authHeaders(instanceToken: string): Record<string, string> {
  return { 'Content-Type': 'application/json', token: instanceToken }
}

export interface UazapiInstance {
  id: string
  token: string
}

/**
 * Provision a brand-new instance on a UAZAPI server. Unauthenticated —
 * the instance (and its token) don't exist yet; the returned token
 * becomes this instance's own secret for every subsequent call.
 */
export async function initUazapiInstance(args: {
  baseUrl: string
  name: string
}): Promise<UazapiInstance> {
  const { baseUrl, name } = args
  const response = await fetch(`${baseUrl}/instance/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI init failed: ${response.status}`)
  }
  const data = await response.json()
  const instance = data.instance ?? data
  return { id: instance.id, token: instance.token }
}

export interface UazapiConnectResult {
  status: string
  qrCode?: string
}

/** Trigger the QR-code handshake for an existing instance. */
export async function connectUazapiInstance(args: {
  baseUrl: string
  instanceToken: string
}): Promise<UazapiConnectResult> {
  const { baseUrl, instanceToken } = args
  const response = await fetch(`${baseUrl}/instance/connect`, {
    method: 'POST',
    headers: authHeaders(instanceToken),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI connect failed: ${response.status}`)
  }
  const data = await response.json()
  const instance = data.instance ?? data
  return { status: instance.status, qrCode: instance.qrcode ?? undefined }
}

export interface UazapiStatusResult {
  status: 'connected' | 'connecting' | 'disconnected' | 'error'
  phone?: string
  profileName?: string
}

function normalizeUazapiStatus(raw: unknown): UazapiStatusResult['status'] {
  const s = String(raw ?? '').toLowerCase()
  if (s === 'connected' || s === 'open') return 'connected'
  if (s === 'connecting' || s === 'qrcode' || s === 'qr') return 'connecting'
  if (s === 'error' || s === 'failed') return 'error'
  return 'disconnected'
}

export async function fetchUazapiInstanceStatus(args: {
  baseUrl: string
  instanceToken: string
}): Promise<UazapiStatusResult> {
  const { baseUrl, instanceToken } = args
  const response = await fetch(`${baseUrl}/instance/status`, {
    method: 'GET',
    headers: authHeaders(instanceToken),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI status check failed: ${response.status}`)
  }
  const data = await response.json()
  const instance = data.instance ?? data
  return {
    status: normalizeUazapiStatus(instance.status),
    phone: instance.owner ?? undefined,
    profileName: instance.profileName ?? undefined,
  }
}

export interface UazapiSendResult {
  messageId: string
}

function extractMessageId(data: Record<string, unknown>): string {
  return String(data.id ?? data.messageid ?? '')
}

export async function sendUazapiText(args: {
  baseUrl: string
  instanceToken: string
  to: string
  text: string
}): Promise<UazapiSendResult> {
  const { baseUrl, instanceToken, to, text } = args
  const response = await fetch(`${baseUrl}/send/text`, {
    method: 'POST',
    headers: authHeaders(instanceToken),
    body: JSON.stringify({ number: toUazapiNumber(to), text }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI send/text failed: ${response.status}`)
  }
  return { messageId: extractMessageId(await response.json()) }
}

export async function sendUazapiMedia(args: {
  baseUrl: string
  instanceToken: string
  to: string
  kind: 'image' | 'video' | 'document' | 'audio'
  link: string
  caption?: string
}): Promise<UazapiSendResult> {
  const { baseUrl, instanceToken, to, kind, link, caption } = args
  const body: Record<string, unknown> = { number: toUazapiNumber(to), type: kind, file: link }
  if (caption) body.caption = caption
  const response = await fetch(`${baseUrl}/send/media`, {
    method: 'POST',
    headers: authHeaders(instanceToken),
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI send/media failed: ${response.status}`)
  }
  return { messageId: extractMessageId(await response.json()) }
}

export async function sendUazapiMenu(args: {
  baseUrl: string
  instanceToken: string
  to: string
  text: string
  choices: string[]
}): Promise<UazapiSendResult> {
  const { baseUrl, instanceToken, to, text, choices } = args
  const response = await fetch(`${baseUrl}/send/menu`, {
    method: 'POST',
    headers: authHeaders(instanceToken),
    body: JSON.stringify({ number: toUazapiNumber(to), type: 'button', text, choices }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI send/menu failed: ${response.status}`)
  }
  return { messageId: extractMessageId(await response.json()) }
}

export async function disconnectUazapiInstance(args: {
  baseUrl: string
  instanceToken: string
}): Promise<void> {
  const { baseUrl, instanceToken } = args
  const response = await fetch(`${baseUrl}/instance`, {
    method: 'DELETE',
    headers: authHeaders(instanceToken),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI disconnect failed: ${response.status}`)
  }
}
