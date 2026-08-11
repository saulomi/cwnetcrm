import type { MediaKind, InteractiveButton, InteractiveListSection } from './meta-api'
import type { MessageTemplate } from '@/types'
import type { SendTimeParams } from './template-send-builder'

export interface SendTextArgs {
  to: string
  text: string
  contextMessageId?: string
}

export interface SendMediaArgs {
  to: string
  kind: MediaKind
  link: string
  caption?: string
  filename?: string
  contextMessageId?: string
}

export interface SendTemplateArgs {
  to: string
  templateName: string
  language?: string
  params?: string[]
  template?: MessageTemplate
  messageParams?: SendTimeParams
  contextMessageId?: string
}

export interface SendInteractiveButtonsArgs {
  to: string
  bodyText: string
  headerText?: string
  footerText?: string
  buttons: InteractiveButton[]
  contextMessageId?: string
}

export interface SendInteractiveListArgs {
  to: string
  bodyText: string
  buttonLabel: string
  headerText?: string
  footerText?: string
  sections: InteractiveListSection[]
  contextMessageId?: string
}

export interface ProviderSendResult {
  messageId: string
}

export interface ConnectionInfo {
  connected: boolean
  detail?: string
}

/**
 * Shape every WhatsApp send-side integration implements, so the rest of
 * the app (send-message, broadcast-core, the Flows/Automations engines)
 * calls one interface regardless of which provider backs the channel.
 *
 * Argument shapes intentionally follow Meta's Cloud API model — the
 * only provider this plan implements. UAZAPI's own provider (a later
 * plan) adapts UAZAPI's endpoints to this same shape; if UAZAPI's send
 * semantics genuinely can't fit it, that's the point where the
 * interface grows a provider-neutral shape — not before, per YAGNI.
 */
export interface WhatsAppProvider {
  sendText(args: SendTextArgs): Promise<ProviderSendResult>
  sendMedia(args: SendMediaArgs): Promise<ProviderSendResult>
  sendTemplate(args: SendTemplateArgs): Promise<ProviderSendResult>
  sendInteractiveButtons(args: SendInteractiveButtonsArgs): Promise<ProviderSendResult>
  sendInteractiveList(args: SendInteractiveListArgs): Promise<ProviderSendResult>
  verifyConnection(): Promise<ConnectionInfo>
}
