/**
 * SAGA C import XML builders, aligned to the official import spec:
 *
 * <Facturi><Factura> = <Antet> + <Detalii><Continut><Linie/>…</Continut></Detalii>
 * + optional <GUID_factura> (our document id — SAGA stores the association so
 * later Plati/Incasari imports can reference the invoice). No <Sumar> section:
 * SAGA derives totals from the lines. Optional empty tags are omitted.
 *
 * Routing is decided by SAGA: when FurnizorCIF equals the importing company's
 * CUI the invoice lands in Ieșiri (sales), otherwise in Intrări (purchases) —
 * so purchases are exported with the extracted supplier as Furnizor and the
 * dealership as Client, unchanged.
 *
 * <Clienti>/<Furnizori> are the partner-nomenclature sections from the same
 * spec, exported from the Party table with Guid_cod for re-identification.
 *
 * Dates use dd.mm.yyyy (the convention of the widely-imported SmartBill/Oblio
 * SAGA exports) — confirm against the client's SAGA build on the first import.
 */

export interface SagaInvoice {
  documentId?: number;
  supplierName: string;
  supplierTaxId?: string;
  supplierCountry?: string;
  supplierIban?: string;
  clientName: string;
  clientTaxId?: string;
  clientCountry?: string;
  invoiceNumber: string;
  invoiceDate?: string; // ISO
  dueDate?: string; // ISO
  currency: string;
  netAmount?: number;
  vatAmount?: number;
  totalAmount?: number;
  lines: Array<{
    description: string;
    quantity?: number;
    unitPrice?: number;
    netAmount?: number;
    vatRate?: number;
  }>;
}

export interface SagaPartner {
  id: number;
  name: string;
  taxId?: string;
  country?: string;
  city?: string;
  address?: string;
  iban?: string;
  phone?: string;
  email?: string;
}

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const num = (n: unknown): string => (n == null || Number.isNaN(Number(n)) ? '0.00' : Number(n).toFixed(2));

/** Emit `<Tag>value</Tag>` or nothing when the value is absent (optional tags). */
const tag = (name: string, value: unknown): string =>
  value == null || value === '' ? '' : `      <${name}>${esc(value)}</${name}>\n`;

/** ISO YYYY-MM-DD → dd.mm.yyyy; empty when absent/unparseable. */
export function sagaDate(iso?: string): string {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/** VAT % from explicit rate or derived from net/vat, rounded to a whole percent. */
export function vatRate(inv: SagaInvoice, line?: SagaInvoice['lines'][number]): number {
  if (line?.vatRate != null) return Math.round(line.vatRate);
  if (inv.netAmount && inv.vatAmount != null && inv.netAmount !== 0) {
    return Math.round((inv.vatAmount / inv.netAmount) * 100);
  }
  return 0;
}

export function buildSagaXml(invoices: SagaInvoice[]): string {
  const facturi = invoices.map(buildFactura).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Facturi>\n${facturi}\n</Facturi>\n`;
}

function buildFactura(inv: SagaInvoice): string {
  // Intra-community purchases (non-RO supplier, RO VAT-registered buyer) are
  // reverse-charge; domestic invoices are not. Spec spells the flags Da/Nu.
  const reverseCharge = inv.supplierCountry && inv.supplierCountry.toUpperCase() !== 'RO' ? 'Da' : 'Nu';

  const lines =
    inv.lines.length > 0
      ? inv.lines
      : [{ description: 'Conform facturii', quantity: 1, unitPrice: inv.netAmount, netAmount: inv.netAmount }];

  const linii = lines
    .map((line, i) => {
      const lineRate = vatRate(inv, line);
      const valoare = line.netAmount ?? (line.quantity ?? 1) * (line.unitPrice ?? 0);
      const tva = (valoare * lineRate) / 100;
      return `        <Linie>
          <LinieNrCrt>${i + 1}</LinieNrCrt>
          <Descriere>${esc(line.description)}</Descriere>
          <UM>BUC</UM>
          <Cantitate>${num(line.quantity ?? 1)}</Cantitate>
          <Pret>${num(line.unitPrice ?? valoare)}</Pret>
          <Valoare>${num(valoare)}</Valoare>
          <ProcTVA>${lineRate}</ProcTVA>
          <TVA>${num(tva)}</TVA>
        </Linie>`;
    })
    .join('\n');

  const antet =
    tag('FurnizorNume', inv.supplierName) +
    tag('FurnizorCIF', inv.supplierTaxId) +
    tag('FurnizorTara', inv.supplierCountry?.toUpperCase()) +
    tag('FurnizorIBAN', inv.supplierIban) +
    tag('ClientNume', inv.clientName) +
    tag('ClientCIF', inv.clientTaxId) +
    tag('ClientTara', (inv.clientCountry ?? 'RO').toUpperCase()) +
    tag('FacturaNumar', inv.invoiceNumber) +
    tag('FacturaData', sagaDate(inv.invoiceDate)) +
    tag('FacturaScadenta', sagaDate(inv.dueDate)) +
    tag('FacturaTaxareInversa', reverseCharge) +
    tag('FacturaTVAIncasare', 'Nu') +
    tag('FacturaMoneda', inv.currency);

  const guid = inv.documentId != null ? `    <GUID_factura>AIDOC-${inv.documentId}</GUID_factura>\n` : '';

  return `  <Factura>
    <Antet>
${antet.replace(/\n$/, '')}
    </Antet>
    <Detalii>
      <Continut>
${linii}
      </Continut>
    </Detalii>
${guid}  </Factura>`;
}

/**
 * Partner nomenclature export: <Clienti> or <Furnizori> per the import spec.
 * Guid_cod carries our party id so re-imports update instead of duplicating.
 */
export function buildSagaPartnersXml(kind: 'Clienti' | 'Furnizori', partners: SagaPartner[]): string {
  const rows = partners
    .map((p) => {
      const body =
        tag('Denumire', p.name) +
        tag('Cod_fiscal', p.taxId) +
        tag('Tara', (p.country ?? 'RO').toUpperCase()) +
        tag('Localitate', p.city) +
        tag('Adresa', p.address) +
        tag('Cont_banca', p.iban) +
        tag('Tel', p.phone) +
        tag('Email', p.email) +
        tag('Guid_cod', `AIP-${p.id}`);
      return `  <Linie>\n${body.replace(/^ {6}/gm, '    ').replace(/\n$/, '')}\n  </Linie>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${kind}>\n${rows}\n</${kind}>\n`;
}

const CSV_HEADER = [
  'nr_factura',
  'data_factura',
  'scadenta',
  'furnizor',
  'cif_furnizor',
  'tara_furnizor',
  'client',
  'cif_client',
  'moneda',
  'valoare_neta',
  'tva',
  'total',
  'taxare_inversa',
].join(';');

/** Semicolon-separated CSV (Excel RO locale) with the same field mapping. */
export function buildSagaCsv(invoices: SagaInvoice[]): string {
  const cell = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const rows = invoices.map((inv) =>
    [
      cell(inv.invoiceNumber),
      cell(sagaDate(inv.invoiceDate)),
      cell(sagaDate(inv.dueDate)),
      cell(inv.supplierName),
      cell(inv.supplierTaxId),
      cell(inv.supplierCountry),
      cell(inv.clientName),
      cell(inv.clientTaxId),
      cell(inv.currency),
      num(inv.netAmount),
      num(inv.vatAmount),
      num(inv.totalAmount ?? (inv.netAmount ?? 0) + (inv.vatAmount ?? 0)),
      inv.supplierCountry && inv.supplierCountry.toUpperCase() !== 'RO' ? 'Da' : 'Nu',
    ].join(';'),
  );
  // BOM so Excel opens diacritics correctly
  return '﻿' + CSV_HEADER + '\n' + rows.join('\n') + '\n';
}
