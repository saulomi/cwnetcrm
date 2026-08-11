# Suporte a múltiplos provedores de WhatsApp (Meta + UAZAPI)

Status: Plano 1 (schema) implementado
Data: 2026-08-10

## Objetivo

Hoje o CRM só conecta via Meta WhatsApp Cloud API (1 número por conta). O
objetivo é permitir conectar também via UAZAPI (API não-oficial, conexão por
QR code — como WhatsApp Web), **com múltiplos canais simultâneos por conta**
(ex.: 1 número Meta + 1 número UAZAPI, ou vários UAZAPI), sem quebrar o
comportamento existente do Meta.

Escopo do v1 para UAZAPI: texto, mídia, mensagens interativas (botões/lista)
e broadcasts — feature-paridade com Meta, exceto templates aprovados (a
UAZAPI não tem sistema de aprovação de template; ver seção "Envio").

## Decisões de escopo (confirmadas com o usuário)

1. **Múltiplos canais simultâneos por conta** — não é "trocar de provedor",
   é ter N conexões ativas ao mesmo tempo.
2. **Conversa é única por contato**, não por canal. `conversations` ganha
   `channel_id` (o canal mais recente usado com esse contato) — mensagens de
   números diferentes para o mesmo contato aparecem na mesma thread. Trade-off
   aceito conscientemente: mais simples de exibir no inbox, em troca de
   misturar contexto de dois números na mesma janela quando isso acontece.
3. **UAZAPI cobre broadcast e mensagens interativas no v1**, não fica restrito
   a texto/mídia. Confirmado que a UAZAPI (uazapiGO) suporta menus interativos
   (botões/carrossel/lista/enquete) e envio em lote.

## Modelo de dados

Nova migration adiciona:

### `channels` (nova tabela — referência cross-provider)

```
id            uuid pk
account_id    uuid fk not null
provider      text check in ('meta','uazapi') not null
label         text not null              -- ex: "Vendas", "Suporte"
status        text check in ('connected','disconnected','connecting','error')
is_default    bool not null default false -- canal usado quando nada mais decide
created_by    uuid fk (profiles/user)
created_at    timestamptz
updated_at    timestamptz
```

Índice único parcial garantindo no máx. 1 `is_default=true` por `account_id`.

### `meta_channels` (renomeia `whatsapp_config`)

Mesmas colunas de hoje (`phone_number_id`, `waba_id`, `access_token`
encriptado, `verify_token` encriptado, `registered_at`,
`subscribed_apps_at`, `last_registration_error`, `status`, `connected_at`),
mais `channel_id uuid fk not null unique` referenciando `channels.id`.

Migration de dados: para cada linha existente em `whatsapp_config`, cria 1
linha em `channels` (`provider='meta'`, `is_default=true`, `status` copiado),
preenche `channel_id`. Uma **view de compatibilidade** `whatsapp_config`
(`meta_channels JOIN channels`) é criada para qualquer código não migrado
nesta fase continuar funcionando sem alteração.

### `uazapi_channels` (nova)

```
id              uuid pk
channel_id      uuid fk not null unique
instance_id     text not null
instance_token  text not null   -- encriptado (mesmo encryption.ts)
base_url        text not null   -- host do servidor UAZAPI (SaaS ou self-hosted)
connected_phone text
profile_name    text
qr_code         text            -- cache do QR atual; expira
webhook_secret  text            -- encriptado; valida requisições do webhook UAZAPI
last_error      text
created_at      timestamptz
updated_at      timestamptz
```

### Roteamento

- `conversations.channel_id` — nullable. `null` = usa o canal `is_default`
  da conta no momento do envio.
- `messages.channel_id` — preenchido no insert (qual canal essa mensagem
  específica usou), para auditoria/retry mesmo que o canal padrão da conversa
  mude depois.

Nenhuma coluna existente é removida. Nenhum dado existente muda de forma
observável pelo app.

## Camada de envio (outbound)

`src/lib/whatsapp/provider.ts` define a interface comum:

```ts
interface WhatsAppProvider {
  sendText(args): Promise<{ messageId: string }>
  sendMedia(args): Promise<{ messageId: string }>
  sendTemplate(args): Promise<{ messageId: string }>
  sendInteractiveButtons(args): Promise<{ messageId: string }>
  sendInteractiveList(args): Promise<{ messageId: string }>
  verifyConnection(): Promise<ConnectionInfo>
}
```

- `meta-provider.ts` — wrapper fino sobre `meta-api.ts` (existente, inalterado).
  Nenhuma lógica de negócio nova; só adapta a assinatura para a interface comum.
- `uazapi-provider.ts` (novo) — implementa a interface contra os endpoints da
  UAZAPI (`/send/text`, `/send/media`, `/send/menu`, etc.), autenticando com
  `instance_token` no header. Payload exato de cada endpoint é confirmado
  durante a implementação (com API key/instância real de teste), já que a
  documentação pública é uma SPA que não foi possível inspecionar
  estaticamente nesta fase.
- `resolveProvider(channel: Channel): WhatsAppProvider` — factory por
  `channel.provider`.

`sendTemplate` no provedor UAZAPI: não existe aprovação de template na
UAZAPI, então o `MessageTemplate` row é renderizado (variáveis já
substituídas, reusando `buildSendComponents`) e enviado como texto/mídia
comum; se o template tiver botões, usa `sendInteractiveButtons`.

`send-message.ts` passa a resolver `channel` (via `conversation.channel_id`
ou o `is_default` da conta) em vez de `whatsapp_config` fixo, carrega o
detail-row do provedor certo, e chama `resolveProvider(channel).sendX(...)`.
O restante da função (retry de variante de telefone, pause de flow run,
insert em `messages`) não muda — é agnóstico de provedor.

`broadcast-core.ts` e os `meta-send.ts` de `flows/` e `automations/` passam a
chamar essa mesma camada em vez de importar `meta-api.ts` diretamente — 3
call-sites trocados, lógica de negócio de cada um intocada.

## Entrada (inbound) — processor compartilhado

A lógica de `processMessage` do webhook Meta atual (find-or-create de
contato/conversa, reactions, dispatch para flows, automações, IA
auto-reply, fan-out de webhook — tudo após o parsing específico do payload)
é extraída para `src/lib/whatsapp/inbound-processor.ts`:

```ts
interface NormalizedInboundMessage {
  channelId: string
  accountId: string
  configOwnerUserId: string
  from: string                    // telefone E.164
  contactName: string
  waMessageId: string
  timestamp: string
  type: 'text' | 'image' | 'video' | 'document' | 'audio'
      | 'location' | 'reaction' | 'interactive'
  text?: string
  mediaUrl?: string                // já resolvido/proxied
  interactiveReplyId?: string
  replyToWaMessageId?: string
  reactionEmoji?: string
}

function processInboundMessage(
  msg: NormalizedInboundMessage
): Promise<{ consumed: boolean }>
```

- `/api/whatsapp/webhook/route.ts` (Meta, existente) passa a: validar
  assinatura HMAC (igual hoje) → achar `meta_channels` por `phone_number_id`
  → resolver `channel_id`/`account_id` → parse do formato Meta (media fetch
  via `getMediaUrl`, igual hoje) → montar `NormalizedInboundMessage` → chamar
  o processor. Comportamento observável idêntico ao atual.
- `/api/uazapi/webhook/route.ts` (novo) — valida o segredo do webhook (header
  custom comparado contra `uazapi_channels.webhook_secret`), acha
  `uazapi_channels` pelo `instance_id` do evento, parseia o formato UAZAPI
  (texto/mídia/botão/lista), monta o mesmo `NormalizedInboundMessage`, chama
  o mesmo processor. Flows, automações, IA e dedupe de contato funcionam para
  UAZAPI sem reescrita.

Status de mensagem (`sent`/`delivered`/`read`/`failed`): `handleStatusUpdate`
já é agnóstico de provedor (opera só sobre `message_id`); cada rota extrai o
status do seu formato de payload e chama a mesma função.

## UI — Settings

A tela de WhatsApp em Settings deixa de ser um formulário único e vira uma
**lista de canais** + "Adicionar canal":

- Lista: card por canal (label, badge do provedor, status, número/instância
  conectado). Ações: reconectar, editar label, definir como padrão, remover.
- "Adicionar canal" → escolhe provedor:
  - **Meta** — mesmo formulário de hoje (componente `WhatsAppConfig` vira
    `MetaChannelForm`, reusado como está), agora criando uma linha em
    `channels` + `meta_channels`.
  - **UAZAPI** (novo `UazapiChannelForm`) — label do canal, base URL,
    cria a instância (`POST /instance/init`), aciona conexão, mostra QR code
    (poll periódico até `connected`, com expiração/regeneração automática do
    QR). Ao conectar, grava `connected_phone` e marca `status='connected'`.

## Escolha de canal (roteamento)

Regra única, usada em todo call-site de envio:

1. `conversation.channel_id`, se setado.
2. Senão, o canal `is_default=true` da conta.
3. Se não há default e há mais de 1 canal conectado, falha com erro
   explícito em vez de adivinhar.

- **Inbox**: composer mostra o canal ativo da conversa (badge) com opção de
  trocar; troca só afeta envios futuros.
- **Flows/Automações**: passo de "enviar mensagem" ganha campo opcional
  "canal" (default = regra acima). Flows/automações já salvos continuam
  funcionando sem alteração (campo ausente = comportamento atual).
- **Broadcasts**: campo obrigatório de canal na criação (não há conversa
  para inferir de onde). Com 1 único canal conectado, é pré-selecionado sem
  fricção extra visível.

## Erros e operação

- Token/instância da UAZAPI encriptado com o `encryption.ts` já existente,
  mesmo padrão de auto-upgrade legacy→GCM.
- Webhook UAZAPI validado por segredo por canal (`webhook_secret`), já que
  o esquema de assinatura exato depende da instância/versão — confirmado na
  implementação.
- Desconexão de sessão (comum em API não-oficial — QR expira, celular fica
  offline, WhatsApp derruba a sessão): canal vira `status='disconnected'`,
  Settings mostra banner de reconexão com novo QR. Webhook de disconnect da
  UAZAPI atualiza o status; como rede de segurança, mesmo padrão de
  "Testar conexão" que já existe para Meta cobre health-check manual.
- Broadcast por canal UAZAPI ganha rate-limit configurável (delay entre
  envios) e aviso na UI sobre risco de bloqueio por volume — não bloqueia
  a ação, só avisa.

## Testes

- Migration: teste rodando contra um dump com `whatsapp_config` populado,
  confirmando que `channels` + `meta_channels` saem equivalentes e a view de
  compatibilidade responde igual ao select antigo.
- `inbound-processor.ts`: os testes que hoje cobrem `processMessage`
  indiretamente (`resolve-conversation.test.ts`, `registration.test.ts`)
  passam a exercitar o processor direto com `NormalizedInboundMessage` fake —
  mesma suite cobre os dois provedores, só troca o parser de entrada.
- `meta-provider.ts`: mesmas asserções de `meta-api.test.ts`, confirmando que
  o wrapper não alterou payload/comportamento (regressão zero).
- `uazapi-provider.ts`: testes novos com mock de fetch, no padrão dos testes
  Meta existentes.
- `send-message.ts`: teste dos 3 casos de resolução de canal (channel_id da
  conversa / default da conta / ambiguidade sem default).
- `npm run typecheck` + suite completa a cada fatia.

## Fora de escopo (v1)

- Grupos de WhatsApp.
- Catálogo/perfil de negócio via UAZAPI.
- Conversa dividida por canal (decisão explícita: conversa é 1:1 por
  contato, não por canal — ver "Decisões de escopo").
- Provedores além de Meta/UAZAPI.
