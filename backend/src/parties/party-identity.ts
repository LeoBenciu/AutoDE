export type PartyKindValue = 'INDIVIDUAL' | 'COMPANY';
export type PartyIdentifierTypeValue = 'CUI' | 'CNP' | 'FOREIGN_ID';

export function normalizePartyCountry(value?: string | null): string {
  const country = String(value ?? '').trim().toUpperCase();
  if (['ROMANIA', 'ROMÂNIA', 'ROU'].includes(country)) return 'RO';
  return country || 'RO';
}

export function expectedIdentifierType(
  kind: PartyKindValue,
  country?: string | null,
): PartyIdentifierTypeValue {
  if (kind === 'COMPANY') return 'CUI';
  return normalizePartyCountry(country) === 'RO' ? 'CNP' : 'FOREIGN_ID';
}

export function normalizeIdentifierType(
  value: unknown,
  kind: PartyKindValue,
  country?: string | null,
): PartyIdentifierTypeValue {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (normalized === 'CUI' || normalized === 'CNP' || normalized === 'FOREIGN_ID') {
    return normalized;
  }
  return expectedIdentifierType(kind, country);
}

export function privateSellerIdentityErrors(input: {
  kind: PartyKindValue;
  country?: string | null;
  identifierType?: PartyIdentifierTypeValue | null;
  taxId?: string | null;
}): string[] {
  const errors: string[] = [];
  const country = normalizePartyCountry(input.country);
  const expected = expectedIdentifierType(input.kind, country);
  const identifierType = input.identifierType ?? expected;
  const taxId = String(input.taxId ?? '').trim().toUpperCase();

  if (input.kind !== 'INDIVIDUAL') {
    errors.push('Vânzătorul din contractul de achiziție trebuie să fie persoană fizică');
    return errors;
  }
  if (!/^[A-Z]{2}$/.test(country)) {
    errors.push('Țara vânzătorului trebuie completată cu un cod ISO din 2 litere');
  }
  if (identifierType !== expected) {
    errors.push(
      country === 'RO'
        ? 'Tipul identificatorului vânzătorului român trebuie să fie CNP'
        : 'Tipul identificatorului vânzătorului străin trebuie să fie identificator extern',
    );
  }
  if (country === 'RO') {
    if (!taxId) {
      errors.push('CNP-ul vânzătorului este obligatoriu');
    } else if (!/^\d{13}$/.test(taxId)) {
      errors.push('CNP-ul vânzătorului trebuie să conțină exact 13 cifre');
    } else if (!isValidRomanianCnp(taxId)) {
      errors.push('CNP-ul vânzătorului este invalid; verifică data și cifra de control');
    }
  } else if (!taxId) {
    errors.push('Identificatorul personal extern al vânzătorului este obligatoriu');
  }
  return errors;
}

export function isValidRomanianCnp(value: string): boolean {
  if (!/^[1-9]\d{12}$/.test(value)) return false;
  const sexAndCentury = Number(value[0]);
  const year = Number(value.slice(1, 3));
  const month = Number(value.slice(3, 5));
  const day = Number(value.slice(5, 7));
  const century =
    sexAndCentury <= 2
      ? 1900
      : sexAndCentury <= 4
        ? 1800
        : sexAndCentury <= 6
          ? 2000
          : undefined;
  if (century != null) {
    const date = new Date(Date.UTC(century + year, month - 1, day));
    if (
      date.getUTCFullYear() !== century + year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return false;
    }
  } else if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }

  const weights = '279146358279';
  const sum = [...value.slice(0, 12)].reduce(
    (total, digit, index) => total + Number(digit) * Number(weights[index]),
    0,
  );
  const control = sum % 11 === 10 ? 1 : sum % 11;
  return control === Number(value[12]);
}
