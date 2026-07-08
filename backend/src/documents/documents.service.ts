import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { S3Service } from '../common/s3.service';
import { AuditService } from '../common/audit.service';

export interface UploadedDoc {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly audit: AuditService,
  ) {}

  /**
   * Upload pipeline step 1: file goes to S3 immediately, then a PendingUpload
   * row (the durable queue) is created. Extraction happens asynchronously.
   */
  async upload(tenantId: number, file: UploadedDoc, vehicleId?: number, partyId?: number) {
    if (!file?.buffer?.length) throw new BadRequestException('Fișier gol');
    const documentHash = createHash('sha256').update(file.buffer).digest('hex');

    const duplicate = await this.prisma.document.findFirst({
      where: { tenantId, documentHash, deletedAt: null },
      select: { id: true, name: true },
    });

    const s3Key = `tenants/${tenantId}/uploads/${randomUUID()}/${sanitizeName(file.originalname)}`;
    await this.s3.putObject(s3Key, file.buffer, file.mimetype);

    const pending = await this.prisma.pendingUpload.create({
      data: {
        s3Key,
        fileName: file.originalname,
        contentType: file.mimetype,
        fileSize: file.size,
        documentHash,
        tenantId,
        vehicleId,
        partyId,
      },
    });

    return { pendingUploadId: pending.id, duplicateOf: duplicate ?? null };
  }

  async list(tenantId: number, filters: { vehicleId?: number; partyId?: number; type?: string; needsReview?: boolean }) {
    const where: Prisma.DocumentWhereInput = { tenantId, deletedAt: null };
    if (filters.vehicleId) where.vehicleId = filters.vehicleId;
    if (filters.partyId) where.partyId = filters.partyId;
    if (filters.type) where.type = filters.type;
    if (filters.needsReview !== undefined) where.needsReview = filters.needsReview;
    const [documents, pending] = await Promise.all([
      this.prisma.document.findMany({
        where,
        orderBy: { uploadedAt: 'desc' },
        include: { processedData: true, vehicle: { select: { id: true, vin: true, make: true, model: true } } },
      }),
      this.prisma.pendingUpload.findMany({
        where: { tenantId, status: { in: ['UPLOADED', 'PROCESSING', 'ERROR'] } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return { documents, pending };
  }

  async get(tenantId: number, id: number) {
    const doc = await this.prisma.document.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: { processedData: true, corrections: true },
    });
    if (!doc) throw new NotFoundException('Documentul nu a fost găsit');
    return doc;
  }

  async downloadUrl(tenantId: number, id: number) {
    const doc = await this.get(tenantId, id);
    return { url: await this.s3.presignedGetUrl(doc.s3Key) };
  }

  async softDelete(tenantId: number, id: number, userId: number) {
    await this.get(tenantId, id);
    await this.prisma.document.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.log({ tenantId, userId, action: 'document.deleted', entity: 'Document', entityId: id });
    return { ok: true };
  }

  /**
   * Review UI: user corrects an extracted field. The correction is persisted
   * (correction-learning flywheel) and the extracted data is patched.
   */
  async correctField(tenantId: number, userId: number, documentId: number, field: string, newValue: string) {
    const doc = await this.get(tenantId, documentId);
    const processed = doc.processedData;
    if (!processed) throw new BadRequestException('Documentul nu are date extrase');

    const fields = (processed.extractedFields ?? {}) as Record<string, unknown>;
    const oldValue = fields[field] != null ? String(fields[field]) : null;
    fields[field] = newValue;

    await this.prisma.$transaction([
      this.prisma.userCorrection.create({
        data: { documentId, tenantId, userId, field, oldValue, newValue },
      }),
      this.prisma.processedData.update({
        where: { documentId },
        data: { extractedFields: fields as any },
      }),
    ]);
    return { ok: true, fields };
  }

  async markReviewed(tenantId: number, id: number) {
    await this.get(tenantId, id);
    return this.prisma.document.update({ where: { id }, data: { needsReview: false } });
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[^\w.\-]+/g, '_').slice(0, 120);
}
