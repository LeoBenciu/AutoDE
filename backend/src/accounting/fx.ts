import { Logger } from '@nestjs/common';
import { CanonicalAccountingDocument } from './accounting-normalizer';

const logger = new Logger('AccountingFx');
const cache = new Map<string, number>();

export async function resolveExchangeRateToRon(
  document: CanonicalAccountingDocument,
): Promise<number> {
  if (document.currency === 'RON') return 1;
  if (document.exchangeRate && document.exchangeRate > 0) return document.exchangeRate;

  const date = document.documentDate ?? new Date().toISOString().slice(0, 10);
  const key = `${document.currency}|${date}`;
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const response = await fetch(
      `https://api.frankfurter.app/${date}?from=${encodeURIComponent(document.currency)}&to=RON`,
      { signal: AbortSignal.timeout(2500) },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as any;
    const rate = Number(data?.rates?.RON);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('curs RON absent');
    cache.set(key, rate);
    return rate;
  } catch (error) {
    logger.warn(
      `Nu s-a putut obține cursul ${document.currency}/RON pentru ${date}: ${(error as Error).message}`,
    );
    throw new Error(
      `Lipsește cursul ${document.currency}/RON. Completează cursul valutar înainte de aprobare.`,
    );
  }
}
