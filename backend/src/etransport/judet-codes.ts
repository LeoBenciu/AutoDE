/**
 * ANAF e-Transport `codJudet` — the numeric Romanian county code the v2 XSD
 * requires as an integer on each `<locatie>`. It is the ANAF geographic
 * nomenclator (Ordin 401/2008 / D394 județ codes) DUKIntegrator validates
 * against, NOT the 2-letter auto/plate code ("AG"). Sending the plate code is
 * what triggers ANAF's `'AG' is not a valid value for 'integer'` rejection.
 *
 * Watch the non-alphabetical tail: 40 = București, 41 = DGAMC (not a county),
 * 51 = Călărași, 52 = Giurgiu.
 */
const COD_JUDET_BY_AUTO: Record<string, number> = {
  AB: 1, AR: 2, AG: 3, BC: 4, BH: 5, BN: 6, BT: 7, BV: 8, BR: 9, BZ: 10,
  CS: 11, CJ: 12, CT: 13, CV: 14, DB: 15, DJ: 16, GL: 17, GJ: 18, HR: 19,
  HD: 20, IL: 21, IS: 22, IF: 23, MM: 24, MH: 25, MS: 26, NT: 27, OT: 28,
  PH: 29, SM: 30, SJ: 31, SB: 32, SV: 33, TR: 34, TM: 35, TL: 36, VS: 37,
  VL: 38, VN: 39, B: 40, CL: 51, GR: 52,
};

/** County full name (diacritics stripped, letters only) → auto/plate code. */
const AUTO_BY_NAME: Record<string, string> = {
  alba: 'AB', arad: 'AR', arges: 'AG', bacau: 'BC', bihor: 'BH',
  bistritanasaud: 'BN', botosani: 'BT', brasov: 'BV', braila: 'BR',
  buzau: 'BZ', carasseverin: 'CS', calarasi: 'CL', cluj: 'CJ',
  constanta: 'CT', covasna: 'CV', dambovita: 'DB', dimbovita: 'DB',
  dolj: 'DJ', galati: 'GL', giurgiu: 'GR', gorj: 'GJ', harghita: 'HR',
  hunedoara: 'HD', ialomita: 'IL', iasi: 'IS', ilfov: 'IF', maramures: 'MM',
  mehedinti: 'MH', mures: 'MS', neamt: 'NT', olt: 'OT', prahova: 'PH',
  satumare: 'SM', salaj: 'SJ', sibiu: 'SB', suceava: 'SV', teleorman: 'TR',
  timis: 'TM', tulcea: 'TL', vaslui: 'VS', valcea: 'VL', vilcea: 'VL',
  vrancea: 'VN', bucuresti: 'B',
};

/**
 * Resolves a Romanian county — given as an auto/plate code ("AG"), a full name
 * ("Argeș"/"Arges"/"Județul Argeș") or an already-numeric code — to the numeric
 * ANAF e-Transport `codJudet`. Returns '' when it cannot be resolved so a
 * required-field error surfaces at ANAF instead of silently sending a wrong
 * (or non-integer) county.
 */
export function eTransportCodJudet(value: unknown): string {
  if (value == null) return '';
  const raw = String(value).trim();
  if (!raw) return '';

  // Already the numeric code (idempotent / pre-resolved input).
  if (/^\d+$/.test(raw)) return raw;

  // Auto/plate code (AG, CJ, B, …), any casing/spacing.
  const asCode = raw.toUpperCase().replace(/\s+/g, '');
  if (COD_JUDET_BY_AUTO[asCode] != null) return String(COD_JUDET_BY_AUTO[asCode]);

  // Full name → decompose diacritics then keep letters only (NFD splits "ș"
  // into "s" + a combining mark, which the letters-only filter drops).
  let key = raw
    .normalize('NFD')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  key = key.replace(/^(judetul|judet|jud|municipiul|mun)/, '');
  if (key.includes('bucuresti')) return String(COD_JUDET_BY_AUTO.B);

  const auto = AUTO_BY_NAME[key];
  return auto ? String(COD_JUDET_BY_AUTO[auto]) : '';
}
