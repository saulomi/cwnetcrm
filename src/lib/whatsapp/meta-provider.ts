import {
  sendTextMessage as metaSendText,
  sendMediaMessage as metaSendMedia,
  sendTemplateMessage as metaSendTemplate,
  sendInteractiveButtons as metaSendInteractiveButtons,
  sendInteractiveList as metaSendInteractiveList,
  verifyPhoneNumber,
} from './meta-api'
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

export interface MetaProviderConfig {
  phoneNumberId: string
  accessToken: string
}

/**
 * Thin adapter over meta-api.ts's free functions — binds phoneNumberId +
 * accessToken once so callers don't thread them through every send call.
 * Carries zero business logic of its own: every method is a direct
 * pass-through, kept that way deliberately so a `meta-api.test.ts`
 * regression on the underlying function is the only place Meta-specific
 * behaviour needs testing.
 */
export function createMetaProvider(config: MetaProviderConfig): WhatsAppProvider {
  const { phoneNumberId, accessToken } = config

  return {
    async sendText(args: SendTextArgs): Promise<ProviderSendResult> {
      return metaSendText({ phoneNumberId, accessToken, ...args })
    },
    async sendMedia(args: SendMediaArgs): Promise<ProviderSendResult> {
      return metaSendMedia({ phoneNumberId, accessToken, ...args })
    },
    async sendTemplate(args: SendTemplateArgs): Promise<ProviderSendResult> {
      return metaSendTemplate({ phoneNumberId, accessToken, ...args })
    },
    async sendInteractiveButtons(
      args: SendInteractiveButtonsArgs
    ): Promise<ProviderSendResult> {
      return metaSendInteractiveButtons({ phoneNumberId, accessToken, ...args })
    },
    async sendInteractiveList(args: SendInteractiveListArgs): Promise<ProviderSendResult> {
      return metaSendInteractiveList({ phoneNumberId, accessToken, ...args })
    },
    async verifyConnection(): Promise<ConnectionInfo> {
      try {
        await verifyPhoneNumber({ phoneNumberId, accessToken })
        return { connected: true }
      } catch (err) {
        return {
          connected: false,
          detail: err instanceof Error ? err.message : 'Unknown error',
        }
      }
    },
  }
}
