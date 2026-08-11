import { useLocale } from "next-intl";
import { enUS, ko, ptBR, type Locale } from "date-fns/locale";

const DATE_FNS_LOCALES: Record<string, Locale> = {
  en: enUS,
  ko,
  "pt-BR": ptBR,
};

/**
 * date-fns formatters (formatDistanceToNow, format, etc.) default to
 * English regardless of NEXT_PUBLIC_APP_LOCALE — they need their own
 * `locale` option. This maps the active next-intl locale to the
 * matching date-fns locale so relative timestamps ("2 hours ago" vs
 * "há 2 horas") match the rest of the UI.
 */
export function useDateFnsLocale(): Locale {
  const locale = useLocale();
  return DATE_FNS_LOCALES[locale] ?? enUS;
}
