import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { GeneralLedgerEntry, Party } from '@prisma/client';
import JSZip from 'jszip';
import {
  isVehiclePurchaseContract,
  normalizeAccountingDocument,
} from '../accounting/accounting-normalizer';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../common/prisma.service';
import {
  buildArticlesXml,
  buildFacturiXml,
  buildIncasariXml,
  buildPartnersXml,
  buildPlatiXml,
  SagaArticleRecord,
  SagaInvoiceRecord,
  SagaMovement,
  SagaPartnerRecord,
} from './saga-xml';

export const SAGA_EXPORT_TYPES = [
  'facturi',
  'incasari',
  'plati',
  'furnizori',
  'clienti',
  'articole',
] as const;

export type SagaExportType = (typeof SAGA_EXPORT_TYPES)[number];

export interface SagaExportRequest {
  from?: string;
  to?: string;
  types?: SagaExportType[];
  preset?: string;
}

interface CollectedSagaData {
  tenant: {
    cui: string | null;
    isVatPayer: boolean;
    hasTvaLaIncasare: boolean;
    accountingCutoverAt: Date;
  };
  from: string;
  to: string;
  types: SagaExportType[];
  invoices: SagaInvoiceRecord[];
  receipts: SagaMovement[];
  payments: SagaMovement[];
  suppliers: SagaPartnerRecord[];
  clients: SagaPartnerRecord[];
  articles: SagaArticleRecord[];
  excluded: Array<{ id: number; name: string; reason: string }>;
  blockingErrors: string[];
}

@Injectable()
export class SagaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async preview(tenantId: number, request: SagaExportRequest) {
    const data = await this.collect(tenantId, request);
    const counts = this.counts(data);
    return {
      from: data.from,
      to: data.to,
      cutoverAt: data.tenant.accountingCutoverAt,
      selectedTypes: data.types,
      counts,
      files: data.types.map((type) => ({
        type,
        rows: counts[type],
        included: counts[type] > 0,
        reason:
          counts[type] > 0
            ? undefined
            : 'Fișierul va fi omis deoarece nu are înregistrări',
      })),
      excluded: data.excluded,
      excludedCount: data.excluded.length,
      blockingErrors: data.blockingErrors,
      canExport: data.blockingErrors.length === 0,
    };
  }

  async getPreferences(tenantId: number): Promise<SagaExportRequest | null> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { sagaExportConfig: true },
    });
    if (!tenant) throw new NotFoundException('Compania nu a fost găsită');
    if (!tenant.sagaExportConfig) return null;
    return normalizePreference(tenant.sagaExportConfig);
  }

  async savePreferences(
    tenantId: number,
    request: SagaExportRequest,
  ): Promise<SagaExportRequest> {
    const preference = normalizePreference(request);
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { sagaExportConfig: preference as any },
    });
    return preference;
  }

  async exportZip(
    tenantId: number,
    userId: number,
    request: SagaExportRequest,
  ): Promise<{ content: Buffer; fileName: string; fileCount: number }> {
    const data = await this.collect(tenantId, request);
    if (data.blockingErrors.length > 0) {
      throw new BadRequestException({
        message: 'Exportul SAGA conține erori care trebuie corectate',
        errors: data.blockingErrors,
      });
    }

    const zip = new JSZip();
    const stamp = new Date().toISOString().slice(0, 10);
    const company = {
      cui: data.tenant.cui,
      isVatPayer: data.tenant.isVatPayer,
      hasTvaLaIncasare: data.tenant.hasTvaLaIncasare,
    };
    let fileCount = 0;
    const add = (name: string, rows: unknown[], contents: () => string) => {
      if (rows.length === 0) return;
      zip.file(name, contents());
      fileCount += 1;
    };

    if (data.types.includes('facturi')) {
      const cui = cleanFilePart(data.tenant.cui || 'FARA_CUI');
      add(`F_${cui}_${stamp}.xml`, data.invoices, () =>
        buildFacturiXml(data.invoices, company, data.articles),
      );
    }
    if (data.types.includes('incasari')) {
      add(`I_${stamp}.xml`, data.receipts, () =>
        buildIncasariXml(data.receipts),
      );
    }
    if (data.types.includes('plati')) {
      add(`P_${stamp}.xml`, data.payments, () => buildPlatiXml(data.payments));
    }
    if (data.types.includes('furnizori')) {
      add(`FUR_${stamp}.xml`, data.suppliers, () =>
        buildPartnersXml('Furnizori', data.suppliers),
      );
    }
    if (data.types.includes('clienti')) {
      add(`CLI_${stamp}.xml`, data.clients, () =>
        buildPartnersXml('Clienti', data.clients),
      );
    }
    if (data.types.includes('articole')) {
      add(`ART_${stamp}.xml`, data.articles, () =>
        buildArticlesXml(data.articles),
      );
    }

    if (fileCount === 0) {
      throw new BadRequestException(
        'Nu există înregistrări pentru tipurile și perioada selectate',
      );
    }
    const content = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    await this.audit.log({
      tenantId,
      userId,
      action: 'saga.zip_exported',
      entity: 'GeneralLedgerEntry',
      details: {
        from: data.from,
        to: data.to,
        types: data.types,
        counts: this.counts(data),
        fileCount,
      },
    });
    await this.savePreferences(tenantId, {
      from: data.from,
      to: data.to,
      types: data.types,
      preset: request.preset,
    });
    return {
      content,
      fileName: `SAGA_Export_${stamp}.zip`,
      fileCount,
    };
  }

  /**
   * Compatibility endpoint retained while consumers move to the ZIP wizard.
   * It now uses the canonical fields and the same approval/cutover rules.
   */
  async export(
    tenantId: number,
    userId: number,
    format: 'xml' | 'csv',
    from?: string,
    to?: string,
  ): Promise<{ content: string; fileName: string; contentType: string; count: number }> {
    const data = await this.collect(tenantId, {
      from,
      to,
      types: ['facturi'],
    });
    if (data.invoices.length === 0) {
      throw new BadRequestException(
        'Nicio factură aprobată în intervalul ales',
      );
    }
    const stamp = `${data.from}_${data.to}`;
    const content =
      format === 'csv'
        ? buildCompatibilityCsv(data.invoices)
        : buildFacturiXml(
            data.invoices,
            {
              cui: data.tenant.cui,
              isVatPayer: data.tenant.isVatPayer,
              hasTvaLaIncasare: data.tenant.hasTvaLaIncasare,
            },
            data.articles,
          );
    await this.audit.log({
      tenantId,
      userId,
      action: 'saga.compatibility_exported',
      entity: 'Document',
      details: { format, from: data.from, to: data.to, count: data.invoices.length },
    });
    return {
      content,
      fileName: `saga_facturi_${stamp}.${format}`,
      contentType:
        format === 'csv'
          ? 'text/csv; charset=utf-8'
          : 'application/xml; charset=utf-8',
      count: data.invoices.length,
    };
  }

  async exportPartners(
    tenantId: number,
    userId: number,
    tip: 'clienti' | 'furnizori',
  ): Promise<{ content: string; fileName: string; contentType: string; count: number }> {
    const data = await this.collect(tenantId, {
      types: [tip],
    });
    const partners = tip === 'furnizori' ? data.suppliers : data.clients;
    if (partners.length === 0) {
      throw new BadRequestException(
        'Niciun partener de exportat pentru categoria aleasă',
      );
    }
    await this.audit.log({
      tenantId,
      userId,
      action: 'saga.compatibility_exported',
      entity: 'Party',
      details: { tip, count: partners.length },
    });
    return {
      content: buildPartnersXml(
        tip === 'furnizori' ? 'Furnizori' : 'Clienti',
        partners,
      ),
      fileName: `saga_${tip}.xml`,
      contentType: 'application/xml; charset=utf-8',
      count: partners.length,
    };
  }

  private async collect(
    tenantId: number,
    request: SagaExportRequest,
  ): Promise<CollectedSagaData> {
    const { from, to } = normalizeRange(request.from, request.to);
    const types = normalizeTypes(request.types);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        cui: true,
        isVatPayer: true,
        hasTvaLaIncasare: true,
        accountingCutoverAt: true,
      },
    });
    if (!tenant) throw new NotFoundException('Compania nu a fost găsită');

    const [approvedDocuments, nonExportableDocuments, ledgerEntries, parties, articles] =
      await Promise.all([
        this.prisma.document.findMany({
          where: {
            tenantId,
            deletedAt: null,
            reviewStatus: 'APPROVED',
            uploadedAt: { gte: tenant.accountingCutoverAt },
            type: {
              in: [
                'Invoice',
                'Contract',
                'Receipt',
                'Payment Disposition',
                'Collection Disposition',
              ],
            },
          },
          include: {
            processedData: true,
            childLinks: {
              where: { relation: 'payment' },
              include: {
                parent: {
                  include: { processedData: true },
                },
              },
            },
          },
          orderBy: { uploadedAt: 'asc' },
        }),
        this.prisma.document.findMany({
          where: {
            tenantId,
            deletedAt: null,
            OR: [
              { uploadedAt: { lt: tenant.accountingCutoverAt } },
              {
                reviewStatus: {
                  in: ['LEGACY', 'PENDING_APPROVAL', 'REOPENED'],
                },
              },
              { postingStatus: 'ERROR' },
            ],
          },
          select: {
            id: true,
            name: true,
            type: true,
            reviewStatus: true,
            postingStatus: true,
            postingError: true,
            uploadedAt: true,
            processedData: { select: { extractedFields: true } },
          },
          orderBy: { uploadedAt: 'desc' },
          take: 200,
        }),
        this.prisma.generalLedgerEntry.findMany({
          where: {
            tenantId,
            postingDate: {
              gte: new Date(`${from}T00:00:00.000Z`),
              lte: new Date(`${to}T23:59:59.999Z`),
            },
            document: {
              is: {
                reviewStatus: 'APPROVED',
                uploadedAt: { gte: tenant.accountingCutoverAt },
                deletedAt: null,
              },
            },
          },
          include: {
            document: {
              include: {
                processedData: true,
                childLinks: {
                  where: { relation: 'payment' },
                  include: {
                    parent: { include: { processedData: true } },
                  },
                },
              },
            },
          },
          orderBy: [{ postingDate: 'asc' }, { id: 'asc' }],
        }),
        this.prisma.party.findMany({
          where: { tenantId },
          orderBy: { name: 'asc' },
        }),
        this.prisma.article.findMany({
          where: { tenantId },
          orderBy: [{ code: 'asc' }, { name: 'asc' }],
        }),
      ]);

    const invoices: SagaInvoiceRecord[] = [];
    for (const document of approvedDocuments) {
      if (!document.processedData) continue;
      const data = normalizeAccountingDocument(
        document.type,
        document.processedData.extractedFields,
        tenant.cui,
      );
      if (!data.documentDate || !inRange(data.documentDate, from, to)) continue;
      const independentReceipt =
        document.type === 'Receipt' &&
        data.receiptType !== 'payment_receipt' &&
        data.referencedNumbers.length === 0;
      const purchaseContract = isVehiclePurchaseContract(data);
      if (document.type === 'Invoice' || independentReceipt || purchaseContract) {
        invoices.push({ id: document.id, type: document.type, data });
      }
    }

    const movements = movementsFromLedger(ledgerEntries, tenant.cui);
    const suppliers = parties
      .filter((party) => party.isSupplier)
      .map((party) => partnerRecord(party, 'supplier'));
    const clients = parties
      .filter((party) => party.isClient)
      .map((party) => partnerRecord(party, 'client'));
    const articleRecords: SagaArticleRecord[] = articles.map((article) => ({
      code: article.code,
      name: article.name,
      analyticCode: article.analyticCode,
      vatRate: article.vatRate,
      unit: article.unit,
      type: article.type,
    }));
    const relevantNonExportableDocuments = nonExportableDocuments.filter(
      (document) => {
        const data = document.processedData
          ? normalizeAccountingDocument(
              document.type,
              document.processedData.extractedFields,
              tenant.cui,
            )
          : undefined;
        const effectiveDate =
          data?.documentDate ?? document.uploadedAt.toISOString().slice(0, 10);
        return inRange(effectiveDate, from, to);
      },
    );
    const excluded = relevantNonExportableDocuments.map((document) => ({
      id: document.id,
      name: document.name,
      reason:
        document.uploadedAt < tenant.accountingCutoverAt ||
        document.reviewStatus === 'LEGACY'
          ? 'Document istoric, anterior datei de activare'
          : document.postingStatus === 'ERROR'
            ? `Eroare la postare: ${document.postingError || 'detalii indisponibile'}`
            : document.reviewStatus === 'REOPENED'
              ? 'Document redeschis și neaprobat'
              : 'În așteptarea aprobării',
    }));
    const blockingErrors: string[] = [];
    if (types.includes('facturi') && !tenant.cui) {
      blockingErrors.push(
        'Completează CUI-ul companiei în Setări înainte de exportul facturilor',
      );
    }
    for (const document of relevantNonExportableDocuments) {
      if (document.postingStatus === 'ERROR' && document.postingError) {
        blockingErrors.push(`${document.name}: ${document.postingError}`);
      }
    }

    return {
      tenant,
      from,
      to,
      types,
      invoices,
      receipts: movements.receipts,
      payments: movements.payments,
      suppliers,
      clients,
      articles: articleRecords.filter((article) => article.analyticCode),
      excluded,
      blockingErrors: Array.from(new Set(blockingErrors)),
    };
  }

  private counts(data: CollectedSagaData): Record<SagaExportType, number> {
    return {
      facturi: data.invoices.length,
      incasari: data.receipts.length,
      plati: data.payments.length,
      furnizori: data.suppliers.length,
      clienti: data.clients.length,
      articole: data.articles.length,
    };
  }
}

function normalizePreference(value: unknown): SagaExportRequest {
  const object =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const { from, to } = normalizeRange(
    typeof object.from === 'string' ? object.from : undefined,
    typeof object.to === 'string' ? object.to : undefined,
  );
  return {
    from,
    to,
    types: normalizeTypes(
      Array.isArray(object.types) ? (object.types as SagaExportType[]) : undefined,
    ),
    preset: typeof object.preset === 'string' ? object.preset : 'custom',
  };
}

type LedgerWithDocument = GeneralLedgerEntry & {
  document: {
    id: number;
    name: string;
    type: string | null;
    processedData: { extractedFields: unknown } | null;
    childLinks: Array<{
      paymentAmount: unknown;
      parent: {
        id: number;
        type: string | null;
        processedData: { extractedFields: unknown } | null;
      };
    }>;
  } | null;
};

function movementsFromLedger(
  entries: LedgerWithDocument[],
  tenantCui: string | null,
): { receipts: SagaMovement[]; payments: SagaMovement[] } {
  const byDocument = new Map<number, LedgerWithDocument[]>();
  for (const entry of entries) {
    if (!entry.documentId || !entry.document) continue;
    const group = byDocument.get(entry.documentId) ?? [];
    group.push(entry);
    byDocument.set(entry.documentId, group);
  }
  const receipts: SagaMovement[] = [];
  const payments: SagaMovement[] = [];
  for (const [documentId, group] of byDocument) {
    const document = group[0].document!;
    if (!document.processedData) continue;
    const canonical = normalizeAccountingDocument(
      document.type,
      document.processedData.extractedFields,
      tenantCui,
    );
    const references = document.childLinks.filter(
      (link) => link.parent.processedData,
    );

    for (const liquidity of group.filter((entry) =>
      /^(5311|5121|5124)/.test(entry.accountCode),
    )) {
      const debit = Number(liquidity.debit);
      const credit = Number(liquidity.credit);
      if (debit <= 0 && credit <= 0) continue;
      const isReceipt = debit > 0;
      const counterpart =
        group.find((entry) =>
          isReceipt
            ? /^411/.test(entry.accountCode)
            : /^401/.test(entry.accountCode),
        ) ??
        group
          .filter(
            (entry) =>
              entry.id !== liquidity.id &&
              !/^(4426|4427|5311|5121|5124)/.test(entry.accountCode),
          )
          .sort(
            (a, b) =>
              Number(b.debit) +
              Number(b.credit) -
              Number(a.debit) -
              Number(a.credit),
          )[0];
      const targets = references.length > 0 ? references : [undefined];
      for (const target of targets) {
        const referencedCanonical = target?.parent.processedData
          ? normalizeAccountingDocument(
              target.parent.type,
              target.parent.processedData.extractedFields,
              tenantCui,
            )
          : undefined;
        const movement: SagaMovement = {
          date: liquidity.postingDate.toISOString().slice(0, 10),
          reference:
            liquidity.reference || canonical.documentNumber || document.name,
          amount:
            target?.paymentAmount != null
              ? Number(target.paymentAmount)
              : liquidity.originalAmount != null
                ? Number(liquidity.originalAmount)
                : isReceipt
                  ? debit
                  : credit,
          accountCode: liquidity.accountCode,
          counterAccount: counterpart?.accountCode || '',
          description:
            liquidity.description ||
            (isReceipt
              ? 'Încasare conform documentului'
              : 'Plată conform documentului'),
          currency: liquidity.currency || 'RON',
          sourceType: liquidity.sourceType,
          documentId: target?.parent.id ?? documentId,
          invoiceNumber:
            referencedCanonical?.documentNumber || canonical.documentNumber,
        };
        (isReceipt ? receipts : payments).push(movement);
      }
    }
  }
  return { receipts, payments };
}

function partnerRecord(
  party: Party,
  role: 'supplier' | 'client',
): SagaPartnerRecord {
  const supplier = role === 'supplier';
  return {
    name: party.name,
    taxId: party.taxId,
    country: party.country,
    county: party.county,
    city: party.city,
    address: party.address,
    iban: party.iban,
    bankName: party.bankName,
    phone: party.phone,
    email: party.email,
    registration: party.registration,
    discount: party.discount,
    code: supplier ? party.supplierCode : party.clientCode,
    analytic: supplier ? party.supplierAnalytic : party.clientAnalytic,
  };
}

function normalizeTypes(types?: SagaExportType[]): SagaExportType[] {
  if (!Array.isArray(types) || types.length === 0) return [...SAGA_EXPORT_TYPES];
  const normalized = types.filter((type): type is SagaExportType =>
    SAGA_EXPORT_TYPES.includes(type as SagaExportType),
  );
  if (normalized.length === 0) {
    throw new BadRequestException('Selectează cel puțin un tip de export');
  }
  return Array.from(new Set(normalized));
}

function normalizeRange(from?: string, to?: string): { from: string; to: string } {
  const now = new Date();
  const defaultTo = now.toISOString().slice(0, 10);
  const defaultFrom = `${defaultTo.slice(0, 8)}01`;
  const normalizedFrom = validIsoDate(from) ? from! : defaultFrom;
  const normalizedTo = validIsoDate(to) ? to! : defaultTo;
  if (normalizedFrom > normalizedTo) {
    throw new BadRequestException(
      'Data de început trebuie să fie înaintea datei de sfârșit',
    );
  }
  return { from: normalizedFrom, to: normalizedTo };
}

function validIsoDate(value?: string): boolean {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function inRange(value: string, from: string, to: string): boolean {
  return value >= from && value <= to;
}

function cleanFilePart(value: string): string {
  return value.replace(/^RO/i, '').replace(/[^A-Za-z0-9_-]/g, '');
}

function buildCompatibilityCsv(invoices: SagaInvoiceRecord[]): string {
  const quote = (value: unknown) =>
    `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = [
    [
      'Tip',
      'Numar',
      'Data',
      'Furnizor',
      'CUI furnizor',
      'Client',
      'CUI client',
      'Moneda',
      'Baza',
      'TVA',
      'Total',
    ].map(quote),
    ...invoices.map(({ data, type }) =>
      [
        type,
        data.documentNumber,
        data.documentDate,
        data.vendor,
        data.vendorEin,
        data.buyer,
        data.buyerEin,
        data.currency,
        data.netAmount,
        data.vatAmount,
        data.totalAmount,
      ].map(quote),
    ),
  ];
  return rows.map((row) => row.join(';')).join('\n');
}
