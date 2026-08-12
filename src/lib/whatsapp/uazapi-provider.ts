import {
  sendUazapiText,
  sendUazapiMedia,
  sendUazapiMenu,
  fetchUazapiInstanceStatus,
} from './uazapi-api'
import { renderTemplateBody } from './template-body'
import type {
  WhatsAppProvider,
  SendTextArgs,
  SendMediaArgs,
  SendTemplateArgs,
  SendInteractiveButtonsArgs,
  SendInteractiveListArgs,
  ProviderSendResult,
  ConnectionInfo,
} from './provider'

export interface UazapiProviderConfig {
  baseUrl: string
  instanceToken: string
}

/**
 * Adapts uazapi-api.ts's free functions to the shared WhatsAppProvider
 * interface — the UAZAPI counterpart to meta-provider.ts.
 *
 * sendTemplate is the one method with real logic: UAZAPI has no
 * template-approval system (per the design spec's "Camada de envio"),
 * so the local `message_templates` row is rendered to a plain send at
 * call time instead of referencing an approved template by name:
 *   - Quick-reply buttons present  → sendInteractiveButtons (menu).
 *   - No buttons, media header set → sendMedia, caption = rendered body.
 *   - Otherwise                    → sendText with the rendered body.
 * URL/COPY_CODE/PHONE_NUMBER buttons have no UAZAPI menu equivalent
 * confirmed without a live instance — they're silently dropped from
 * the send (documented parity gap; the rendered body text still goes
 * out either way).
 */
export function createUazapiProvider(config: UazapiProviderConfig): WhatsAppProvider {
  const { baseUrl, instanceToken } = config

  return {
    async sendText(args: SendTextArgs): Promise<ProviderSendResult> {
      const result = await sendUazapiText({ baseUrl, instanceToken, to: args.to, text: args.text })
      return { messageId: result.messageId }
    },

    async sendMedia(args: SendMediaArgs): Promise<ProviderSendResult> {
      const result = await sendUazapiMedia({
        baseUrl,
        instanceToken,
        to: args.to,
        kind: args.kind,
        link: args.link,
        caption: args.caption,
      })
      return { messageId: result.messageId }
    },

    async sendTemplate(args: SendTemplateArgs): Promise<ProviderSendResult> {
      const { to, template, messageParams, params, templateName } = args
      const bodyValues = messageParams?.body ?? params ?? []
      const text = template?.body_text
        ? renderTemplateBody(template.body_text, bodyValues)
        : bodyValues.join(' ') || templateName

      const quickReplyButtons = (template?.buttons ?? []).filter((b) => b.type === 'QUICK_REPLY')
      if (quickReplyButtons.length > 0) {
        const result = await sendUazapiMenu({
          baseUrl,
          instanceToken,
          to,
          text,
          choices: quickReplyButtons.map((b) => b.text),
        })
        return { messageId: result.messageId }
      }

      const mediaLink = messageParams?.headerMediaUrl ?? template?.header_media_url
      if (template?.header_type && template.header_type !== 'text' && mediaLink) {
        const result = await sendUazapiMedia({
          baseUrl,
          instanceToken,
          to,
          kind: template.header_type,
          link: mediaLink,
          caption: text,
        })
        return { messageId: result.messageId }
      }

      const result = await sendUazapiText({ baseUrl, instanceToken, to, text })
      return { messageId: result.messageId }
    },

    async sendInteractiveButtons(args: SendInteractiveButtonsArgs): Promise<ProviderSendResult> {
      const result = await sendUazapiMenu({
        baseUrl,
        instanceToken,
        to: args.to,
        text: args.bodyText,
        choices: args.buttons.map((b) => b.title),
      })
      return { messageId: result.messageId }
    },

    async sendInteractiveList(args: SendInteractiveListArgs): Promise<ProviderSendResult> {
      const choices = args.sections.flatMap((section) => section.rows).map((row) => row.title)
      const result = await sendUazapiMenu({
        baseUrl,
        instanceToken,
        to: args.to,
        text: args.bodyText,
        choices,
      })
      return { messageId: result.messageId }
    },

    async verifyConnection(): Promise<ConnectionInfo> {
      try {
        const status = await fetchUazapiInstanceStatus({ baseUrl, instanceToken })
        return { connected: status.status === 'connected', detail: status.status }
      } catch (err) {
        return { connected: false, detail: err instanceof Error ? err.message : 'Unknown error' }
      }
    },
  }
}
