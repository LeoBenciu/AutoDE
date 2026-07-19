import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../common/audit.service';
import { buildSagaCsv, buildSagaPartnersXml, buildSagaXml, SagaInvoice, SagaPartner } from './saga-xml';

@Injectable()
export class SagaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async export(
    tenantId: number,
    userId: number,
    format: 'xml' | 'csv',
    from?: string,
    to?: string,
  ): Promise<{ content: string; fileName: string; contentType: string; count: number }> {
    const invoices = await this.collectInvoices(tenantId, from, to);
    if (invoices.length === 0) {
      throw new BadRequestException('Nicio factură procesată în intervalul ales');
    }

    await this.audit.log({
      tenantId,
      userId,
      action: 'saga.exported',
      entity: 'Document',
      details: { format, from, to, count: invoices.length },
    });

    const stamp = `${from ?? 'inceput'}_${to ?? 'azi'}`;
    if (format === 'csv') {
      return {
        content: buildSagaCsv(invoices),
        fileName: `saga_facturi_${stamp}.csv`,
        contentType: 'text/csv; charset=utf-8',
        count: invoices.length,
      };
    }
    return {
      content: buildSagaXml(invoices),
      fileName: `saga_facturi_${stamp}.xml`,
      contentType: 'application/xml; charset=utf-8',
      count: invoices.length,
    };
  }

  private async collectInvoices(tenantId: number, from?: string, to?: string): Promise<SagaInvoice[]> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    const docs = await this.prisma.document.findMany({
      where: { tenantId, deletedAt: null, type: 'Invoice', processingStatus: 'COMPLETED' },
      include: { processedData: true },
      orderBy: { uploadedAt: 'asc' },
    });

    const invoices: SagaInvoice[] = [];
    for (const doc of docs) {
      const f = (doc.processedData?.extractedFields ?? {}) as Record<string, any>;
      const invoiceDate: string | undefined = f.invoice_date ?? undefined;

      // Date-range filter on the extracted invoice date (ISO strings compare
      // lexicographically); documents without a date fall back to upload date.
      const effectiveDate = invoiceDate ?? doc.uploadedAt.toISOString().slice(0, 10);
      if (from && effectiveDate < from) continue;
      if (to && effectiveDate > to) continue;

      const lineItems: any[] = Array.isArray(f.line_items) ? f.line_items : [];
      invoices.push({
        documentId: doc.id,
        supplierName: String(f.supplier_name ?? 'Furnizor necunoscut'),
        supplierTaxId: f.supplier_tax_id ?? undefined,
        supplierCountry: f.supplier_country ?? undefined,
        supplierIban: f.supplier_iban ?? undefined,
        clientName: String(f.customer_name ?? tenant?.name ?? ''),
        clientTaxId: f.customer_tax_id ?? tenant?.cui ?? undefined,
        invoiceNumber: String(f.invoice_number ?? doc.name),
        invoiceDate,
        dueDate: f.due_date ?? undefined,
        currency: String(f.currency ?? 'RON'),
        netAmount: f.net_amount != null ? Number(f.net_amount) : undefined,
        vatAmount: f.vat_amount != null ? Number(f.vat_amount) : undefined,
        totalAmount: f.total_amount != null ? Number(f.total_amount) : undefined,
        lines: lineItems.map((li) => ({
          description: String(li.description ?? (f.vin ? `Autoturism VIN ${f.vin}` : 'Conform facturii')),
          quantity: li.quantity != null ? Number(li.quantity) : undefined,
          unitPrice: li.unit_price != null ? Number(li.unit_price) : undefined,
          netAmount: li.net_amount != null ? Number(li.net_amount) : undefined,
          vatRate: li.vat_rate != null ? Number(li.vat_rate) : undefined,
        })),
      });
    }
    return invoices;
  }

  /**
   * Partner nomenclature export (<Clienti>/<Furnizori> sections of the SAGA
   * import spec). Suppliers = parties selling vehicles to the dealership or
   * foreign companies; clients = vehicle buyers plus remaining RO parties.
   */
  async exportPartners(
    tenantId: number,
    userId: number,
    tip: 'clienti' | 'furnizori',
  ): Promise<{ content: string; fileName: string; contentType: string; count: number }> {
    const parties = await this.prisma.party.findMany({
      where: { tenantId },
      include: {
        vehiclesBought: { select: { id: true }, take: 1 },
        vehiclesSold: { select: { id: true }, take: 1 },
      },
    });

    const isSupplier = (p: (typeof parties)[number]) =>
      p.vehiclesSold.length > 0 || (p.country && p.country.toUpperCase() !== 'RO');
    const selected = parties.filter((p) => (tip === 'furnizori' ? isSupplier(p) : !isSupplier(p) || p.vehiclesBought.length > 0));

    if (selected.length === 0) {
      throw new BadRequestException('Niciun partener de exportat pentru categoria aleasă');
    }

    const partners: SagaPartner[] = selected.map((p) => ({
      id: p.id,
      name: p.name,
      taxId: p.taxId ?? undefined,
      country: p.country ?? undefined,
      address: p.address ?? undefined,
      iban: p.iban ?? undefined,
      phone: p.phone ?? undefined,
      email: p.email ?? undefined,
    }));

    await this.audit.log({
      tenantId,
      userId,
      action: 'saga.exported',
      entity: 'Party',
      details: { tip, count: partners.length },
    });

    return {
      content: buildSagaPartnersXml(tip === 'furnizori' ? 'Furnizori' : 'Clienti', partners),
      fileName: `saga_${tip}.xml`,
      contentType: 'application/xml; charset=utf-8',
      count: partners.length,
    };
  }
}
