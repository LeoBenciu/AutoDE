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

// Operations that are not a transfer of ownership (lohn, stock-at-client,
// import, export, warehousing) require the generic scope 9999. The
// ownership-transfer operations (AIC, LIC, TTN) default to 101 — "comercializare"
// — which fits buying/selling vehicles for resale.
const NON_TRANSFER_OPERATION_CODES = new Set(['12', '14', '22', '24', '40', '50', '60', '70']);

export function defaultScopeCode(operationCode: string): string {
  return NON_TRANSFER_OPERATION_CODES.has(operationCode) ? '9999' : '101';
}

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const isBlank = (value: unknown): boolean =>
  value == null || String(value).trim() === '';

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
  return `<${tag}${attr('codPtf', place.borderCrossingPoint)}>${locatie}\n    </${tag}>`;
}

export function buildETransportXml(d: DeclarationData): string {
  const operationCode = OPERATION_CODES[d.operationType] ?? '';
  const goods = d.goods
    .map((g) => {
      const scope = isBlank(g.scopeCode) ? defaultScopeCode(operationCode) : g.scopeCode;
      return `
    <bunuriTransportate${reqAttr('codScopOperatiune', scope)}${attr('codTarifar', g.tariffCode)}${reqAttr('denumireMarfa', g.description)}${reqAttr('cantitate', 1)}${reqAttr('codUnitateMasura', 'H87')}${reqAttr('greutateBruta', g.weightKg)}${attr('valoareLeiFaraTva', g.valueRon)}/>`;
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

  return `<?xml version="1.0" encoding="UTF-8"?>
<eTransport xmlns="mfp:anaf:dgti:eTransport:declaratie:v2"${reqAttr('codDeclarant', d.tenantCui)}>
  <notificare${reqAttr('codTipOperatiune', operationCode)}>${goods}
    <partenerComercial${reqAttr('codTara', d.transporter.country)}${attr('cod', d.transporter.taxId)}${reqAttr('denumire', d.transporter.name)}/>
    <dateTransport${reqAttr('nrVehicul', d.vehiclePlate)}${attr('nrRemorca1', d.trailerPlate)}${reqAttr('codTaraOrgTransport', d.transporter.country)}${attr('codOrgTransport', d.transporter.taxId)}${reqAttr('denumireOrgTransport', d.transporter.name)}${reqAttr('dataTransport', d.transportDate)}/>
    ${buildPlace('locStartTraseuRutier', d.loadingPlace)}
    ${buildPlace('locFinalTraseuRutier', d.unloadingPlace)}${documents}
  </notificare>
</eTransport>`;
}
