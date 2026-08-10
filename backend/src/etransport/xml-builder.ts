/**
 * Builds the RO e-Transport XML declaration (schema
 * `mfp:anaf:dgti:eTransport:declaratie:v2`).
 *
 * In the v2 schema almost every field is an XML *attribute*, not a child
 * element: `notificare`, `bunuriTransportate`, `partenerComercial`,
 * `dateTransport` and `locatie` all carry their data as attributes. Emitting
 * them as child elements is what triggered ANAF's
 * `Attribute 'codTipOperatiune' must appear on element 'notificare'` rejection.
 *
 * NOTE: element/attribute names follow the ANAF e-Transport v2 XSD, but ANAF
 * revises it periodically — validate against the current XSD (DUKIntegrator)
 * before production use. Endpoints and schema versions are configuration, not
 * code.
 */

import { eTransportCodJudet } from './judet-codes';

export interface DeclarationData {
  tenantCui: string;
  operationType: string; // AIC = intra-community acquisition
  transporter: { name: string; taxId: string; country: string };
  /**
   * Commercial partner (partenerComercial) — the other party in the trade, e.g.
   * the foreign seller for an acquisition. Distinct from the transporter; falls
   * back to the transporter when unknown.
   */
  partner?: { name: string; taxId?: string; country: string };
  vehiclePlate: string;
  trailerPlate?: string;
  loadingPlace: ETransportPlace;
  unloadingPlace: ETransportPlace;
  goods: Array<ETransportGood>;
  transportDate?: string; // ISO date
  /** Accompanying transport documents; the XSD requires at least one. */
  documents?: ETransportDocument[];
}

export interface ETransportPlace {
  country: string;
  county?: string;
  city?: string;
  address?: string;
  /**
   * Border crossing point / customs office code (`codPtf`). Left undefined by
   * default: the route is described by the loading/unloading `locatie` and a
   * border point is only declared when the operation explicitly needs one.
   */
  borderCrossingPoint?: string;
}

export interface ETransportDocument {
  /** 10 = CMR, 20 = Factură, 30 = Aviz de însoțire, 9999 = Altele. */
  tipDocument: string;
  /** ISO date (YYYY-MM-DD). */
  dataDocument: string;
  documentNumber?: string;
}

export interface ETransportGood {
  description: string;
  tariffCode?: string;
  /** Net weight; for an unpackaged vehicle this defaults to the gross cargo weight. */
  netWeightKg?: number;
  weightKg?: number;
  /** codScopOperatiune override; falls back to the per-operation default. */
  scopeCode?: string;
  /** Net invoice/document value in its original currency. */
  valueWithoutVat?: number;
  currency?: string;
  /** BNR-derived value used in the ANAF declaration. */
  valueRon?: number;
  exchangeRate?: number;
  exchangeRateDate?: string;
}

/** Codes defined by the ANAF e-Transport v2 nomenclature. */
export const OPERATION_CODES: Record<string, string> = {
  AIC: '10',
  LHI: '12',
  SCI: '14',
  LIC: '20',
  LHE: '22',
  SCE: '24',
  TTN: '30',
  IMP: '40',
  EXP: '50',
  DIN: '60',
  DIE: '70',
};

// Version 2 of ANAF's ETRANSP upload endpoint validates codScopOperatiune
// against the short-code enumeration (101, 201, ... 9901, 9999). The operation
// prefix must not be folded into this attribute: for example, AIC is expressed
// as codTipOperatiune="10" plus codScopOperatiune="101", not "100101".
// Ownership-transfer operations default to 101 (Comercializare); non-transfer,
// customs and warehousing flows use the generic 9999 scope.
const NON_TRANSFER_OPERATION_CODES = new Set(['12', '14', '22', '24', '40', '50', '60', '70']);
const VALID_SCOPE_CODES = new Set([
  '101',
  '201',
  '301',
  '401',
  '501',
  '601',
  '703',
  '704',
  '705',
  '801',
  '802',
  '901',
  '1001',
  '1101',
  '9901',
  '9999',
]);

export function defaultScopeCode(operationCode: string): string {
  return NON_TRANSFER_OPERATION_CODES.has(operationCode) ? '9999' : '101';
}

/**
 * Keep drafts created by older releases resubmittable. Those releases could
 * persist operation-prefixed scope codes such as 100101. ANAF v2 expects the
 * short suffix (101); fixed-purpose legacy codes such as 404001 have no valid
 * short suffix and therefore fall back to the operation's current default.
 */
export function normalizeScopeCode(scopeCode: unknown, operationCode: string): string {
  const raw = String(scopeCode ?? '').trim();
  if (!raw) return defaultScopeCode(operationCode);
  if (VALID_SCOPE_CODES.has(raw)) return raw;

  if (/^\d{6}$/.test(raw)) {
    const shortCode = String(Number(raw.slice(2)));
    if (VALID_SCOPE_CODES.has(shortCode)) return shortCode;
  }

  return defaultScopeCode(operationCode);
}

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const isBlank = (value: unknown): boolean =>
  value == null || String(value).trim() === '';

/** Bare tax id without a leading country prefix ("RO20752458" → "20752458"). */
function stripCountryPrefix(taxId: unknown, country: unknown): string {
  const id = String(taxId ?? '').trim().toUpperCase().replace(/\s+/g, '');
  const cc = String(country ?? '').trim().toUpperCase();
  return cc && id.startsWith(cc) ? id.slice(cc.length) : id;
}

/** Always-present attribute (empty string when missing, so required-field errors surface). */
const reqAttr = (name: string, value: unknown): string => ` ${name}="${esc(value)}"`;

/** Optional attribute, omitted entirely when blank. */
const attr = (name: string, value: unknown): string =>
  isBlank(value) ? '' : ` ${name}="${esc(value)}"`;

function buildPlace(tag: string, place: ETransportPlace): string {
  // The road leg on Romanian territory is described by a `locatie`, whose
  // codJudet (Romanian county) is required by the XSD. A foreign leg therefore
  // cannot be a locatie — it is represented by a border crossing point (codPtf),
  // emitted only when explicitly provided. So a locatie is written only for a
  // Romanian place (one that carries a county).
  // codJudet, denumireLocalitate and denumireStrada are all required and must be
  // non-empty (Str100, minLength 1): ANAF rejects both an empty value AND a
  // missing attribute. When no explicit street is given, fall back to the city
  // so the attribute is always present and non-empty — this mirrors SAGA, which
  // fills the street field with a locality label (e.g. "SEDIU") that ANAF accepts.
  const street = !isBlank(place.address) ? place.address : place.city;
  const locatie = !isBlank(place.county)
    ? `\n      <locatie${reqAttr('codJudet', eTransportCodJudet(place.county))}${reqAttr('denumireLocalitate', place.city ?? '')}${reqAttr('denumireStrada', street ?? '')}/>`
    : '';
  // codPtf (border crossing point) is an attribute of the route-leg element
  // (locStart/locFinalTraseuRutier) in the ANAF v2 schema — NOT of <dateTransport>
  // (that placement, valid only in the v1 XSD, is rejected by v2 with
  // "Attribute 'codPtf' is not allowed to appear in element 'dateTransport'").
  return `<${tag}${attr('codPtf', place.borderCrossingPoint)}>${locatie}\n    </${tag}>`;
}

export function buildETransportXml(d: DeclarationData): string {
  const operationCode = OPERATION_CODES[d.operationType] ?? '';
  const goods = d.goods
    .map((g) => {
      const scope = normalizeScopeCode(g.scopeCode, operationCode);
      // Schematron BR-207 requires greutateNeta for every operation except
      // 60/70. A transported vehicle has no packaging represented separately
      // in this model, so its gross cargo weight is the safe default.
      const netWeightKg = g.netWeightKg ?? g.weightKg;
      return `
    <bunuriTransportate${reqAttr('codScopOperatiune', scope)}${attr('codTarifar', g.tariffCode)}${reqAttr('denumireMarfa', g.description)}${reqAttr('cantitate', 1)}${reqAttr('codUnitateMasura', 'H87')}${reqAttr('greutateNeta', netWeightKg)}${reqAttr('greutateBruta', g.weightKg)}${attr('valoareLeiFaraTva', g.valueRon)}/>`;
    })
    .join('');

  // The XSD requires at least one documenteTransport. When none is supplied,
  // fall back to a CMR (the standard road-transport document) dated on the
  // transport day, so the notification is never incomplete.
  const documentList =
    d.documents && d.documents.length > 0
      ? d.documents
      : [{ tipDocument: '10', dataDocument: d.transportDate ?? '' }];
  const documents = documentList
    .map(
      (doc) =>
        `\n    <documenteTransport${reqAttr('tipDocument', doc.tipDocument)}${attr('numarDocument', doc.documentNumber)}${reqAttr('dataDocument', doc.dataDocument)}/>`,
    )
    .join('');

  // ANAF's cod/codOrgTransport is the bare tax id, without the country prefix:
  // for a RO organizer it must be "20752458", not "RO20752458" — the prefixed
  // form fails Schematron BR-043 (codOrgTransport must be filled/valid).
  const orgTaxId = stripCountryPrefix(d.transporter.taxId, d.transporter.country);
  // partenerComercial is the trade counterparty (the seller for an acquisition),
  // NOT the transporter — for an AIC it must be the foreign seller. Fall back to
  // the transporter only when the seller is unknown.
  const partner = d.partner ?? d.transporter;
  const partnerCode = stripCountryPrefix(partner.taxId, partner.country);
  // codPtf (border crossing point) is emitted by buildPlace on the foreign
  // route leg (locStart/locFinalTraseuRutier), where the v2 schema carries it —
  // NOT on <dateTransport>.
  return `<?xml version="1.0" encoding="UTF-8"?>
<eTransport xmlns="mfp:anaf:dgti:eTransport:declaratie:v2"${reqAttr('codDeclarant', d.tenantCui)}>
  <notificare${reqAttr('codTipOperatiune', operationCode)}>${goods}
    <partenerComercial${reqAttr('codTara', partner.country)}${attr('cod', partnerCode)}${reqAttr('denumire', partner.name)}/>
    <dateTransport${reqAttr('nrVehicul', d.vehiclePlate)}${attr('nrRemorca1', d.trailerPlate)}${reqAttr('codTaraOrgTransport', d.transporter.country)}${attr('codOrgTransport', orgTaxId)}${reqAttr('denumireOrgTransport', d.transporter.name)}${reqAttr('dataTransport', d.transportDate)}/>
    ${buildPlace('locStartTraseuRutier', d.loadingPlace)}
    ${buildPlace('locFinalTraseuRutier', d.unloadingPlace)}${documents}
  </notificare>
</eTransport>`;
}

/** Official RO e-Transport confirmation message: tipConfirmare 30 = Infirmat. */
export function buildETransportInfirmationXml(
  tenantCui: string,
  uit: string,
  reason: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<eTransport xmlns="mfp:anaf:dgti:eTransport:declaratie:v2"${reqAttr('codDeclarant', tenantCui)}>
  <confirmare${reqAttr('uit', uit)}${reqAttr('tipConfirmare', '30')}${reqAttr('observatii', reason)}/>
</eTransport>`;
}
