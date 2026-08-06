import {
  CanonicalAccountingDocument,
  CanonicalLineItem,
  normalizeEin,
  normalizeVatRate,
  round2,
} from '../accounting/accounting-normalizer';

export interface SagaCompany {
  cui?: string | null;
  name?: string | null;
  registrationNumber?: string | null;
  address?: string | null;
  country?: string | null;
  county?: string | null;
  city?: string | null;
  iban?: string | null;
  bankName?: string | null;
  email?: string | null;
  phone?: string | null;
  isVatPayer: boolean;
  hasTvaLaIncasare: boolean;
}

export interface SagaInvoiceRecord {
  id: number;
  type: string | null;
  data: CanonicalAccountingDocument;
}

export interface SagaMovement {
  date: string;
  reference: string;
  amount: number;
  accountCode: string;
  counterAccount: string;
  description: string;
  currency: string;
  sourceType: string;
  documentId?: number;
  invoiceNumber?: string;
}

export interface SagaPartnerRecord {
  name: string;
  taxId?: string | null;
  country?: string | null;
  county?: string | null;
  city?: string | null;
  address?: string | null;
  iban?: string | null;
  bankName?: string | null;
  phone?: string | null;
  email?: string | null;
  registration?: string | null;
  discount?: string | null;
  code?: string | null;
  analytic?: string | null;
}

export interface SagaArticleRecord {
  code: string;
  name: string;
  analyticCode?: string | null;
  vatRate: string;
  unit: string;
  type: string;
}

const VAT_RATE_MAP: Record<string, string> = {
  ZERO: '0',
  ONE: '1',
  FIVE: '5',
  NINE: '9',
  ELEVEN: '11',
  NINETEEN: '19',
  TWENTYONE: '21',
  TWENTY_FOUR: '24',
};

const UNIT_MAP: Record<string, string> = {
  BUCATA: 'BUC',
  KILOGRAM: 'KG',
  LITRU: 'LITRI',
  METRU: 'M',
  GRAM: 'GRAME',
  CUTIE: 'CUTII',
  PACHET: 'PAC',
  PUNGA: 'PUNGI',
  SET: 'SET',
  METRU_PATRAT: 'MP',
  METRU_CUB: 'MC',
  MILIMETRU: 'MM',
  CENTIMETRU: 'CM',
  TONA: 'TONE',
  PERECHE: 'PER',
  SAC: 'SACI',
  MILILITRU: 'ML',
  KILOWATT_ORA: 'KWH',
  MINUT: 'MIN',
  ORA: 'ORE',
  ZI_DE_LUCRU: 'ZILE',
  LUNI_DE_LUCRU: 'LUNI',
  DOZA: 'DOZE',
  UNITATE_DE_SERVICE: 'SERV',
  O_MIE_DE_BUCATI: '1000B',
  TRIMESTRU: 'TRIM',
  PROCENT: 'PROC',
  KILOMETRU: 'KM',
  LADA: 'LADA',
  DRY_TONE: 'DT',
  CENTIMETRU_PATRAT: 'CMP',
  MEGAWATI_ORA: 'MWH',
  ROLA: 'ROLA',
  TAMBUR: 'TAMB',
  SAC_PLASTIC: 'SAC',
  PALET_LEMN: 'PALET',
  UNITATE: 'UNIT',
  TONA_NETA: 'TN',
  HECTOMETRU_PATRAT: 'HA',
  FOAIE: 'FOAIE',
};

const ARTICLE_TYPE_MAP: Record<string, string> = {
  MARFURI: '01',
  MATERII_PRIME: '02',
  MATERIALE_AUXILIARE: '03',
  PRODUSE_FINITE: '04',
  AMBALAJE: '05',
  OBIECTE_DE_INVENTAR: '06',
  PRODUSE_REZIDUALE: '07',
  SEMIFABRICATE: '08',
  AMENAJARI_PROVIZORII: '09',
  MATERIALE_SPRE_PRELUCRARE: '10',
  MAT_SPRE_LUCRARE: '10',
  MATERIALE_IN_PASTRARE_SAU_CONSIGNATIE: '11',
  MAT_IN_PASTRARE_CONSIG: '11',
  DISCOUNT_FINANCIAR_INTRARI: '12',
  DISCOUNT_FINANCIAR_IESIRI: '13',
  COMBUSTIBILI: '14',
  PIESE_DE_SCHIMB: '15',
  ALTE_MATERIALE_CONSUMABILE: '16',
  ALTE_MAT_CONSUMABILE: '16',
  SERVICII_VANDUTE: '17',
  DISCOUNT_COMERCIAL_INTRARI: '18',
  DISCOUNT_COMERCIAL_IESIRI: '19',
  AMBALAJE_SGR: 'GR',
  TAXA_VERDE: 'TV',
};

/**
 * Canonical SAGA county (județ) mnemonics, keyed by the county name after
 * diacritics are stripped, lower-cased and reduced to letters only. Values are
 * the official auto-registration codes SAGA expects on import (Bacău → BC,
 * București → B, Cluj → CJ, …).
 */
const JUDET_MNEMONIC_BY_NAME: Record<string, string> = {
  alba: 'AB',
  arad: 'AR',
  arges: 'AG',
  bacau: 'BC',
  bihor: 'BH',
  bistritanasaud: 'BN',
  botosani: 'BT',
  brasov: 'BV',
  braila: 'BR',
  buzau: 'BZ',
  carasseverin: 'CS',
  calarasi: 'CL',
  cluj: 'CJ',
  constanta: 'CT',
  covasna: 'CV',
  dambovita: 'DB',
  dimbovita: 'DB', // pre-1993 spelling
  dolj: 'DJ',
  galati: 'GL',
  giurgiu: 'GR',
  gorj: 'GJ',
  harghita: 'HR',
  hunedoara: 'HD',
  ialomita: 'IL',
  iasi: 'IS',
  ilfov: 'IF',
  maramures: 'MM',
  mehedinti: 'MH',
  mures: 'MS',
  neamt: 'NT',
  olt: 'OT',
  prahova: 'PH',
  satumare: 'SM',
  salaj: 'SJ',
  sibiu: 'SB',
  suceava: 'SV',
  teleorman: 'TR',
  timis: 'TM',
  tulcea: 'TL',
  vaslui: 'VS',
  valcea: 'VL',
  vilcea: 'VL', // pre-1993 spelling
  vrancea: 'VN',
  bucuresti: 'B',
};

/** Valid mnemonics, for pass-through of values that are already codes. */
const JUDET_MNEMONICS = new Set(Object.values(JUDET_MNEMONIC_BY_NAME));

/**
 * Normalize a Romanian county to the 1–2 letter mnemonic SAGA expects in the
 * FurnizorJudet / ClientJudet / Judet fields. Extraction and nomenclature data
 * often carry the full name ("București", "Cluj") or a diacritics-free variant
 * ("Bucuresti"), but SAGA's import rejects anything that is not the official
 * code. Tolerates diacritics, casing, "Județul/Jud./Municipiul" prefixes and
 * any București sector spelling. A value already a valid code passes through;
 * an unrecognized value is returned trimmed as-is (better than blanking it).
 */
function sagaJudet(value: unknown): string {
  if (!value) return '';
  const raw = String(value).trim();
  if (!raw) return '';

  // Already a valid mnemonic (any casing / stray spaces)?
  const asCode = raw.toUpperCase().replace(/\s+/g, '');
  if (JUDET_MNEMONICS.has(asCode)) return asCode;

  // Reduce to a comparable key: strip diacritics, lower-case, letters only.
  let key = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');

  // Drop common administrative prefixes ("judetul", "jud", "municipiul", "mun").
  key = key.replace(/^(judetul|judet|jud|municipiul|mun)/, '');

  // Any București variant (sectors, "Municipiul București", etc.) → "B".
  if (key.includes('bucuresti')) return 'B';

  return JUDET_MNEMONIC_BY_NAME[key] || raw;
}

export function buildFacturiXml(
  invoices: SagaInvoiceRecord[],
  company: SagaCompany,
  articles: SagaArticleRecord[],
): string {
  const body = invoices
    .map((invoice) => buildFactura(invoice, company, articles))
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Facturi>\n${body}\n</Facturi>`;
}

export function buildIncasariXml(movements: SagaMovement[]): string {
  return buildMovementsXml('Incasari', 'ContClient', movements);
}

export function buildPlatiXml(movements: SagaMovement[]): string {
  return buildMovementsXml('Plati', 'ContFurnizor', movements);
}

export function buildPartnersXml(
  kind: 'Furnizori' | 'Clienti',
  partners: SagaPartnerRecord[],
): string {
  const rows = partners
    .map((partner) => {
      const common = [
        xmlTag('Cod', partner.analytic, 4),
        xmlTag('Denumire', partner.name, 4),
        xmlTag('Cod_fiscal', partner.taxId, 4),
        ...(kind === 'Clienti'
          ? [xmlTag('Reg_com', partner.registration, 4)]
          : []),
        xmlTag('Tara', partner.country || 'RO', 4),
        ...(kind === 'Clienti'
          ? [xmlTag('Judet', sagaJudet(partner.county), 4)]
          : []),
        xmlTag('Localitate', partner.city, 4),
        xmlTag('Adresa', partner.address, 4),
        xmlTag('Cont_banca', partner.iban, 4),
        xmlTag('Banca', partner.bankName, 4),
        xmlTag('Tel', partner.phone, 4),
        xmlTag('Email', partner.email, 4),
        ...(kind === 'Clienti' ? [xmlTag('Discount', partner.discount, 4)] : []),
        xmlTag('Informatii', '', 4),
        xmlTag('Guid_cod', partner.code, 4),
      ].join('');
      return `  <Linie>\n${common}  </Linie>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${kind}>\n${rows}\n</${kind}>`;
}

export function buildArticlesXml(articles: SagaArticleRecord[]): string {
  const rows = articles
    .filter((article) => article.analyticCode)
    .map((article) => {
      const vat = sagaVat(article.vatRate);
      const unit = sagaUnit(article.unit);
      const type = ARTICLE_TYPE_MAP[article.type] ?? article.type ?? '';
      return `  <Linie>
    <Cod>${esc(article.analyticCode)}</Cod>
    <Denumire>${esc(article.name)}</Denumire>
    <Cod_NC></Cod_NC>
    <Cod_CPV></Cod_CPV>
    <UM>${esc(unit)}</UM>
    <Tip>${esc(type)}</Tip>
    <TVA>${esc(vat)}</TVA>
    <Pret></Pret>
    <Pret_TVA></Pret_TVA>
    <Cod_bare></Cod_bare>
    <Informatii></Informatii>
    <Guid_cod>${esc(article.code)}</Guid_cod>
  </Linie>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Articole>\n${rows}\n</Articole>`;
}

export function sagaDate(value?: string): string {
  if (!value) return '';
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}-${iso[2]}-${iso[1]}`;
  const dmy = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (dmy) {
    return `${String(dmy[1]).padStart(2, '0')}-${String(dmy[2]).padStart(2, '0')}-${dmy[3]}`;
  }
  return '';
}

function buildFactura(
  invoice: SagaInvoiceRecord,
  company: SagaCompany,
  articles: SagaArticleRecord[],
): string {
  const data = invoice.data;
  const isContract =
    invoice.type === 'Contract' || data.documentType === 'Contract';
  const isIndependentReceipt =
    invoice.type === 'Receipt' || data.receiptType === 'independent_receipt';
  const companyIsVendor = sameTaxId(data.vendorEin, company.cui);
  const companyIsBuyer = sameTaxId(data.buyerEin, company.cui);
  const header = [
    xmlTag('FurnizorNume', data.vendor || (companyIsVendor ? company.name : '')),
    xmlTag('FurnizorCIF', data.vendorEin),
    xmlTag(
      'FurnizorNrRegCom',
      data.vendorRegistration ||
        (companyIsVendor ? company.registrationNumber : ''),
    ),
    xmlTag('FurnizorCapital', data.raw.vendor_capital),
    xmlTag(
      'FurnizorTara',
      data.vendorCountry || (companyIsVendor ? company.country : '') || 'RO',
    ),
    xmlTag(
      'FurnizorLocalitate',
      data.vendorCity || (companyIsVendor ? company.city : ''),
    ),
    xmlTag(
      'FurnizorJudet',
      sagaJudet(data.vendorCounty || (companyIsVendor ? company.county : '')),
    ),
    xmlTag(
      'FurnizorAdresa',
      data.vendorAddress || (companyIsVendor ? company.address : ''),
    ),
    xmlTag(
      'FurnizorTelefon',
      data.vendorPhone || (companyIsVendor ? company.phone : ''),
    ),
    xmlTag(
      'FurnizorMail',
      data.vendorEmail || (companyIsVendor ? company.email : ''),
    ),
    xmlTag(
      'FurnizorBanca',
      data.vendorBankName || (companyIsVendor ? company.bankName : ''),
    ),
    xmlTag(
      'FurnizorIBAN',
      data.vendorIban || (companyIsVendor ? company.iban : ''),
    ),
    xmlTag('FurnizorInformatiiSuplimentare', data.raw.vendor_additional_info),
    xmlTag('GUID_cod_client', data.raw.guid_client_code),
    xmlTag('ClientNume', data.buyer || (companyIsBuyer ? company.name : '')),
    xmlTag('ClientInformatiiSuplimentare', data.raw.buyer_additional_info),
    xmlTag('ClientCIF', data.buyerEin),
    xmlTag(
      'ClientNrRegCom',
      data.buyerRegistration ||
        (companyIsBuyer ? company.registrationNumber : ''),
    ),
    xmlTag(
      'ClientJudet',
      sagaJudet(data.buyerCounty || (companyIsBuyer ? company.county : '')),
    ),
    xmlTag(
      'ClientTara',
      data.buyerCountry || (companyIsBuyer ? company.country : '') || 'RO',
    ),
    xmlTag(
      'ClientLocalitate',
      data.buyerCity || (companyIsBuyer ? company.city : ''),
    ),
    xmlTag(
      'ClientAdresa',
      data.buyerAddress || (companyIsBuyer ? company.address : ''),
    ),
    xmlTag(
      'ClientBanca',
      data.buyerBankName || (companyIsBuyer ? company.bankName : ''),
    ),
    xmlTag(
      'ClientIBAN',
      data.buyerIban || (companyIsBuyer ? company.iban : ''),
    ),
    xmlTag(
      'ClientTelefon',
      data.buyerPhone || (companyIsBuyer ? company.phone : ''),
    ),
    xmlTag(
      'ClientMail',
      data.buyerEmail || (companyIsBuyer ? company.email : ''),
    ),
    xmlTag('FacturaNumar', data.documentNumber),
    xmlTag('FacturaData', sagaDate(data.documentDate)),
    xmlTag('FacturaScadenta', sagaDate(data.dueDate)),
    xmlTag('FacturaTaxareInversa', data.reverseCharge ? 'Da' : 'Nu'),
    xmlTag(
      'FacturaTVAIncasare',
      hasVatOnCollection(data, company) ? 'Da' : 'Nu',
    ),
    xmlTag(
      'FacturaTip',
      isContract
        ? 'R'
        : data.reverseCharge
          ? 'T'
          : isIndependentReceipt
            ? 'C'
            : '',
    ),
    xmlTag('FacturaInformatiiSuplimentare', data.raw.additional_info),
    xmlTag('FacturaMoneda', data.currency || 'RON'),
    xmlTag('FacturaGreutate', data.raw.weight),
    xmlTag('FacturaAccize', data.raw.excise),
    xmlTag('FacturaIndexSPV', data.raw.spv_receipt_id),
    xmlTag('FacturaIndexDescarcareSPV', data.raw.spv_upload_id),
    xmlTag('Cod', data.raw.client_code || data.raw.supplier_code),
  ].join('');

  const lineXml = data.lineItems
    .map((line, index) => {
      const article = findFinovaArticle(articles, line.articleCode);
      const analytic = line.articleCode
        ? article?.analyticCode ??
          line.raw.selectedArticleAnalitic ??
          line.raw.analitic ??
          ''
        : '';
      const value = company.isVatPayer
        ? line.netAmount
        : round2(line.netAmount + line.vatAmount);
      const unitPrice =
        company.isVatPayer
          ? firstTruthy(
              line.raw.unit_price,
              line.raw.pret,
              line.unitPrice,
              '0',
            )
          : line.quantity
            ? (value / line.quantity).toFixed(4)
            : (line.unitPrice + line.vatAmount).toFixed(4);
      const quantity = firstTruthy(line.raw.quantity, line.quantity, '1');
      const lineValue = company.isVatPayer
        ? firstTruthy(
            line.raw.line_total,
            line.raw.total,
            line.raw.valoare,
            line.netAmount,
            '0',
          )
        : value.toFixed(2);
      const vatValue = company.isVatPayer
        ? firstTruthy(line.raw.vat_amount, line.raw.tva, line.vatAmount, '0')
        : '';
      const deductibility =
        line.vatDeductibility === 'PARTIAL_50'
          ? 'N50'
          : line.vatDeductibility === 'NONE'
            ? 'I'
            : '';
      const vatRate = data.reverseCharge
        ? reverseChargeVatRate(data, line)
        : sagaInvoiceVat(
            line.raw.vat_rate ??
              line.raw.vat ??
              line.raw.proc_tva ??
              line.vatCode,
          );
      return `        <Linie>
          <LinieNrCrt>${index + 1}</LinieNrCrt>
          <Gestiune>${esc(line.management)}</Gestiune>
          <Activitate>${esc(line.raw.activity ?? line.raw.activitate)}</Activitate>
          <Descriere>${esc(vehicleLineDescription(line, data) ?? line.name)}</Descriere>
          <CodArticolFurnizor>${esc(analytic)}</CodArticolFurnizor>
          <CodArticolClient>${esc(analytic)}</CodArticolClient>
          <GUID_cod_articol>${esc(line.raw.guid_article_code ?? line.raw.guid_cod_articol)}</GUID_cod_articol>
          <CodBare>${esc(line.raw.barcode ?? line.raw.cod_bare)}</CodBare>
          <InformatiiSuplimentare>${esc(line.raw.additional_info ?? line.raw.informatii_suplimentare)}</InformatiiSuplimentare>
          <UM>${esc(sagaUnit(line.unit))}</UM>
          <Cantitate>${esc(quantity)}</Cantitate>
          <Pret>${esc(unitPrice)}</Pret>
          <Valoare>${esc(lineValue)}</Valoare>
          <ProcTVA>${company.isVatPayer ? esc(vatRate) : ''}</ProcTVA>
          <TVA>${esc(vatValue)}</TVA>
          <Cont>${esc(line.accountCode)}</Cont>
          <TipDeducere>${deductibility}</TipDeducere>
          <PretVanzare></PretVanzare>
        </Linie>`;
    })
    .join('\n');
  return `  <Factura>
    <Antet>
${header}    </Antet>
    <Detalii>
      <Continut>
${lineXml}
      </Continut>
    </Detalii>
    <FacturaID>${invoice.id}</FacturaID>
  </Factura>`;
}

function buildMovementsXml(
  root: 'Incasari' | 'Plati',
  counterTag: 'ContClient' | 'ContFurnizor',
  movements: SagaMovement[],
): string {
  const rows = movements
    .map((movement) => {
      const noInvoiceLink = [
        'PAYMENT_DISPOSITION',
        'COLLECTION_DISPOSITION',
      ].includes(movement.sourceType);
      return `  <Linie>
    <Data>${sagaDate(movement.date)}</Data>
    <Numar>${esc(movement.reference)}</Numar>
    <Suma>${esc(String(Math.abs(movement.amount || 0)))}</Suma>
    <Cont>${esc(movement.accountCode)}</Cont>
    <${counterTag}>${esc(movement.counterAccount)}</${counterTag}>
    <Explicatie>${esc(movement.description)}</Explicatie>
    <FacturaID>${noInvoiceLink ? '' : esc(movement.documentId)}</FacturaID>
    <FacturaNumar>${noInvoiceLink ? '' : esc(movement.invoiceNumber)}</FacturaNumar>
    <CodFiscal></CodFiscal>
    <Moneda>${esc(movement.currency || 'RON')}</Moneda>
  </Linie>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${root}>\n${rows}\n</${root}>`;
}

function sagaVat(value: unknown): string {
  const text = String(value ?? '').trim().toUpperCase();
  if (VAT_RATE_MAP[text] != null) return VAT_RATE_MAP[text];
  const numeric = normalizeVatRate(text);
  return Number.isFinite(numeric) ? String(numeric) : '';
}

function sagaInvoiceVat(value: unknown): string {
  const text = finovaScalar(value).trim().toUpperCase();
  if (VAT_RATE_MAP[text] != null) return VAT_RATE_MAP[text];
  return /^\d+$/.test(text) ? text : '19';
}

function reverseChargeVatRate(
  data: CanonicalAccountingDocument,
  line: CanonicalLineItem,
): string {
  const explicit = normalizeVatRate(
    line.raw.reverse_charge_vat_rate ??
      data.raw.reverse_charge_vat_rate ??
      data.raw.applicable_vat_rate,
  );
  if (explicit > 0) return String(explicit);
  return data.documentDate && data.documentDate < '2025-08-01' ? '19' : '21';
}

function hasVatOnCollection(
  data: CanonicalAccountingDocument,
  company: SagaCompany,
): boolean {
  if (!company.isVatPayer || data.vatAmount <= 0 || data.reverseCharge) {
    return false;
  }
  if (data.direction === 'outgoing') return company.hasTvaLaIncasare;
  return data.direction === 'incoming' && data.vendorCountry === 'RO'
    ? data.vatOnCollection
    : false;
}

function sameTaxId(left?: string | null, right?: string | null): boolean {
  const normalizedLeft = normalizeEin(left);
  const normalizedRight = normalizeEin(right);
  return Boolean(normalizedLeft && normalizedLeft === normalizedRight);
}

function sagaUnit(value: unknown): string {
  const text = finovaScalar(value).trim().toUpperCase();
  return UNIT_MAP[text] ?? text;
}

function xmlTag(name: string, value: unknown, spaces = 6): string {
  return `${' '.repeat(spaces)}<${name}>${esc(value)}</${name}>\n`;
}

function esc(value: unknown): string {
  return finovaScalar(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function finovaScalar(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return String(object.name ?? object.code ?? object.id ?? '');
  }
  return String(value);
}

function firstTruthy(...values: unknown[]): unknown {
  return values.find(Boolean) ?? '';
}

/**
 * Vehicle stock lines export with a "<VIN> <model>" description so the car is
 * identifiable in SAGA by chassis number rather than a generic "Autoturism …"
 * label. Such lines carry the canonical AUTO-<VIN> article code (see
 * vehicleArticleCode); the model is taken from the line's raw vehicle fields,
 * falling back to the document-level vehicle data. Returns null for any line
 * that is not a vehicle, so the caller keeps the normal name.
 */
function vehicleLineDescription(
  line: CanonicalLineItem,
  data: CanonicalAccountingDocument,
): string | null {
  const match = /^AUTO-(.+)$/i.exec(line.articleCode ?? '');
  if (!match) return null;
  const vin = match[1].trim().toUpperCase();
  if (!vin) return null;
  const model = finovaScalar(
    firstTruthy(
      line.raw.vehicle_model,
      line.raw.model,
      data.raw.vehicle_model,
      data.raw.model,
    ),
  ).trim();
  return [vin, model].filter(Boolean).join(' ');
}

function findFinovaArticle(
  articles: SagaArticleRecord[],
  articleCode: string,
): SagaArticleRecord | undefined {
  if (!articleCode) return undefined;
  return articles.find(
    (article) =>
      article.code === articleCode ||
      String(article.code) === String(articleCode) ||
      article.code === String(articleCode).toUpperCase(),
  );
}
