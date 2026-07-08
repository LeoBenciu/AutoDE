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
  goods: Array<{ description: string; tariffCode?: string; weightKg?: number; valueRon?: number }>;
  transportDate?: string; // ISO date
}

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
      <codTarifar>${esc(g.tariffCode ?? '8703')}</codTarifar>
      <cantitate>1</cantitate>
      <codUnitateMasura>H87</codUnitateMasura>
      <greutateBruta>${g.weightKg ?? 1500}</greutateBruta>
      <valoareLeiFaraTva>${g.valueRon ?? 0}</valoareLeiFaraTva>
    </bunuriTransportate>`,
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<eTransport xmlns="mfp:anaf:dgti:eTransport:declaratie:v2" codDeclarant="${esc(d.tenantCui)}">
  <notificare>
    <codTipOperatiune>${esc(d.operationType)}</codTipOperatiune>
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
      <dataTransport>${esc(d.transportDate ?? new Date().toISOString().slice(0, 10))}</dataTransport>
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
