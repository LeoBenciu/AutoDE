const BNR_RATES_URL = 'https://www.bnr.ro/nbrfxrates.xml';

export interface BnrRate {
  currency: string;
  rate: number;
  rateDate: string;
}

const cache = new Map<string, { value: BnrRate; expiresAt: number }>();
const CACHE_TTL_MS = 15 * 60 * 1000;

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

/** Latest BNR rate valid when the declaration is made (weekends use the last publication). */
export async function resolveCurrentBnrRate(currencyInput: string): Promise<BnrRate> {
  const currency = currencyInput.trim().toUpperCase();
  if (currency === 'RON') {
    return { currency, rate: 1, rateDate: new Date().toISOString().slice(0, 10) };
  }

  const cached = cache.get(currency);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const response = await fetch(BNR_RATES_URL, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`BNR a răspuns cu HTTP ${response.status}`);
  const rate = parseBnrRateXml(await response.text(), currency);
  cache.set(currency, { value: rate, expiresAt: Date.now() + CACHE_TTL_MS });
  return rate;
}
