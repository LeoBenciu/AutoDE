/**
 * Builds the RO e-Transport XML declaration.
 *
 * NOTE: the element names below follow the ANAF e-Transport spec as of the
 * last review, but ANAF revises the XSD periodically — validate against the
 * current XSD (DUKIntegrator) before production use. Endpoints and schema
 * versions are configuration, not code.
 */

export interface DeclarationData {
  tenantCui: string;
  operationType: string; // AIC = intra-community acquisition
  transporter: { name: string; taxId: string; country: string };
  vehiclePlate: string;
  trailerPlate?: string;
  loadingPlace: { country: string; county?: string; city?: string; address?: string };
  unloadingPlace: { country: string; county?: string; city?: string; address?: string };
  goods: Array<ETransportGood>;
  transportDate?: string; // ISO date
}

export interface ETransportGood {
  description: string;
  tariffCode?: string;
  weightKg?: number;
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

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function buildETransportXml(d: DeclarationData): string {
  const goods = d.goods
    .map(
      (g, i) => `
    <bunuriTransportate>
      <nrCrt>${i + 1}</nrCrt>
      <denumireMarfa>${esc(g.description)}</denumireMarfa>
      <codTarifar>${esc(g.tariffCode)}</codTarifar>
      <cantitate>1</cantitate>
      <codUnitateMasura>H87</codUnitateMasura>
      <greutateBruta>${esc(g.weightKg)}</greutateBruta>
      <valoareLeiFaraTva>${esc(g.valueRon)}</valoareLeiFaraTva>
    </bunuriTransportate>`,
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<eTransport xmlns="mfp:anaf:dgti:eTransport:declaratie:v2" codDeclarant="${esc(d.tenantCui)}">
  <notificare>
    <codTipOperatiune>${esc(OPERATION_CODES[d.operationType])}</codTipOperatiune>
    ${goods}
    <partenerComercial>
      <codTara>${esc(d.transporter.country)}</codTara>
      <cod>${esc(d.transporter.taxId)}</cod>
      <denumire>${esc(d.transporter.name)}</denumire>
    </partenerComercial>
    <dateTransport>
      <nrVehicul>${esc(d.vehiclePlate)}</nrVehicul>${d.trailerPlate ? `\n      <nrRemorca1>${esc(d.trailerPlate)}</nrRemorca1>` : ''}
      <codTaraOrgTransport>${esc(d.transporter.country)}</codTaraOrgTransport>
      <codOrgTransport>${esc(d.transporter.taxId)}</codOrgTransport>
      <denumireOrgTransport>${esc(d.transporter.name)}</denumireOrgTransport>
      <dataTransport>${esc(d.transportDate)}</dataTransport>
    </dateTransport>
    <locStartTraseuRutier>
      <codTara>${esc(d.loadingPlace.country)}</codTara>
      <denumireLocalitate>${esc(d.loadingPlace.city ?? '')}</denumireLocalitate>
      <adresa>${esc(d.loadingPlace.address ?? '')}</adresa>
    </locStartTraseuRutier>
    <locFinalTraseuRutier>
      <codTara>${esc(d.unloadingPlace.country)}</codTara>
      <codJudet>${esc(d.unloadingPlace.county ?? '')}</codJudet>
      <denumireLocalitate>${esc(d.unloadingPlace.city ?? '')}</denumireLocalitate>
      <adresa>${esc(d.unloadingPlace.address ?? '')}</adresa>
    </locFinalTraseuRutier>
  </notificare>
</eTransport>`;
}
