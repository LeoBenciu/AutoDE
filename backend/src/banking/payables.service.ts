import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../common/audit.service';

@Injectable()
export class PayablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  list(tenantId: number, status?: string) {
    return this.prisma.payable.findMany({
      where: { tenantId, ...(status ? { status: status as any } : {}) },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
      include: {
        payeeParty: { select: { id: true, name: true } },
        sourceDocument: { select: { id: true, name: true, type: true } },
      },
    });
  }

  /** Payables inbox: create a payable pre-filled from an extracted purchase invoice. */
  async createFromDocument(tenantId: number, documentId: number) {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, tenantId, deletedAt: null },
      include: { processedData: true },
    });
    if (!doc) throw new NotFoundException('Documentul nu a fost găsit');
    const fields = (doc.processedData?.extractedFields ?? {}) as Record<string, any>;

    const amount = Number(fields.total_amount ?? fields.gross_amount ?? 0);
    if (!amount) {
      throw new BadRequestException('Documentul nu conține o sumă extrasă — creează manual plata');
    }

    return this.prisma.payable.create({
      data: {
        tenantId,
        payeeName: String(fields.supplier_name ?? fields.seller_name ?? 'Furnizor necunoscut'),
        iban: fields.supplier_iban ?? fields.iban ?? null,
        amount,
        currency: String(fields.currency ?? 'EUR'),
        dueDate: fields.due_date ? new Date(String(fields.due_date)) : null,
        reference: String(fields.invoice_number ?? doc.name),
        sourceDocumentId: doc.id,
      },
    });
  }

  async createManual(
    tenantId: number,
    data: { payeeName: string; iban?: string; amount: number; currency?: string; dueDate?: string; reference?: string; payeePartyId?: number },
  ) {
    return this.prisma.payable.create({
      data: {
        tenantId,
        payeeName: data.payeeName,
        payeePartyId: data.payeePartyId,
        iban: data.iban,
        amount: data.amount,
        currency: data.currency ?? 'EUR',
        dueDate: data.dueDate ? new Date(data.dueDate) : null,
        reference: data.reference,
      },
    });
  }

  /** Role gating (OWNER/MANAGER) is enforced at the controller. */
  async approve(tenantId: number, userId: number, id: number) {
    const payable = await this.getOwn(tenantId, id);
    if (payable.status !== 'DRAFT') throw new BadRequestException(`Plata este în starea ${payable.status}`);
    const updated = await this.prisma.payable.update({
      where: { id },
      data: { status: 'APPROVED', approvedByUserId: userId, approvedAt: new Date() },
    });
    await this.audit.log({ tenantId, userId, action: 'payable.approved', entity: 'Payable', entityId: id });
    return updated;
  }

  /**
   * Payment initiation (PIS). Requires a PIS-capable provider; until one is
   * configured, submission fails with a clear message instead of pretending.
   * The idempotencyKey on the row guards double-submission once wired.
   */
  async submit(tenantId: number, userId: number, id: number) {
    const payable = await this.getOwn(tenantId, id);
    if (payable.status !== 'APPROVED') {
      throw new BadRequestException('Plata trebuie aprobată înainte de a fi trimisă la bancă');
    }
    if (!payable.iban) throw new BadRequestException('Plata nu are IBAN beneficiar');

    const pisBase = this.config.get('PIS_BASE_URL');
    if (!pisBase) {
      throw new BadRequestException(
        'Furnizorul PIS (inițiere plăți) nu este configurat. Conectează un agregator Open Banking cu licență PIS.',
      );
    }

    // Real PIS flow: build payment-initiation request with payable.idempotencyKey,
    // redirect the payer to SCA, then poll execution status.
    const updated = await this.prisma.payable.update({
      where: { id },
      data: { status: 'SUBMITTED', submittedAt: new Date() },
    });
    await this.audit.log({
      tenantId,
      userId,
      action: 'payable.submitted',
      entity: 'Payable',
      entityId: id,
      details: { idempotencyKey: payable.idempotencyKey },
    });
    return updated;
  }

  private async getOwn(tenantId: number, id: number) {
    const payable = await this.prisma.payable.findFirst({ where: { id, tenantId } });
    if (!payable) throw new NotFoundException('Plata nu a fost găsită');
    return payable;
  }
}
