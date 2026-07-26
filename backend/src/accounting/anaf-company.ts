import {
  BadGatewayException,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

const ANAF_COMPANY_LOOKUP_URL =
  'https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva';

type AnafRecord = Record<string, unknown>;

export interface AnafCompanyDetails {
  source: 'ANAF';
  lookupDate: string;
  cui: string;
  name: string | null;
  registrationNumber: string | null;
  registrationDate: string | null;
  address: string | null;
  country: 'RO';
  county: string | null;
  city: string | null;
  iban: string | null;
  email: string | null;
  phone: string | null;
  primaryCaen: string | null;
  status: string | null;
  isVatPayer: boolean | null;
  hasTvaLaIncasare: boolean | null;
}

export function normalizeRomanianCui(value: string): string {
  const cui = String(value ?? '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/^RO/i, '');

  if (!/^\d{2,10}$/.test(cui)) {
    throw new BadRequestException(
      'CUI invalid. Folosește între 2 și 10 cifre, opțional cu prefixul RO.',
    );
  }

  return cui;
}

export async function lookupAnafCompany(
  value: string,
  options: {
    now?: Date;
    fetcher?: typeof fetch;
    url?: string;
  } = {},
): Promise<AnafCompanyDetails> {
  const cui = normalizeRomanianCui(value);
  const lookupDate = romanianDate(options.now ?? new Date());
  const fetcher = options.fetcher ?? fetch;
  let response: Response;

  try {
    response = await fetcher(
      options.url ??
        process.env.ANAF_COMPANY_LOOKUP_URL ??
        ANAF_COMPANY_LOOKUP_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ cui: Number(cui), data: lookupDate }]),
        signal: AbortSignal.timeout(7000),
      },
    );
  } catch {
    throw new ServiceUnavailableException(
      'Serviciul ANAF nu este disponibil momentan. Încearcă din nou.',
    );
  }

  // ANAF occasionally returns its normal `found`/`notFound` payload with a
  // 404 status, so parse that status the same way Finova does.
  if (!response.ok && response.status !== 404) {
    throw new BadGatewayException(
      `ANAF nu a putut procesa verificarea CUI-ului (${response.status}).`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (response.status === 404) {
      throw new NotFoundException(
        'Nu s-au găsit date în ANAF pentru acest CUI.',
      );
    }
    throw new BadGatewayException('ANAF a returnat un răspuns nevalid.');
  }

  const company = firstFoundCompany(payload);
  if (!company) {
    throw new NotFoundException(
      'Nu s-au găsit date în ANAF pentru acest CUI.',
    );
  }

  return mapAnafCompany(company, cui, lookupDate);
}

export function mapAnafCompany(
  company: AnafRecord,
  cui: string,
  lookupDate: string,
): AnafCompanyDetails {
  const general = record(company.date_generale);
  const socialAddress = record(company.adresa_sediu_social);
  const vat = record(company.inregistrare_scop_Tva);
  const vatOnCollection = record(company.inregistrare_RTVAI);

  return {
    source: 'ANAF',
    lookupDate,
    cui,
    name: text(general.denumire),
    registrationNumber: text(general.nrRegCom),
    registrationDate: text(general.data_inregistrare),
    address: text(general.adresa),
    country: 'RO',
    county: text(socialAddress.sdenumire_Judet),
    city: text(socialAddress.sdenumire_Localitate),
    iban: text(general.iban),
    email: text(general.email),
    phone: text(general.telefon),
    primaryCaen: text(general.cod_CAEN),
    status: text(general.stare_inregistrare),
    isVatPayer: booleanValue(vat.scpTVA),
    hasTvaLaIncasare: booleanValue(vatOnCollection.statusTvaIncasare),
  };
}

function firstFoundCompany(payload: unknown): AnafRecord | null {
  const root = record(payload);
  const found = Array.isArray(root.found) ? root.found : [];
  const company = found[0];
  return company && typeof company === 'object'
    ? (company as AnafRecord)
    : null;
}

function record(value: unknown): AnafRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AnafRecord)
    : {};
}

function text(value: unknown): string | null {
  const normalized = value == null ? '' : String(value).trim();
  return normalized || null;
}

function booleanValue(value: unknown): boolean | null {
  if (value === true || value === 1 || value === '1' || value === 'true') {
    return true;
  }
  if (value === false || value === 0 || value === '0' || value === 'false') {
    return false;
  }
  return null;
}

function romanianDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Bucharest',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
