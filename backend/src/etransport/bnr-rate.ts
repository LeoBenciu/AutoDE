const BNR_RATES_URL = 'https://www.bnr.ro/nbrfxrates.xml';
const CURSBNR_API_URL = 'https://www.cursbnr.ro/api/json.php';

export interface BnrRate {
  currency: string;
  rate: number;
  rateDate: string;
}

const cache = new Map<string, { value: BnrRate; expiresAt: number }>();
const CACHE_TTL_MS = 15 * 60 * 1000;

// Currencies BNR quotes per 100 units; cursbnr.ro exposes them under a "100XXX"
// code and returns the value for 100 units, so divide back to a per-unit rate.
const PER_100_CURRENCIES = new Set(['HUF', 'JPY', 'KRW', 'IDR', 'ISK']);

const todayInRomania = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Bucharest',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

/** Parse the official BNR XML feed, including currencies quoted per 100 units. */
export function parseBnrRateXml(xml: string, requestedCurrency: string): BnrRate {
  const currency = requestedCurrency.trim().toUpperCase();
  const cubeMatch = xml.match(/<Cube\b[^>]*\bdate="([^"]+)"[^>]*>([\s\S]*?)<\/Cube>/i);
  if (!cubeMatch) throw new Error('Răspunsul BNR nu conține un curs valutar publicat');

  const rateTags = cubeMatch[2].match(/<Rate\b[^>]*>[^<]+<\/Rate>/gi) ?? [];
  const rateTag = rateTags.find((tag) => new RegExp(`\\bcurrency="${currency}"`, 'i').test(tag));
  if (!rateTag) throw new Error(`BNR nu a publicat un curs pentru ${currency}`);

  const rawRate = Number(rateTag.match(/>([^<]+)</)?.[1]);
  const multiplier = Number(rateTag.match(/\bmultiplier="(\d+)"/i)?.[1] ?? 1);
  const rate = rawRate / multiplier;
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`Curs BNR invalid pentru ${currency}`);

  return { currency, rate, rateDate: cubeMatch[1] };
}

/** Parse a cursbnr.ro JSON payload (single-currency `{date, currency, value}`). */
export function parseCursBnrPayload(payload: any, requestedCurrency: string, fallbackDate?: string): BnrRate {
  const currency = requestedCurrency.trim().toUpperCase();
  if (payload?.error) throw new Error(`cursbnr.ro: ${payload.error}`);
  const divisor = PER_100_CURRENCIES.has(currency) ? 100 : 1;
  const raw = Number(payload?.value);
  const rate = raw / divisor;
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`Curs cursbnr.ro invalid pentru ${currency}`);
  const rateDate = String(payload?.date ?? fallbackDate ?? '').slice(0, 10);
  return { currency, rate, rateDate: rateDate || todayInRomania() };
}

/** Fetch a rate from cursbnr.ro, optionally for a specific historical date. */
async function fetchCursBnrRate(currency: string, date?: string): Promise<BnrRate> {
  const param = PER_100_CURRENCIES.has(currency) ? `100${currency}` : currency;
  const url = new URL(CURSBNR_API_URL);
  url.searchParams.set('currency', param);
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) url.searchParams.set('date', date);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(5000),
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`cursbnr.ro a răspuns cu HTTP ${response.status}`);
  return parseCursBnrPayload(await response.json(), currency, date);
}

/** Fetch the current rate from the official bnr.ro XML feed. */
async function fetchBnrXmlRate(currency: string): Promise<BnrRate> {
  const response = await fetch(BNR_RATES_URL, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`BNR a răspuns cu HTTP ${response.status}`);
  return parseBnrRateXml(await response.text(), currency);
}

/**
 * Resolve a BNR rate for a currency, optionally on a given date.
 *
 * cursbnr.ro is tried first: it is date-aware (the e-Transport conversion date
 * is legally significant) and reachable from datacenters where the official
 * bnr.ro feed is WAF-blocked. The bnr.ro XML (current day only) is the fallback.
 */
export async function resolveBnrRate(currencyInput: string, date?: string): Promise<BnrRate> {
  const currency = currencyInput.trim().toUpperCase();
  if (currency === 'RON') {
    return { currency, rate: 1, rateDate: date ?? todayInRomania() };
  }

  const key = `${currency}|${date ?? ''}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let rate: BnrRate;
  try {
    rate = await fetchCursBnrRate(currency, date);
  } catch (cursError) {
    try {
      rate = await fetchBnrXmlRate(currency);
    } catch (xmlError) {
      throw new Error(
        `${(cursError as Error).message}; ${(xmlError as Error).message}`,
      );
    }
  }
  cache.set(key, { value: rate, expiresAt: Date.now() + CACHE_TTL_MS });
  return rate;
}

/** Latest BNR rate valid when the declaration is made (weekends use the last publication). */
export async function resolveCurrentBnrRate(currencyInput: string): Promise<BnrRate> {
  return resolveBnrRate(currencyInput);
}
