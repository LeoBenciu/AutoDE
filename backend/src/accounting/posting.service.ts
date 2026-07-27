import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LedgerSourceType, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import {
  CanonicalAccountingDocument,
  CanonicalLineItem,
  isVehiclePurchaseContract,
  normalizeAccountingDocument,
  normalizeEin,
  round2,
} from './accounting-normalizer';
import { resolveExchangeRateToRon } from './fx';
import {
  removeDocumentVehicleCosts,
  syncApprovedDocumentVehicleEffects,
} from '../vehicles/vehicle-document-sync';

export interface JournalDraftLine {
  accountCode: string;
  debit: number;
  credit: number;
  description: string;
  originalAmount?: number;
}

export interface PostingPreview {
  documentId: number;
  documentType: string;
  sourceType?: LedgerSourceType;
  postingDate?: string;
  currency: string;
  exchangeRate: number;
  entries: JournalDraftLine[];
  totalDebit: number;
  totalCredit: number;
  errors: string[];
  warnings: string[];
  referencedDocumentIds: number[];
}

interface ReferenceDocument {
  id: number;
  number: string;
  direction?: 'incoming' | 'outgoing';
  canonical: CanonicalAccountingDocument;
}

interface ResolvedAccounts {
  payable: string;
  receivable: string;
  supplierId?: number;
  clientId?: number;
}

@Injectable()
export class PostingService {
  constructor(private readonly prisma: PrismaService) {}

  async preview(tenantId: number, documentId: number): Promise<PostingPreview> {
    const context = await this.loadContext(tenantId, documentId);
    const references = await this.resolveReferences(
      tenantId,
      documentId,
      context.canonical.referencedNumbers,
      context.tenant.cui,
    );
    const accounts = await this.findExistingPartyAccounts(
      tenantId,
      context.canonical,
      references,
    );
    return this.buildPreview(
      documentId,
      context.canonical,
      context.tenant,
      references,
      accounts,
    );
  }

  async approve(
    tenantId: number,
    userId: number,
    documentId: number,
  ): Promise<{ document: any; posting: PostingPreview }> {
    const context = await this.loadContext(tenantId, documentId);
    if (context.document.reviewStatus === 'LEGACY') {
      throw new BadRequestException(
        'Documentul este anterior activării registrului contabil și nu poate fi postat automat',
      );
    }
    if (
      context.document.reviewStatus === 'APPROVED' &&
      context.document.postingStatus !== 'ERROR'
    ) {
      return {
        document: context.document,
        posting: await this.preview(tenantId, documentId),
      };
    }

    const references = await this.resolveReferences(
      tenantId,
      documentId,
      context.canonical.referencedNumbers,
      context.tenant.cui,
    );
    const baseAccounts = await this.findExistingPartyAccounts(
      tenantId,
      context.canonical,
      references,
    );
    const initialPreview = await this.buildPreview(
      documentId,
      context.canonical,
      context.tenant,
      references,
      baseAccounts,
    );
    if (initialPreview.errors.length > 0) {
      throw new BadRequestException({
        message: 'Documentul nu poate fi aprobat',
        errors: initialPreview.errors,
        warnings: initialPreview.warnings,
      });
    }

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.document.updateMany({
          where: {
            id: documentId,
            tenantId,
            reviewStatus: { in: ['PENDING_APPROVAL', 'REOPENED'] },
          },
          data: { postingStatus: 'NONE', postingError: null },
        });
        if (claimed.count === 0) {
          const current = await tx.document.findUnique({ where: { id: documentId } });
          if (current?.reviewStatus === 'APPROVED') return { alreadyApproved: true };
          throw new BadRequestException(
            'Starea documentului s-a schimbat. Reîncarcă documentul și încearcă din nou.',
          );
        }

        const accounts = await this.upsertCatalogues(
          tx,
          tenantId,
          context.canonical,
          references,
        );
        const finalPreview = await this.buildPreview(
          documentId,
          context.canonical,
          context.tenant,
          references,
          accounts,
        );
        if (finalPreview.errors.length > 0) {
          throw new BadRequestException({
            message: 'Documentul nu poate fi aprobat',
            errors: finalPreview.errors,
          });
        }

        await syncApprovedDocumentVehicleEffects(
          tx,
          tenantId,
          context.document,
          context.canonical,
          context.tenant.isVatPayer,
          accounts.supplierId,
          finalPreview.exchangeRate,
        );
        await tx.generalLedgerEntry.deleteMany({ where: { documentId, tenantId } });
        for (let index = 0; index < finalPreview.entries.length; index += 1) {
          const line = finalPreview.entries[index];
          await tx.generalLedgerEntry.create({
            data: {
              tenantId,
              postingDate: new Date(`${finalPreview.postingDate}T12:00:00.000Z`),
              accountCode: line.accountCode,
              debit: new Prisma.Decimal(line.debit),
              credit: new Prisma.Decimal(line.credit),
              currency: context.canonical.currency,
              originalAmount:
                line.originalAmount != null
                  ? new Prisma.Decimal(line.originalAmount)
                  : null,
              exchangeRate: new Prisma.Decimal(finalPreview.exchangeRate),
              sourceType: finalPreview.sourceType!,
              sourceId: String(documentId),
              postingKey: `DOC:${documentId}:${finalPreview.sourceType}:${finalPreview.postingDate}:${index}`,
              description: line.description,
              reference: context.canonical.documentNumber || context.document.name,
              documentId,
            },
          });
        }

        const referenceAmounts = allocateReferenceAmounts(
          context.canonical,
          references,
        );
        for (const reference of references) {
          await tx.documentRelationship.upsert({
            where: {
              parentId_childId: {
                parentId: reference.id,
                childId: documentId,
              },
            },
            update: {
              relation: 'payment',
              paymentAmount: new Prisma.Decimal(
                referenceAmounts.get(reference.id) ??
                  context.canonical.totalAmount,
              ),
              createdById: userId,
            },
            create: {
              parentId: reference.id,
              childId: documentId,
              relation: 'payment',
              paymentAmount: new Prisma.Decimal(
                referenceAmounts.get(reference.id) ??
                  context.canonical.totalAmount,
              ),
              createdById: userId,
            },
          });
        }

        const now = new Date();
        const document = await tx.document.update({
          where: { id: documentId },
          data: {
            reviewStatus: 'APPROVED',
            postingStatus:
              finalPreview.entries.length > 0 ? 'POSTED' : 'NONE',
            needsReview: false,
            approvedAt: now,
            approvedById: userId,
            postedAt: finalPreview.entries.length > 0 ? now : null,
            postingError: null,
          },
          include: { processedData: true, ledgerEntries: true },
        });
        await tx.auditLog.create({
          data: {
            tenantId,
            userId,
            action: 'document.approved_and_posted',
            entity: 'Document',
            entityId: documentId,
            details: {
              sourceType: finalPreview.sourceType,
              entries: finalPreview.entries.length,
              totalDebit: finalPreview.totalDebit,
              totalCredit: finalPreview.totalCredit,
              warnings: finalPreview.warnings,
            },
          },
        });
        return { alreadyApproved: false, document, finalPreview };
      });

      if (result.alreadyApproved) {
        const document = await this.loadContext(tenantId, documentId);
        return {
          document: document.document,
          posting: await this.preview(tenantId, documentId),
        };
      }
      return {
        document: result.document,
        posting: result.finalPreview!,
      };
    } catch (error) {
      const message = extractErrorMessage(error);
      await this.prisma.document
        .updateMany({
          where: {
            id: documentId,
            tenantId,
            reviewStatus: { not: 'APPROVED' },
          },
          data: { postingStatus: 'ERROR', postingError: message.slice(0, 1000) },
        })
        .catch(() => undefined);
      throw error;
    }
  }

  async reopen(
    tenantId: number,
    userId: number,
    documentId: number,
  ): Promise<any> {
    return this.prisma.$transaction(async (tx) => {
      const document = await tx.document.findFirst({
        where: { id: documentId, tenantId, deletedAt: null },
      });
      if (!document) throw new NotFoundException('Documentul nu a fost găsit');
      if (document.reviewStatus !== 'APPROVED') {
        throw new BadRequestException('Doar un document aprobat poate fi redeschis');
      }
      await tx.generalLedgerEntry.deleteMany({ where: { tenantId, documentId } });
      await tx.documentRelationship.deleteMany({
        where: { childId: documentId, relation: 'payment' },
      });
      await removeDocumentVehicleCosts(tx, documentId);
      const reopened = await tx.document.update({
        where: { id: documentId },
        data: {
          reviewStatus: 'REOPENED',
          postingStatus: 'NONE',
          needsReview: true,
          approvedAt: null,
          approvedById: null,
          postedAt: null,
          postingError: null,
        },
        include: { processedData: true },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          userId,
          action: 'document.reopened',
          entity: 'Document',
          entityId: documentId,
        },
      });
      return reopened;
    });
  }

  async listLedger(
    tenantId: number,
    filters: {
      from?: string;
      to?: string;
      accountCode?: string;
      sourceType?: string;
      documentId?: number;
      page?: number;
      size?: number;
    },
  ) {
    const page = Math.max(1, filters.page ?? 1);
    const size = Math.min(200, Math.max(1, filters.size ?? 50));
    const where: Prisma.GeneralLedgerEntryWhereInput = { tenantId };
    if (filters.from || filters.to) {
      where.postingDate = {
        ...(filters.from
          ? { gte: new Date(`${filters.from}T00:00:00.000Z`) }
          : {}),
        ...(filters.to ? { lte: new Date(`${filters.to}T23:59:59.999Z`) } : {}),
      };
    }
    if (filters.accountCode) {
      where.accountCode = { startsWith: filters.accountCode };
    }
    if (filters.sourceType) where.sourceType = filters.sourceType as LedgerSourceType;
    if (filters.documentId) where.documentId = filters.documentId;

    const [entries, total] = await Promise.all([
      this.prisma.generalLedgerEntry.findMany({
        where,
        orderBy: [{ postingDate: 'desc' }, { id: 'desc' }],
        include: {
          document: {
            select: {
              id: true,
              name: true,
              type: true,
              processedData: { select: { extractedFields: true } },
            },
          },
        },
        skip: (page - 1) * size,
        take: size,
      }),
      this.prisma.generalLedgerEntry.count({ where }),
    ]);
    return {
      entries,
      total,
      page,
      size,
      pages: Math.ceil(total / size),
    };
  }

  private async loadContext(tenantId: number, documentId: number) {
    const [tenant, document] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId } }),
      this.prisma.document.findFirst({
        where: { id: documentId, tenantId, deletedAt: null },
        include: {
          processedData: true,
          ledgerEntries: true,
          approvedBy: { select: { id: true, name: true, email: true } },
        },
      }),
    ]);
    if (!tenant) throw new NotFoundException('Compania nu a fost găsită');
    if (!document) throw new NotFoundException('Documentul nu a fost găsit');
    if (!document.processedData) {
      throw new BadRequestException('Documentul nu are date extrase');
    }
    return {
      tenant,
      document,
      canonical: normalizeAccountingDocument(
        document.type,
        document.processedData.extractedFields,
        tenant.cui,
      ),
    };
  }

  private async buildPreview(
    documentId: number,
    canonical: CanonicalAccountingDocument,
    tenant: {
      cui: string | null;
      isVatPayer: boolean;
      defaultCurrency: string;
    },
    references: ReferenceDocument[],
    accounts: ResolvedAccounts,
  ): Promise<PostingPreview> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const purchaseContract = isVehiclePurchaseContract(canonical);
    const accountingType = [
      'Invoice',
      'Receipt',
      'Payment Disposition',
      'Collection Disposition',
    ].includes(canonical.documentType) || purchaseContract;

    if (!accountingType) {
      return {
        documentId,
        documentType: canonical.documentType,
        postingDate: canonical.documentDate,
        currency: canonical.currency || tenant.defaultCurrency,
        exchangeRate: 1,
        entries: [],
        totalDebit: 0,
        totalCredit: 0,
        errors,
        warnings: ['Acest tip de document nu generează note contabile'],
        referencedDocumentIds: [],
      };
    }

    if (!tenant.cui) errors.push('Completează CUI-ul companiei în Setări');
    if (!canonical.documentDate) errors.push('Data documentului este obligatorie');
    if (canonical.totalAmount <= 0) errors.push('Totalul documentului trebuie să fie pozitiv');
    if (
      ['Invoice', 'Receipt'].includes(canonical.documentType) &&
      !canonical.direction &&
      references.length === 0
    ) {
      errors.push(
        'Direcția documentului nu poate fi stabilită din CUI-ul furnizorului/cumpărătorului',
      );
    }
    if (canonical.documentType === 'Invoice') {
      if (!canonical.documentNumber) errors.push('Numărul facturii este obligatoriu');
      if (canonical.lineItems.length === 0) {
        errors.push('Factura trebuie să conțină cel puțin o linie');
      }
      const lineNet = round2(
        canonical.lineItems.reduce((sum, line) => sum + line.netAmount, 0),
      );
      if (
        canonical.lineItems.length > 0 &&
        Math.abs(lineNet - canonical.netAmount) > 0.05
      ) {
        errors.push(
          `Liniile însumează ${lineNet.toFixed(2)}, dar baza facturii este ${canonical.netAmount.toFixed(2)}`,
        );
      }
    }
    if (purchaseContract) {
      if (!canonical.documentNumber) {
        errors.push('Numărul contractului de achiziție este obligatoriu');
      }
      if (canonical.direction !== 'incoming') {
        errors.push(
          'Contractul de achiziție trebuie să identifice compania drept cumpărător',
        );
      }
      if (!canonical.vendor) {
        errors.push('Numele persoanei care vinde vehiculul este obligatoriu');
      }
      const raw = canonical.raw;
      const missingVehicleFields = [
        !raw.vin ? 'VIN' : '',
        !(raw.vehicle_make ?? raw.make) ? 'marca' : '',
        !(raw.vehicle_model ?? raw.model) ? 'modelul' : '',
        !(raw.vehicle_year ?? raw.year ?? raw.first_registration_date)
          ? 'anul'
          : '',
      ].filter(Boolean);
      if (missingVehicleFields.length > 0) {
        errors.push(
          `Completează datele vehiculului din contract: ${missingVehicleFields.join(', ')}`,
        );
      }
    }
    if (
      canonical.documentType === 'Receipt' &&
      canonical.receiptType !== 'payment_receipt' &&
      references.length === 0
    ) {
      if (canonical.lineItems.length === 0) {
        errors.push(
          'Chitanța sau bonul independent trebuie să conțină cel puțin o linie',
        );
      }
      const lineNet = round2(
        canonical.lineItems.reduce((sum, line) => sum + line.netAmount, 0),
      );
      if (
        canonical.lineItems.length > 0 &&
        Math.abs(lineNet - canonical.netAmount) > 0.05
      ) {
        errors.push(
          `Liniile însumează ${lineNet.toFixed(2)}, dar baza documentului este ${canonical.netAmount.toFixed(2)}`,
        );
      }
    }
    if (
      ['Payment Disposition', 'Collection Disposition'].includes(
        canonical.documentType,
      ) &&
      canonical.accountCode &&
      !validAccountCode(canonical.accountCode)
    ) {
      errors.push(`Cont contabil recomandat invalid: ${canonical.accountCode}`);
    }
    const statedReferenceAmounts = canonical.referencedInvoices
      .map((reference) => reference.amount)
      .filter((amount): amount is number => amount != null);
    const statedReferenceTotal = round2(
      statedReferenceAmounts.reduce((sum, amount) => sum + amount, 0),
    );
    if (statedReferenceTotal - canonical.totalAmount > 0.01) {
      errors.push(
        `Plățile alocate facturilor (${statedReferenceTotal.toFixed(2)}) depășesc totalul documentului (${canonical.totalAmount.toFixed(2)})`,
      );
    } else if (
      canonical.referencedInvoices.length > 0 &&
      statedReferenceAmounts.length === canonical.referencedInvoices.length &&
      Math.abs(statedReferenceTotal - canonical.totalAmount) > 0.01
    ) {
      errors.push(
        `Plățile alocate facturilor însumează ${statedReferenceTotal.toFixed(2)}, dar documentul are totalul ${canonical.totalAmount.toFixed(2)}`,
      );
    } else if (
      canonical.referencedInvoices.length > 1 &&
      statedReferenceAmounts.length < canonical.referencedInvoices.length
    ) {
      warnings.push(
        'Suma rămasă va fi distribuită egal între facturile fără valoare de plată explicită',
      );
    }
    for (const line of canonical.lineItems) {
      if (!line.accountCode) {
        warnings.push(
          `Linia „${line.name}” nu are cont; se va folosi ${canonical.direction === 'outgoing' ? '707' : '628'}`,
        );
      } else if (!validAccountCode(line.accountCode)) {
        errors.push(`Cont contabil invalid pentru „${line.name}”: ${line.accountCode}`);
      }
      if (!line.articleCode) {
        warnings.push(`Pentru „${line.name}” se va genera automat un cod de articol`);
      }
    }

    let exchangeRate = 1;
    if (errors.length === 0) {
      exchangeRate = await resolveExchangeRateToRon(canonical);
    }
    const built =
      errors.length === 0
        ? this.buildEntries(
            canonical,
            tenant.isVatPayer,
            references,
            accounts,
            exchangeRate,
            warnings,
          )
        : { sourceType: undefined, entries: [] as JournalDraftLine[] };

    const totalDebit = round2(
      built.entries.reduce((sum, entry) => sum + entry.debit, 0),
    );
    const totalCredit = round2(
      built.entries.reduce((sum, entry) => sum + entry.credit, 0),
    );
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      errors.push(
        `Nota contabilă nu este echilibrată: debit ${totalDebit.toFixed(2)}, credit ${totalCredit.toFixed(2)}`,
      );
    }
    return {
      documentId,
      documentType: canonical.documentType,
      sourceType: built.sourceType,
      postingDate: canonical.documentDate,
      currency: canonical.currency,
      exchangeRate,
      entries: built.entries,
      totalDebit,
      totalCredit,
      errors: unique(errors),
      warnings: unique(warnings),
      referencedDocumentIds: references.map((reference) => reference.id),
    };
  }

  private buildEntries(
    canonical: CanonicalAccountingDocument,
    isVatPayer: boolean,
    references: ReferenceDocument[],
    accounts: ResolvedAccounts,
    exchangeRate: number,
    warnings: string[],
  ): { sourceType?: LedgerSourceType; entries: JournalDraftLine[] } {
    if (canonical.documentType === 'Invoice') {
      return this.buildInvoiceEntries(
        canonical,
        isVatPayer,
        accounts,
        exchangeRate,
      );
    }
    if (isVehiclePurchaseContract(canonical)) {
      const amount = money(canonical.totalAmount, exchangeRate);
      return {
        sourceType: 'CONTRACT_PURCHASE',
        entries: balanceConvertedEntries([
          draft(
            '371',
            amount,
            0,
            `Autoturism achiziționat de la ${canonical.vendor}`,
            canonical.totalAmount,
          ),
          draft(
            '462',
            0,
            amount,
            `Datorie către vânzătorul persoană fizică ${canonical.vendor}`,
            canonical.totalAmount,
          ),
        ]),
      };
    }
    if (canonical.documentType === 'Receipt') {
      return this.buildReceiptEntries(
        canonical,
        isVatPayer,
        references,
        accounts,
        exchangeRate,
        warnings,
      );
    }
    const amount = money(canonical.totalAmount, exchangeRate);
    const original = canonical.totalAmount;
    if (canonical.documentType === 'Payment Disposition') {
      const counter =
        references.length > 0
          ? accounts.payable
          : canonical.accountCode ||
            (canonical.isAdvance ? '409' : accounts.payable);
      return {
        sourceType: 'PAYMENT_DISPOSITION',
        entries: balanceConvertedEntries(
          [
            draft(counter, amount, 0, 'Cont furnizor / cheltuială', original),
            draft('5311', 0, amount, 'Casa în lei', original),
          ],
        ),
      };
    }
    if (canonical.documentType === 'Collection Disposition') {
      const counter =
        references.length > 0
          ? accounts.receivable
          : canonical.accountCode ||
            (canonical.isAdvance ? '419' : accounts.receivable);
      return {
        sourceType: 'COLLECTION_DISPOSITION',
        entries: balanceConvertedEntries(
          [
            draft('5311', amount, 0, 'Casa în lei', original),
            draft(counter, 0, amount, 'Cont client / venit', original),
          ],
        ),
      };
    }
    return { entries: [] };
  }

  private buildInvoiceEntries(
    canonical: CanonicalAccountingDocument,
    isVatPayer: boolean,
    accounts: ResolvedAccounts,
    exchangeRate: number,
  ): { sourceType: LedgerSourceType; entries: JournalDraftLine[] } {
    const outgoing = canonical.direction === 'outgoing';
    const entries: JournalDraftLine[] = [];
    const total = money(canonical.totalAmount, exchangeRate);
    const lines =
      canonical.lineItems.length > 0
        ? canonical.lineItems
        : [
            {
              name: 'Conform facturii',
              netAmount: canonical.netAmount,
              vatAmount: canonical.vatAmount,
              accountCode: outgoing ? '707' : '628',
              vatDeductibility: 'FULL',
            } as CanonicalLineItem,
          ];

    if (outgoing) {
      entries.push(
        draft(
          accounts.receivable,
          total,
          0,
          `Client ${canonical.buyer || canonical.buyerEin}`,
          canonical.totalAmount,
        ),
      );
      let revenue = 0;
      for (const line of lines) {
        const originalLine =
          isVatPayer ? line.netAmount : line.netAmount + line.vatAmount;
        const value = money(originalLine, exchangeRate);
        revenue += value;
        entries.push(
          draft(
            canonical.isAdvance ? '419' : line.accountCode || '707',
            0,
            value,
            line.name,
            originalLine,
          ),
        );
      }
      if (isVatPayer && canonical.vatAmount > 0) {
        entries.push(
          draft(
            '4427',
            0,
            money(canonical.vatAmount, exchangeRate),
            'TVA colectată',
            canonical.vatAmount,
          ),
        );
      }
    } else {
      entries.push(
        draft(
          accounts.payable,
          0,
          total,
          `Furnizor ${canonical.vendor || canonical.vendorEin}`,
          canonical.totalAmount,
        ),
      );
      let deductibleVatOriginal = 0;
      for (const line of lines) {
        const lineVat =
          line.vatAmount ||
          (canonical.vatAmount > 0 && canonical.netAmount > 0
            ? (canonical.vatAmount * line.netAmount) / canonical.netAmount
            : 0);
        let deductible = 0;
        let nonDeductible = lineVat;
        if (isVatPayer) {
          if (line.vatDeductibility === 'FULL') {
            deductible = lineVat;
            nonDeductible = 0;
          } else if (line.vatDeductibility === 'PARTIAL_50') {
            deductible = lineVat / 2;
            nonDeductible = lineVat - deductible;
          }
        }
        deductibleVatOriginal += deductible;
        const originalExpense = line.netAmount + nonDeductible;
        entries.push(
          draft(
            canonical.isAdvance ? '409' : line.accountCode || '628',
            money(originalExpense, exchangeRate),
            0,
            line.name,
            originalExpense,
          ),
        );
      }
      if (isVatPayer && deductibleVatOriginal > 0) {
        entries.push(
          draft(
            '4426',
            money(deductibleVatOriginal, exchangeRate),
            0,
            'TVA deductibilă',
            deductibleVatOriginal,
          ),
        );
      }
      if (isVatPayer && canonical.reverseCharge) {
        const reverseVat =
          canonical.vatAmount ||
          canonical.netAmount *
            ((canonical.lineItems.find((line) => line.vatRate > 0)?.vatRate ?? 21) /
              100);
        entries.push(
          draft(
            '4426',
            money(reverseVat, exchangeRate),
            0,
            'Taxare inversă – TVA deductibilă',
            reverseVat,
          ),
        );
        entries.push(
          draft(
            '4427',
            0,
            money(reverseVat, exchangeRate),
            'Taxare inversă – TVA colectată',
            reverseVat,
          ),
        );
      }
    }
    return {
      sourceType: outgoing ? 'INVOICE_OUT' : 'INVOICE_IN',
      entries: balanceConvertedEntries(entries),
    };
  }

  private buildReceiptEntries(
    canonical: CanonicalAccountingDocument,
    isVatPayer: boolean,
    references: ReferenceDocument[],
    accounts: ResolvedAccounts,
    exchangeRate: number,
    warnings: string[],
  ): { sourceType: LedgerSourceType; entries: JournalDraftLine[] } {
    const liquidity =
      canonical.paymentMethod === 'bank'
        ? canonical.currency !== 'RON'
          ? '5124'
          : '5121'
        : '5311';
    const total = money(canonical.totalAmount, exchangeRate);
    const isPayment =
      canonical.receiptType === 'payment_receipt' || references.length > 0;
    const referenceDirection = references[0]?.direction;

    if (isPayment) {
      if (references.length === 0) {
        warnings.push(
          'Chitanța este marcată ca plată, dar factura referențiată nu a fost găsită; se folosește direcția chitanței',
        );
      }
      const direction = referenceDirection ?? canonical.direction ?? 'outgoing';
      if (direction === 'incoming') {
        return {
          sourceType: 'RECEIPT_IN',
          entries: balanceConvertedEntries([
            draft(
              accounts.payable,
              total,
              0,
              'Plată către furnizor',
              canonical.totalAmount,
            ),
            draft(
              liquidity,
              0,
              total,
              liquidity === '5311' ? 'Casa în lei' : 'Cont bancar',
              canonical.totalAmount,
            ),
          ]),
        };
      }
      return {
        sourceType: 'RECEIPT_OUT',
        entries: balanceConvertedEntries([
          draft(
            liquidity,
            total,
            0,
            liquidity === '5311' ? 'Casa în lei' : 'Cont bancar',
            canonical.totalAmount,
          ),
          draft(
            accounts.receivable,
            0,
            total,
            'Încasare de la client',
            canonical.totalAmount,
          ),
        ]),
      };
    }

    const outgoing = canonical.direction === 'outgoing';
    if (outgoing) {
      const lines =
        canonical.lineItems.length > 0
          ? canonical.lineItems
          : [
              {
                name: 'Venit conform bonului',
                netAmount: canonical.netAmount,
                vatAmount: canonical.vatAmount,
                accountCode: canonical.accountCode || '707',
                vatDeductibility: 'FULL',
              } as CanonicalLineItem,
            ];
      const entries: JournalDraftLine[] = [
        draft(
          liquidity,
          total,
          0,
          liquidity === '5311' ? 'Casa în lei' : 'Cont bancar',
          canonical.totalAmount,
        ),
      ];
      for (const line of lines) {
        const revenueOriginal = isVatPayer
          ? line.netAmount
          : line.netAmount + line.vatAmount;
        entries.push(
          draft(
            canonical.isAdvance ? '419' : line.accountCode || '707',
            0,
            money(revenueOriginal, exchangeRate),
            line.name,
            revenueOriginal,
          ),
        );
      }
      if (isVatPayer && canonical.vatAmount > 0) {
        entries.push(
          draft(
            '4427',
            0,
            money(canonical.vatAmount, exchangeRate),
            'TVA colectată',
            canonical.vatAmount,
          ),
        );
      }
      return {
        sourceType: 'RECEIPT_OUT',
        entries: balanceConvertedEntries(entries),
      };
    }

    const lines =
      canonical.lineItems.length > 0
        ? canonical.lineItems
        : [
            {
              name: 'Cheltuială conform bonului',
              netAmount: canonical.netAmount,
              vatAmount: canonical.vatAmount,
              accountCode: canonical.accountCode || '628',
              vatDeductibility: 'FULL',
            } as CanonicalLineItem,
          ];
    const entries: JournalDraftLine[] = [];
    let deductibleVatOriginal = 0;
    for (const line of lines) {
      const lineVat =
        line.vatAmount ||
        (canonical.vatAmount > 0 && canonical.netAmount > 0
          ? (canonical.vatAmount * line.netAmount) / canonical.netAmount
          : 0);
      let deductible = 0;
      let nonDeductible = lineVat;
      if (isVatPayer) {
        if (line.vatDeductibility === 'FULL') {
          deductible = lineVat;
          nonDeductible = 0;
        } else if (line.vatDeductibility === 'PARTIAL_50') {
          deductible = lineVat / 2;
          nonDeductible = lineVat - deductible;
        }
      }
      deductibleVatOriginal += deductible;
      const expenseOriginal = line.netAmount + nonDeductible;
      entries.push(
        draft(
          canonical.isAdvance ? '409' : line.accountCode || '628',
          money(expenseOriginal, exchangeRate),
          0,
          line.name,
          expenseOriginal,
        ),
      );
    }
    if (isVatPayer && deductibleVatOriginal > 0) {
      entries.push(
        draft(
          '4426',
          money(deductibleVatOriginal, exchangeRate),
          0,
          'TVA deductibilă',
          deductibleVatOriginal,
        ),
      );
    }
    entries.push(
      draft(
        liquidity,
        0,
        total,
        liquidity === '5311' ? 'Casa în lei' : 'Cont bancar',
        canonical.totalAmount,
      ),
    );
    return {
      sourceType: 'RECEIPT_IN',
      entries: balanceConvertedEntries(entries),
    };
  }

  private async resolveReferences(
    tenantId: number,
    documentId: number,
    numbers: string[],
    tenantCui?: string | null,
  ): Promise<ReferenceDocument[]> {
    if (numbers.length === 0) return [];
    const wanted = new Set(numbers.map(normalizeReference).filter(Boolean));
    const candidates = await this.prisma.document.findMany({
      where: {
        tenantId,
        id: { not: documentId },
        deletedAt: null,
        type: 'Invoice',
        processedData: { isNot: null },
      },
      include: { processedData: true },
      orderBy: { uploadedAt: 'desc' },
      take: 1000,
    });
    return candidates
      .map((document) => {
        const canonical = normalizeAccountingDocument(
          document.type,
          document.processedData?.extractedFields,
          tenantCui,
        );
        return {
          id: document.id,
          number: canonical.documentNumber,
          direction: canonical.direction,
          canonical,
        };
      })
      .filter((document) => wanted.has(normalizeReference(document.number)));
  }

  private async findExistingPartyAccounts(
    tenantId: number,
    canonical: CanonicalAccountingDocument,
    references: ReferenceDocument[],
  ): Promise<ResolvedAccounts> {
    const reference = references[0]?.canonical;
    const vendorEin = normalizeEin(reference?.vendorEin || canonical.vendorEin);
    const buyerEin = normalizeEin(reference?.buyerEin || canonical.buyerEin);
    const [supplier, client] = await Promise.all([
      vendorEin
        ? this.prisma.party.findFirst({ where: { tenantId, taxId: vendorEin } })
        : null,
      buyerEin
        ? this.prisma.party.findFirst({ where: { tenantId, taxId: buyerEin } })
        : null,
    ]);
    return {
      payable: supplier?.supplierAnalytic
        ? `401.${supplier.supplierAnalytic}`
        : '401',
      receivable: client?.clientAnalytic
        ? `411.${client.clientAnalytic}`
        : '411',
      supplierId: supplier?.id,
      clientId: client?.id,
    };
  }

  private async upsertCatalogues(
    tx: Prisma.TransactionClient,
    tenantId: number,
    canonical: CanonicalAccountingDocument,
    references: ReferenceDocument[],
  ): Promise<ResolvedAccounts> {
    const reference = references[0]?.canonical;
    const supplierCanonical =
      reference?.direction === 'incoming' ? reference : canonical;
    const clientCanonical =
      reference?.direction === 'outgoing' ? reference : canonical;
    const supplier = await this.upsertParty(
      tx,
      tenantId,
      'supplier',
      supplierCanonical.vendorEin,
      supplierCanonical.vendor,
      supplierCanonical.vendorCountry,
      supplierCanonical.vendorIban,
      supplierCanonical.vendorKind,
    );
    const client = await this.upsertParty(
      tx,
      tenantId,
      'client',
      clientCanonical.buyerEin,
      clientCanonical.buyer,
      clientCanonical.buyerCountry,
      undefined,
      clientCanonical.buyerKind,
    );

    for (const line of canonical.lineItems) {
      await this.upsertArticle(tx, tenantId, line);
      if (line.management) {
        await tx.management.upsert({
          where: {
            tenantId_code: { tenantId, code: line.management },
          },
          update: { name: line.management },
          create: {
            tenantId,
            code: line.management,
            name: line.management,
          },
        });
      }
    }
    return {
      payable: supplier?.supplierAnalytic
        ? `401.${supplier.supplierAnalytic}`
        : '401',
      receivable: client?.clientAnalytic
        ? `411.${client.clientAnalytic}`
        : '411',
      supplierId: supplier?.id,
      clientId: client?.id,
    };
  }

  private async upsertParty(
    tx: Prisma.TransactionClient,
    tenantId: number,
    role: 'supplier' | 'client',
    rawEin: string,
    name: string,
    country: string,
    iban?: string,
    kind: 'INDIVIDUAL' | 'COMPANY' = 'COMPANY',
  ): Promise<any | null> {
    const taxId = normalizeEin(rawEin);
    if (!taxId && !name) return null;
    let existing = taxId
      ? await tx.party.findFirst({ where: { tenantId, taxId } })
      : await tx.party.findFirst({
          where: { tenantId, name: { equals: name, mode: 'insensitive' } },
        });
    if (!existing) {
      existing = await tx.party.create({
        data: {
          tenantId,
          name: name || taxId,
          taxId: taxId || null,
          kind,
          country: country || 'RO',
          iban,
        },
      });
    }

    if (role === 'supplier') {
      const analytic =
        existing.supplierAnalytic ??
        (await this.nextPartyAnalytic(tx, tenantId, 'supplier'));
      return tx.party.update({
        where: { id: existing.id },
        data: {
          name: name || existing.name,
          taxId: taxId || existing.taxId,
          kind,
          country: country || existing.country,
          iban: iban || existing.iban,
          isSupplier: true,
          supplierAnalytic: analytic,
          supplierCode:
            existing.supplierCode ?? `FURN${analytic}`,
        },
      });
    }
    const analytic =
      existing.clientAnalytic ??
      (await this.nextPartyAnalytic(tx, tenantId, 'client'));
    return tx.party.update({
      where: { id: existing.id },
      data: {
        name: name || existing.name,
        taxId: taxId || existing.taxId,
        kind,
        country: country || existing.country,
        isClient: true,
        clientAnalytic: analytic,
        clientCode: existing.clientCode ?? `CLI${analytic}`,
      },
    });
  }

  private async nextPartyAnalytic(
    tx: Prisma.TransactionClient,
    tenantId: number,
    role: 'supplier' | 'client',
  ): Promise<string> {
    const parties = await tx.party.findMany({
      where: {
        tenantId,
        ...(role === 'supplier'
          ? { supplierAnalytic: { not: null } }
          : { clientAnalytic: { not: null } }),
      },
      select:
        role === 'supplier'
          ? { supplierAnalytic: true }
          : { clientAnalytic: true },
    });
    const max = (parties as any[]).reduce((current: number, party: any) => {
      const numeric = Number(
        role === 'supplier' ? party.supplierAnalytic : party.clientAnalytic,
      );
      return Number.isFinite(numeric) ? Math.max(current, numeric) : current;
    }, 0 as number);
    return String(max + 1).padStart(5, '0');
  }

  private async upsertArticle(
    tx: Prisma.TransactionClient,
    tenantId: number,
    line: CanonicalLineItem,
  ) {
    let article = line.articleCode
      ? await tx.article.findUnique({
          where: { tenantId_code: { tenantId, code: line.articleCode } },
        })
      : await tx.article.findFirst({
          where: { tenantId, name: { equals: line.name, mode: 'insensitive' } },
        });
    if (!article) {
      const count = await tx.article.count({ where: { tenantId } });
      const code = line.articleCode || `ART${String(count + 1).padStart(5, '0')}`;
      article = await tx.article.create({
        data: {
          tenantId,
          code,
          name: line.name,
          analyticCode: String(count + 1).padStart(5, '0'),
          vatRate: line.vatCode,
          unit: line.unit,
          type: line.articleType,
          accountCode: line.accountCode || null,
          management: line.management,
        },
      });
    } else {
      article = await tx.article.update({
        where: { id: article.id },
        data: {
          name: line.name || article.name,
          vatRate: line.vatCode || article.vatRate,
          unit: line.unit || article.unit,
          type: line.articleType || article.type,
          accountCode: line.accountCode || article.accountCode,
          management: line.management || article.management,
        },
      });
    }
    return article;
  }
}

function draft(
  accountCode: string,
  debit: number,
  credit: number,
  description: string,
  originalAmount?: number,
): JournalDraftLine {
  return {
    accountCode,
    debit: round2(debit),
    credit: round2(credit),
    description,
    originalAmount:
      originalAmount != null ? round2(Math.abs(originalAmount)) : undefined,
  };
}

function money(amount: number, exchangeRate: number): number {
  return round2(amount * exchangeRate);
}

function balanceConvertedEntries(entries: JournalDraftLine[]): JournalDraftLine[] {
  const filtered = entries.filter(
    (entry) => Math.abs(entry.debit) > 0.004 || Math.abs(entry.credit) > 0.004,
  );
  const debit = round2(filtered.reduce((sum, entry) => sum + entry.debit, 0));
  const credit = round2(filtered.reduce((sum, entry) => sum + entry.credit, 0));
  const difference = round2(debit - credit);
  if (Math.abs(difference) <= 0.05 && Math.abs(difference) > 0) {
    if (difference > 0) {
      const target = [...filtered].reverse().find((entry) => entry.credit > 0);
      if (target) target.credit = round2(target.credit + difference);
    } else {
      const target = [...filtered].reverse().find((entry) => entry.debit > 0);
      if (target) target.debit = round2(target.debit + Math.abs(difference));
    }
  }
  return filtered;
}

function normalizeReference(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');
}

function validAccountCode(value: string): boolean {
  return /^\d{3,4}(?:\.\d{1,10})?$/.test(value.trim());
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function allocateReferenceAmounts(
  canonical: CanonicalAccountingDocument,
  references: ReferenceDocument[],
): Map<number, number> {
  const result = new Map<number, number>();
  if (references.length === 0) return result;
  const explicit = references.map((reference) => {
    const amount = canonical.referencedInvoices.find(
      (candidate) =>
        normalizeReference(candidate.number) ===
        normalizeReference(reference.number),
    )?.amount;
    return { reference, amount };
  });
  const explicitTotal = round2(
    explicit.reduce((sum, item) => sum + (item.amount ?? 0), 0),
  );
  const missing = explicit.filter((item) => item.amount == null);
  let remainder = round2(canonical.totalAmount - explicitTotal);
  for (let index = 0; index < missing.length; index += 1) {
    const amount =
      index === missing.length - 1
        ? remainder
        : round2(remainder / (missing.length - index));
    result.set(missing[index].reference.id, amount);
    remainder = round2(remainder - amount);
  }
  for (const item of explicit) {
    if (item.amount != null) result.set(item.reference.id, item.amount);
  }
  if (references.length === 1 && result.size === 0) {
    result.set(references[0].id, canonical.totalAmount);
  }
  return result;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof BadRequestException) {
    const response = error.getResponse();
    if (typeof response === 'string') return response;
    if (response && typeof response === 'object') {
      const object = response as any;
      if (Array.isArray(object.errors)) return object.errors.join('; ');
      if (object.message) return String(object.message);
    }
  }
  return error instanceof Error ? error.message : String(error);
}
