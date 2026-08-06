import {
  normalizeIdentifierType,
  normalizePartyCountry,
  PartyIdentifierTypeValue,
} from '../parties/party-identity';
import { vehicleArticleCode } from './vehicle-article';

export type AccountingDirection = 'incoming' | 'outgoing';
export type VatDeductibility = 'FULL' | 'PARTIAL_50' | 'NONE';

export interface CanonicalLineItem {
  name: string;
  quantity: number;
  unitPrice: number;
  netAmount: number;
  vatAmount: number;
  vatRate: number;
  vatCode: string;
  unit: string;
  accountCode: string;
  articleCode: string;
  management?: string;
  articleType: string;
  vatDeductibility: VatDeductibility;
  raw: Record<string, any>;
}

export interface CanonicalAccountingDocument {
  documentType: string;
  direction?: AccountingDirection;
  vendor: string;
  vendorEin: string;
  vendorCountry: string;
  vendorKind: 'INDIVIDUAL' | 'COMPANY';
  vendorIdentifierType: PartyIdentifierTypeValue;
  vendorRegistration?: string;
  vendorAddress?: string;
  vendorCity?: string;
  vendorCounty?: string;
  vendorPhone?: string;
  vendorEmail?: string;
  vendorBankName?: string;
  vendorIban?: string;
  buyer: string;
  buyerEin: string;
  buyerCountry: string;
  buyerKind: 'INDIVIDUAL' | 'COMPANY';
  buyerIdentifierType: PartyIdentifierTypeValue;
  buyerRegistration?: string;
  buyerAddress?: string;
  buyerCity?: string;
  buyerCounty?: string;
  buyerPhone?: string;
  buyerEmail?: string;
  buyerBankName?: string;
  buyerIban?: string;
  documentNumber: string;
  documentDate?: string;
  dueDate?: string;
  totalAmount: number;
  vatAmount: number;
  netAmount: number;
  currency: string;
  exchangeRate?: number;
  reverseCharge: boolean;
  vatOnCollection: boolean;
  isAdvance: boolean;
  aviz: boolean;
  receiptType?: 'payment_receipt' | 'independent_receipt';
  paymentMethod?: 'cash' | 'bank';
  referencedNumbers: string[];
  referencedInvoices: Array<{ number: string; amount?: number }>;
  accountCode?: string;
  lineItems: CanonicalLineItem[];
  raw: Record<string, any>;
}

const VAT_RATE_MAP: Record<string, number> = {
  ZERO: 0,
  ONE: 1,
  FIVE: 5,
  NINE: 9,
  ELEVEN: 11,
  NINETEEN: 19,
  TWENTYONE: 21,
  TWENTY_FOUR: 24,
};

const TYPE_ALIASES: Record<string, string> = {
  invoice: 'Invoice',
  receipt: 'Receipt',
  contract: 'Contract',
  'payment disposition': 'Payment Disposition',
  paymentdisposition: 'Payment Disposition',
  'collection disposition': 'Collection Disposition',
  collectiondisposition: 'Collection Disposition',
};

export function unwrapExtractedFields(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const object = value as Record<string, any>;
  if (object.result && typeof object.result === 'object' && !Array.isArray(object.result)) {
    return object.result as Record<string, any>;
  }
  return object;
}

export function normalizeAccountingDocument(
  documentType: string | null | undefined,
  extractedFields: unknown,
  tenantCui?: string | null,
): CanonicalAccountingDocument {
  const raw = unwrapExtractedFields(extractedFields);
  const normalizedType =
    TYPE_ALIASES[String(raw.document_type ?? documentType ?? '').trim().toLowerCase()] ??
    String(raw.document_type ?? documentType ?? 'Other').trim();

  const contractParties = Array.isArray(raw.parties)
    ? raw.parties.filter(
        (party: unknown): party is Record<string, any> =>
          Boolean(party && typeof party === 'object' && !Array.isArray(party)),
      )
    : [];
  const contractVendor = contractParties.find((party) =>
    ['vendor', 'seller', 'vanzator', 'vânzător'].includes(
      stringValue(party.role).toLowerCase(),
    ),
  );
  const contractBuyer = contractParties.find((party) =>
    ['client', 'buyer', 'cumparator', 'cumpărător'].includes(
      stringValue(party.role).toLowerCase(),
    ),
  );
  const vendorEin = normalizeEin(
    raw.vendor_ein ??
      raw.supplier_tax_id ??
      contractVendor?.ein ??
      contractVendor?.tax_id,
  );
  const buyerEin = normalizeEin(
    raw.buyer_ein ??
      raw.customer_tax_id ??
      contractBuyer?.ein ??
      contractBuyer?.tax_id,
  );
  const companyEin = normalizeEin(tenantCui);
  let direction = normalizeDirection(raw.direction);
  if (companyEin && buyerEin === companyEin) direction = 'incoming';
  if (companyEin && vendorEin === companyEin) direction = 'outgoing';
  const vendorCountry = normalizeCountry(
    raw.vendor_country ?? raw.supplier_country ?? contractVendor?.country,
  );
  const vendorKind = normalizePartyKind(
    raw.vendor_kind ?? raw.supplier_kind ?? contractVendor?.kind,
  );
  const buyerCountry = normalizeCountry(
    raw.buyer_country ?? raw.customer_country ?? contractBuyer?.country,
  );
  const buyerKind = normalizePartyKind(
    raw.buyer_kind ?? raw.customer_kind ?? contractBuyer?.kind,
  );

  const totalAmount = positiveNumber(
    raw.total_amount ??
      raw.total_value ??
      raw.grand_total ??
      raw.total ??
      raw.amount,
  );
  const vatAmount = Math.min(
    totalAmount,
    positiveNumber(raw.vat_amount ?? raw.total_vat ?? raw.tva),
  );
  const explicitNet = positiveNumber(raw.net_amount ?? raw.net_total ?? raw.subtotal);
  const netAmount = explicitNet || Math.max(0, round2(totalAmount - vatAmount));
  const purchaseContract =
    normalizedType === 'Contract' &&
    isRawVehiclePurchaseContract(raw, direction);
  const extractedLines = Array.isArray(raw.line_items) ? raw.line_items : [];
  const lines =
    extractedLines.length > 0 || !purchaseContract || totalAmount <= 0
      ? extractedLines
      : [
          {
            name: vehicleDescription(raw),
            quantity: 1,
            unit_price: totalAmount,
            total: totalAmount,
            vat_amount: 0,
            vat: 'ZERO',
            um: 'BUCATA',
            account_code: '371',
            articleCode: vehicleArticleCode(raw.vin),
            article_type: 'MARFURI',
            vat_deductibility: 'NONE',
          },
        ];
  const hasStructuredReferences = Array.isArray(raw.referenced_invoices);
  const extractedReferences = hasStructuredReferences
    ? raw.referenced_invoices
        .map((reference: unknown) => {
          if (typeof reference === 'string') {
            return { number: reference.trim() };
          }
          if (
            reference &&
            typeof reference === 'object' &&
            !Array.isArray(reference)
          ) {
            const object = reference as Record<string, unknown>;
            const number = stringValue(
              object.number ??
                object.document_number ??
                object.invoice_number ??
                object.reference,
            );
            const amount = optionalPositiveNumber(
              object.amount ?? object.payment_amount ?? object.paid_amount,
            );
            return number ? { number, amount } : undefined;
          }
          return undefined;
        })
        .filter(
          (
            reference,
          ): reference is { number: string; amount?: number } =>
            Boolean(reference?.number),
        )
    : [];
  const referencedNumbers = uniqueStrings([
    ...extractedReferences.map((reference) => reference.number),
    ...(!hasStructuredReferences && Array.isArray(raw.referenced_numbers)
      ? raw.referenced_numbers
      : []),
    ...(!hasStructuredReferences
      ? [raw.invoice_reference, raw.reference_number]
      : []),
  ]);
  const referencedInvoices = referencedNumbers.map((number) => ({
    number,
    amount: extractedReferences.find(
      (reference) =>
        normalizeReferenceValue(reference.number) === normalizeReferenceValue(number),
    )?.amount,
  }));
  const receiptType = normalizeReceiptType(raw.receipt_type, referencedNumbers.length > 0);
  const paymentMethod = normalizePaymentMethod(raw.payment_method ?? raw.payment_info);
  const lineItems = lines.map((line, index) => normalizeLineItem(line, index));
  enforceVehicleArticleIdentity(normalizedType, direction, raw, lineItems);
  removeVehicleCostArticleIdentity(normalizedType, raw, lineItems);

  return {
    documentType: normalizedType,
    direction,
    vendor: stringValue(
      raw.vendor ??
        raw.supplier_name ??
        raw.merchant_name ??
        contractVendor?.name,
    ),
    vendorEin,
    vendorCountry,
    vendorKind,
    vendorIdentifierType: normalizeIdentifierType(
      undefined,
      vendorKind,
      vendorCountry,
    ),
    vendorRegistration: optionalString(
      raw.vendor_registration ??
        raw.vendor_reg_com ??
        raw.supplier_registration ??
        contractVendor?.registration,
    ),
    vendorAddress: optionalString(
      raw.vendor_address ?? raw.supplier_address ?? contractVendor?.address,
    ),
    vendorCity: optionalString(
      raw.vendor_city ?? raw.supplier_city ?? contractVendor?.city,
    ),
    vendorCounty: optionalString(
      raw.vendor_county ?? raw.supplier_county ?? contractVendor?.county,
    ),
    vendorPhone: optionalString(
      raw.vendor_phone ?? raw.supplier_phone ?? contractVendor?.phone,
    ),
    vendorEmail: optionalString(
      raw.vendor_email ?? raw.supplier_email ?? contractVendor?.email,
    ),
    vendorBankName: optionalString(
      raw.vendor_bank ?? raw.supplier_bank ?? contractVendor?.bank_name,
    ),
    vendorIban: optionalString(raw.vendor_iban ?? raw.supplier_iban),
    buyer: stringValue(raw.buyer ?? raw.customer_name ?? contractBuyer?.name),
    buyerEin,
    buyerCountry,
    buyerKind,
    buyerIdentifierType: normalizeIdentifierType(
      undefined,
      buyerKind,
      buyerCountry,
    ),
    buyerRegistration: optionalString(
      raw.buyer_registration ??
        raw.buyer_reg_com ??
        raw.customer_registration ??
        contractBuyer?.registration,
    ),
    buyerAddress: optionalString(
      raw.buyer_address ?? raw.customer_address ?? contractBuyer?.address,
    ),
    buyerCity: optionalString(
      raw.buyer_city ?? raw.customer_city ?? contractBuyer?.city,
    ),
    buyerCounty: optionalString(
      raw.buyer_county ?? raw.customer_county ?? contractBuyer?.county,
    ),
    buyerPhone: optionalString(
      raw.buyer_phone ?? raw.customer_phone ?? contractBuyer?.phone,
    ),
    buyerEmail: optionalString(
      raw.buyer_email ?? raw.customer_email ?? contractBuyer?.email,
    ),
    buyerBankName: optionalString(
      raw.buyer_bank ?? raw.customer_bank ?? contractBuyer?.bank_name,
    ),
    buyerIban: optionalString(
      raw.buyer_iban ?? raw.customer_iban ?? contractBuyer?.iban,
    ),
    documentNumber: stringValue(
      raw.document_number ??
        raw.invoice_number ??
        raw.receipt_number ??
        raw.contract_number,
    ),
    documentDate: normalizeDate(
      raw.document_date ??
        raw.invoice_date ??
        raw.issue_date ??
        raw.contract_date ??
        raw.date,
    ),
    dueDate: normalizeDate(raw.due_date),
    totalAmount,
    vatAmount,
    netAmount,
    currency: normalizeCurrency(raw.currency),
    exchangeRate: optionalExchangeRate(
      raw.exchangeRate ?? raw.exchange_rate ?? raw.curs_valutar ?? raw.curs,
    ),
    reverseCharge:
      raw.reverse_charge === true ||
      String(raw.reverse_charge ?? '').toLowerCase() === 'true',
    vatOnCollection: booleanValue(
      raw.vat_on_collection ??
        raw.tva_la_incasare ??
        raw.cash_accounting,
    ),
    isAdvance:
      raw.is_advance === true ||
      raw.advance === true ||
      ['advance', 'avans'].includes(
        stringValue(raw.invoice_kind ?? raw.payment_kind).toLowerCase(),
      ),
    aviz: raw.aviz === true,
    receiptType,
    paymentMethod,
    referencedNumbers,
    referencedInvoices,
    accountCode: optionalString(raw.account_code ?? raw.accountCode),
    lineItems,
    raw,
  };
}

export function isVehiclePurchaseContract(
  canonical: CanonicalAccountingDocument,
): boolean {
  return (
    canonical.documentType === 'Contract' &&
    isRawVehiclePurchaseContract(canonical.raw, canonical.direction)
  );
}

export function normalizeDate(value: unknown): string | undefined {
  const text = optionalString(value);
  if (!text) return undefined;
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    return validDate(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  match = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (match) {
    return validDate(Number(match[3]), Number(match[2]), Number(match[1]));
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().slice(0, 10);
}

export function normalizeEin(value: unknown): string {
  return stringValue(value)
    .toUpperCase()
    .replace(/^RO/, '')
    .replace(/[^A-Z0-9]/g, '');
}

export function normalizeVatRate(value: unknown): number {
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    value = object.name ?? object.value;
  }
  const text = stringValue(value).toUpperCase();
  if (VAT_RATE_MAP[text] != null) return VAT_RATE_MAP[text];
  const numeric = Number(text.replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

export function vatCodeFromRate(rate: number): string {
  const found = Object.entries(VAT_RATE_MAP).find(([, numeric]) => numeric === rate);
  return found?.[0] ?? String(rate);
}

export function round2(value: number): number {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function normalizeLineItem(value: unknown, index: number): CanonicalLineItem {
  const line =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, any>)
      : {};
  const quantity = positiveNumber(line.quantity) || 1;
  const unitPrice = positiveNumber(line.unit_price ?? line.unitPrice ?? line.pret);
  const vatAmount = positiveNumber(line.vat_amount ?? line.tva);
  const explicitNet = positiveNumber(
    line.net_amount ?? line.line_total ?? line.total ?? line.valoare,
  );
  const netAmount = explicitNet || round2(quantity * unitPrice);
  const vatRate = normalizeVatRate(line.vat_rate ?? line.vat ?? line.proc_tva);

  return {
    name: stringValue(line.name ?? line.description) || `Articol ${index + 1}`,
    quantity,
    unitPrice: unitPrice || (quantity ? round2(netAmount / quantity) : netAmount),
    netAmount,
    vatAmount,
    vatRate,
    vatCode: stringValue(line.vat) || vatCodeFromRate(vatRate),
    unit: stringValue(line.um ?? line.unitOfMeasure) || 'BUCATA',
    accountCode: stringValue(line.account_code ?? line.accountCode ?? line.cont),
    articleCode: stringValue(
      line.articleCode ?? line.article_code ?? line.cod_articol_client,
    ),
    management: optionalString(line.management ?? line.gestiune),
    articleType: stringValue(line.article_type ?? line.itemType) || 'MARFURI',
    vatDeductibility: normalizeDeductibility(
      line.vat_deductibility ?? line.deduction_type ?? line.tip_deducere,
    ),
    raw: line,
  };
}

function isRawVehiclePurchaseContract(
  raw: Record<string, any>,
  direction?: AccountingDirection,
): boolean {
  const transaction = stringValue(raw.vehicle_transaction).toLowerCase();
  if (transaction === 'purchase') return direction !== 'outgoing';
  if (direction === 'outgoing' || !optionalString(raw.vin)) return false;
  const type = stringValue(raw.contract_type).toLowerCase();
  return (
    type.includes('vanzare') ||
    type.includes('vânzare') ||
    type.includes('sale') ||
    type.includes('achiz')
  );
}

function normalizePartyKind(value: unknown): 'INDIVIDUAL' | 'COMPANY' {
  const normalized = stringValue(value).toUpperCase();
  return ['INDIVIDUAL', 'PERSOANA_FIZICA', 'PERSOANĂ_FIZICĂ', 'PERSON'].includes(
    normalized,
  )
    ? 'INDIVIDUAL'
    : 'COMPANY';
}

function vehicleDescription(raw: Record<string, any>): string {
  const identity = [
    raw.vehicle_make ?? raw.make,
    raw.vehicle_model ?? raw.model,
    raw.vehicle_variant ?? raw.variant,
  ]
    .map(stringValue)
    .filter(Boolean)
    .join(' ');
  const vin = stringValue(raw.vin).toUpperCase();
  return ['Autoturism', identity, vin ? `VIN ${vin}` : '']
    .filter(Boolean)
    .join(' ');
}

function normalizeDirection(value: unknown): AccountingDirection | undefined {
  const text = stringValue(value).toLowerCase();
  if (['incoming', 'intrare', 'achizitie', 'purchase'].includes(text)) return 'incoming';
  if (['outgoing', 'iesire', 'vanzare', 'sale'].includes(text)) return 'outgoing';
  return undefined;
}

function enforceVehicleArticleIdentity(
  documentType: string,
  direction: AccountingDirection | undefined,
  raw: Record<string, any>,
  lines: CanonicalLineItem[],
): void {
  const articleCode = vehicleArticleCode(
    raw.vin ?? raw.vehicle_vin ?? raw.chassis_number,
  );
  if (!articleCode || direction === 'outgoing' || lines.length === 0) return;

  const transaction = stringValue(raw.vehicle_transaction).toLowerCase();
  const purchaseInvoice =
    documentType === 'Invoice' &&
    (transaction === 'purchase' ||
      (!['cost', 'other'].includes(transaction) &&
        lines.some(isVehicleStockArticleLine)));
  const purchaseContract =
    documentType === 'Contract' &&
    isRawVehiclePurchaseContract(raw, direction);
  if (!purchaseInvoice && !purchaseContract) return;

  const stockLines = lines.filter(
    (line) => !isFreightArticleLine(line) && isVehicleStockArticleLine(line),
  );
  const targets =
    stockLines.length > 0
      ? stockLines
      : lines.length === 1 && !isFreightArticleLine(lines[0])
        ? lines
        : [];
  for (const line of targets) {
    line.articleCode = articleCode;
  }
}

function removeVehicleCostArticleIdentity(
  documentType: string,
  raw: Record<string, any>,
  lines: CanonicalLineItem[],
): void {
  if (
    documentType !== 'Invoice' ||
    stringValue(raw.vehicle_transaction).toLowerCase() !== 'cost'
  ) {
    return;
  }
  for (const line of lines) {
    line.articleCode = '';
    line.articleType = 'Nedefinit';
    line.management = undefined;
  }
}

function isVehicleStockArticleLine(line: CanonicalLineItem): boolean {
  return (
    /^371/.test(line.accountCode) ||
    /\b(auto|autoturism|vehicle|vehicul|fahrzeug)\b/i.test(line.name)
  );
}

function isFreightArticleLine(line: CanonicalLineItem): boolean {
  return (
    /^624/.test(line.accountCode) ||
    /transport|freight|fracht|platform|tractare|remorcare|\btow\b/i.test(
      line.name,
    )
  );
}

function normalizeReceiptType(
  value: unknown,
  hasReferences: boolean,
): CanonicalAccountingDocument['receiptType'] {
  const text = stringValue(value).toLowerCase();
  if (text === 'payment_receipt' || hasReferences) return 'payment_receipt';
  if (text === 'independent_receipt') return 'independent_receipt';
  return undefined;
}

function normalizePaymentMethod(
  value: unknown,
): CanonicalAccountingDocument['paymentMethod'] {
  const text = stringValue(value).toLowerCase();
  if (
    ['bank', 'transfer', 'card'].some((term) => text.includes(term)) ||
    text.includes('5121') ||
    text.includes('5124')
  ) {
    return 'bank';
  }
  if (text) return 'cash';
  return undefined;
}

function normalizeDeductibility(value: unknown): VatDeductibility {
  const text = stringValue(value).toUpperCase();
  if (text === 'PARTIAL_50' || text === 'N50') return 'PARTIAL_50';
  if (text === 'NONE' || text === 'I') return 'NONE';
  return 'FULL';
}

function normalizeCurrency(value: unknown): string {
  const text = stringValue(value).toUpperCase();
  if (['LEI', 'LEU'].includes(text)) return 'RON';
  if (text === 'EURO' || text === '€') return 'EUR';
  return text || 'RON';
}

function normalizeCountry(value: unknown): string {
  return normalizePartyCountry(stringValue(value));
}

function positiveNumber(value: unknown): number {
  if (typeof value === 'string') {
    value = value.replace(/\s/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? round2(numeric) : 0;
}

function optionalPositiveNumber(value: unknown): number | undefined {
  const numeric = positiveNumber(value);
  return numeric > 0 ? numeric : undefined;
}

function optionalExchangeRate(value: unknown): number | undefined {
  if (typeof value === 'string') {
    value = value.replace(/\s/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function stringValue(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function optionalString(value: unknown): string | undefined {
  const text = stringValue(value);
  return text || undefined;
}

function booleanValue(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return ['true', 'da', 'yes', '1'].includes(stringValue(value).toLowerCase());
}

function uniqueStrings(values: unknown[]): string[] {
  return Array.from(
    new Set(
      values
        .flatMap((value) =>
          typeof value === 'string' && value.includes(',')
            ? value.split(',')
            : [value],
        )
        .map(stringValue)
        .filter(Boolean),
    ),
  );
}

function normalizeReferenceValue(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');
}

function validDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
