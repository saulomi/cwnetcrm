import en from "../../../messages/en.json";

type TemplateCopy = { name: string; description: string };

const MESSAGES: Record<string, typeof en> = {
  en,
};

// Lazily populated — most deployments run a single locale, so we only
// load the JSON files actually needed instead of bundling all of them
// into every server route that touches templates.
async function loadMessages(locale: string): Promise<typeof en> {
  if (MESSAGES[locale]) return MESSAGES[locale];
  try {
    const mod = await import(`../../../messages/${locale}.json`);
    MESSAGES[locale] = mod.default ?? mod;
  } catch {
    MESSAGES[locale] = en;
  }
  return MESSAGES[locale];
}

/**
 * Server-side (non-React) lookup of a template's localized display
 * name/description, keyed the same way as the client-side gallery
 * (`Flows.list.templateGallery.<slug>` / `Automations.list.templateGallery.<slug>`
 * in messages/*.json). Template-clone routes run outside any React
 * tree, so `next-intl`'s `useTranslations` isn't available there —
 * this reads the same JSON files directly instead, driven by
 * `NEXT_PUBLIC_APP_LOCALE` (the single locale this app runs under).
 *
 * Falls back to the caller-supplied English default when the locale
 * file or the specific key is missing, so an unrecognized slug never
 * breaks template cloning — it just clones with English seed copy.
 */
export async function getLocalizedTemplateCopy(
  namespace: "Flows" | "Automations",
  slug: string,
  fallback: TemplateCopy,
): Promise<TemplateCopy> {
  const locale = process.env.NEXT_PUBLIC_APP_LOCALE || "en";
  const messages = await loadMessages(locale);
  const entry = (
    messages as unknown as Record<
      string,
      { list?: { templateGallery?: Record<string, TemplateCopy> } }
    >
  )[namespace]?.list?.templateGallery?.[slug];
  return entry ?? fallback;
}
