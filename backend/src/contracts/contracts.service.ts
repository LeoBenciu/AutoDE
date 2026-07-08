import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import PDFDocument = require('pdfkit');
import { PrismaService } from '../common/prisma.service';
import { S3Service } from '../common/s3.service';
import { AuditService } from '../common/audit.service';
import { amountInWords } from './ro-words';

export type ContractKind = 'vanzare-cumparare' | 'proces-verbal';

interface GenerateInput {
  vehicleId: number;
  buyerId: number;
  kind: ContractKind;
  price?: number;
  currency?: string;
}

@Injectable()
export class ContractsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly audit: AuditService,
  ) {}

  list(tenantId: number, vehicleId?: number) {
    return this.prisma.contract.findMany({
      where: { tenantId, ...(vehicleId ? { vehicleId } : {}) },
      orderBy: { createdAt: 'desc' },
      include: {
        vehicle: { select: { id: true, vin: true, make: true, model: true } },
        party: { select: { id: true, name: true } },
        document: { select: { id: true, name: true } },
      },
    });
  }

  /**
   * Generates a Romanian contract PDF from vehicle + party data, stores it
   * through the document store (attached to the vehicle) and records the
   * contract with a per-tenant number sequence.
   */
  async generate(tenantId: number, userId: number, input: GenerateInput) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: input.vehicleId, tenantId },
      include: { tenant: true },
    });
    if (!vehicle) throw new NotFoundException('Vehiculul nu a fost găsit');

    const buyer = await this.prisma.party.findFirst({ where: { id: input.buyerId, tenantId } });
    if (!buyer) throw new NotFoundException('Cumpărătorul nu a fost găsit');

    const price = input.price ?? (vehicle.soldPrice != null ? Number(vehicle.soldPrice) : undefined);
    if (input.kind === 'vanzare-cumparare' && price == null) {
      throw new BadRequestException('Prețul de vânzare lipsește — setează-l pe vehicul sau trimite-l explicit');
    }
    const currency = input.currency ?? vehicle.soldCurrency ?? 'RON';

    const series = input.kind === 'vanzare-cumparare' ? 'CV' : 'PV';
    const number = await this.nextNumber(tenantId, series);
    const contractNumber = `${series}-${String(number).padStart(5, '0')}`;
    const today = new Date();

    const pdf = await this.renderPdf(input.kind, {
      contractNumber,
      date: today.toLocaleDateString('ro-RO'),
      seller: {
        name: vehicle.tenant.name,
        taxId: vehicle.tenant.cui ?? '________________',
        address: vehicle.tenant.address ?? '________________',
      },
      buyer: {
        name: buyer.name,
        taxId: buyer.taxId ?? '________________',
        address: buyer.address ?? '________________',
        kind: buyer.kind,
      },
      vehicle: {
        make: vehicle.make,
        model: vehicle.model,
        variant: vehicle.variant ?? '',
        vin: vehicle.vin,
        year: vehicle.year,
        firstRegistered: vehicle.firstRegistered?.toLocaleDateString('ro-RO') ?? '—',
        mileageKm: vehicle.mileageKm ?? undefined,
        color: vehicle.color ?? '—',
      },
      price,
      currency,
    });

    const fileName = `${contractNumber}_${vehicle.vin}.pdf`;
    const s3Key = `tenants/${tenantId}/contracts/${randomUUID()}/${fileName}`;
    await this.s3.putObject(s3Key, pdf, 'application/pdf');

    const document = await this.prisma.document.create({
      data: {
        name: fileName,
        type: input.kind === 'vanzare-cumparare' ? 'Sale Contract' : 'Handover Protocol',
        s3Key,
        contentType: 'application/pdf',
        fileSize: pdf.length,
        documentHash: createHash('sha256').update(pdf).digest('hex'),
        tenantId,
        vehicleId: vehicle.id,
        partyId: buyer.id,
        processingStatus: 'COMPLETED',
      },
    });

    const contract = await this.prisma.contract.create({
      data: {
        tenantId,
        vehicleId: vehicle.id,
        partyId: buyer.id,
        direction: 'OUTGOING',
        contractType: input.kind,
        contractNumber,
        contractDate: today,
        totalValue: price,
        currency,
        documentId: document.id,
      },
    });

    await this.audit.log({
      tenantId,
      userId,
      action: 'contract.generated',
      entity: 'Contract',
      entityId: contract.id,
      details: { contractNumber, kind: input.kind, vehicleId: vehicle.id },
    });

    return { contract, documentId: document.id };
  }

  private async nextNumber(tenantId: number, series: string): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const seq = await tx.contractNumberSequence.upsert({
        where: { tenantId_series: { tenantId, series } },
        create: { tenantId, series, nextNumber: 2 },
        update: { nextNumber: { increment: 1 } },
      });
      // On create the reserved number is 1; on update it's the pre-increment value.
      return seq.nextNumber - 1;
    });
  }

  private renderPdf(kind: ContractKind, data: any): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 56 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const title =
        kind === 'vanzare-cumparare'
          ? 'CONTRACT DE VÂNZARE-CUMPĂRARE AUTO'
          : 'PROCES-VERBAL DE PREDARE-PRIMIRE AUTOVEHICUL';

      doc.font('Helvetica-Bold').fontSize(14).text(title, { align: 'center' });
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(10).text(`Nr. ${data.contractNumber} din ${data.date}`, { align: 'center' });
      doc.moveDown(1.2);

      doc.fontSize(10);
      section(doc, 'I. PĂRȚILE');
      doc.text(
        `1. ${data.seller.name}, cu sediul în ${data.seller.address}, CUI/CIF ${data.seller.taxId}, în calitate de VÂNZĂTOR,`,
      );
      doc.moveDown(0.3);
      doc.text(
        `2. ${data.buyer.name}, ${data.buyer.kind === 'COMPANY' ? 'cu sediul în' : 'domiciliat(ă) în'} ${data.buyer.address}, ` +
          `${data.buyer.kind === 'COMPANY' ? 'CUI/CIF' : 'CNP'} ${data.buyer.taxId}, în calitate de CUMPĂRĂTOR,`,
      );
      doc.moveDown(0.8);

      section(doc, 'II. OBIECTUL');
      doc.text(
        `${kind === 'vanzare-cumparare' ? 'Vânzătorul vinde și cumpărătorul cumpără' : 'Se predă, respectiv se primește,'} autovehiculul:`,
      );
      doc.moveDown(0.3);
      const v = data.vehicle;
      const rows: Array<[string, string]> = [
        ['Marcă / Model', `${v.make} ${v.model} ${v.variant}`.trim()],
        ['Serie șasiu (VIN)', v.vin],
        ['An fabricație', String(v.year)],
        ['Prima înmatriculare', v.firstRegistered],
        ['Kilometraj', v.mileageKm != null ? `${v.mileageKm} km` : '—'],
        ['Culoare', v.color],
      ];
      for (const [label, value] of rows) {
        doc.font('Helvetica-Bold').text(`${label}: `, { continued: true }).font('Helvetica').text(value);
      }
      doc.moveDown(0.8);

      if (kind === 'vanzare-cumparare') {
        section(doc, 'III. PREȚUL');
        doc.text(
          `Prețul de vânzare este de ${data.price.toLocaleString('ro-RO')} ${data.currency} ` +
            `(${amountInWords(data.price, data.currency)}), achitat conform înțelegerii părților.`,
        );
        doc.moveDown(0.8);
        section(doc, 'IV. DECLARAȚII');
        doc.text(
          'Vânzătorul declară că autovehiculul este proprietatea sa, nu este gajat, sechestrat sau urmărit, ' +
            'iar cumpărătorul declară că a văzut și a verificat autovehiculul, cunoscând starea tehnică a acestuia. ' +
            'Predarea-primirea se consemnează prin proces-verbal separat sau prin semnarea prezentului contract.',
        );
      } else {
        section(doc, 'III. CONSTATĂRI');
        doc.text(
          'Autovehiculul se predă împreună cu cheile, documentele de înmatriculare și accesoriile aferente. ' +
            'Părțile constată că autovehiculul corespunde descrierii de mai sus.',
        );
      }
      doc.moveDown(2);

      const y = doc.y;
      doc.font('Helvetica-Bold').text('VÂNZĂTOR', 70, y);
      doc.text('CUMPĂRĂTOR', 350, y);
      doc.font('Helvetica').text(data.seller.name, 70, y + 16);
      doc.text(data.buyer.name, 350, y + 16);
      doc.text('Semnătura: ______________', 70, y + 44);
      doc.text('Semnătura: ______________', 350, y + 44);

      doc.end();
    });
  }
}

function section(doc: InstanceType<typeof PDFDocument>, title: string) {
  doc.font('Helvetica-Bold').text(title);
  doc.font('Helvetica');
  doc.moveDown(0.3);
}
