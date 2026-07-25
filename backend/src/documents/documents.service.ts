import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { S3Service } from '../common/s3.service';
import { AuditService } from '../common/audit.service';
import { PostingService } from '../accounting/posting.service';

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
    private readonly posting: PostingService,
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

  async list(
    tenantId: number,
    filters: {
      vehicleId?: number;
      partyId?: number;
      type?: string;
      needsReview?: boolean;
      search?: string;
      archived?: boolean;
    },
  ) {
    const where: Prisma.DocumentWhereInput = {
      tenantId,
      deletedAt: null,
      archivedAt: filters.archived ? { not: null } : null,
    };
    if (filters.vehicleId) where.vehicleId = filters.vehicleId;
    if (filters.partyId) where.partyId = filters.partyId;
    if (filters.type) where.type = filters.type;
    if (filters.needsReview !== undefined) where.needsReview = filters.needsReview;
    if (filters.search) {
      const q = filters.search.trim();
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { type: { contains: q, mode: 'insensitive' } },
        { vehicle: { vin: { contains: q, mode: 'insensitive' } } },
        { vehicle: { make: { contains: q, mode: 'insensitive' } } },
        { party: { name: { contains: q, mode: 'insensitive' } } },
      ];
    }
    const [documents, pending] = await Promise.all([
      this.prisma.document.findMany({
        where,
        orderBy: { uploadedAt: 'desc' },
        include: {
          processedData: true,
          vehicle: { select: { id: true, vin: true, make: true, model: true } },
          party: { select: { id: true, name: true } },
        },
      }),
      this.prisma.pendingUpload.findMany({
        where: {
          tenantId,
          status: {
            in: [
              'QUEUED',
              'UPLOADED',
              'PROCESSING',
              'PHASE0_COMPLETE',
              'PHASE1_COMPLETE',
              'ERROR',
              'SPLIT',
            ],
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return { documents, pending };
  }

  async get(tenantId: number, id: number) {
    const doc = await this.prisma.document.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: {
        processedData: true,
        corrections: true,
        ledgerEntries: { orderBy: { id: 'asc' } },
        approvedBy: { select: { id: true, name: true, email: true } },
        parentLinks: {
          include: {
            child: {
              select: {
                id: true,
                name: true,
                type: true,
                processedData: { select: { extractedFields: true } },
              },
            },
          },
        },
        childLinks: {
          include: {
            parent: {
              select: {
                id: true,
                name: true,
                type: true,
                processedData: { select: { extractedFields: true } },
              },
            },
          },
        },
      },
    });
    if (!doc) throw new NotFoundException('Documentul nu a fost găsit');
    return doc;
  }

  async downloadUrl(tenantId: number, id: number) {
    const doc = await this.get(tenantId, id);
    return { url: await this.s3.presignedGetUrl(doc.s3Key) };
  }

  /** Attach the document to a vehicle and/or a client (party). */
  async assign(tenantId: number, id: number, vehicleId?: number | null, partyId?: number | null) {
    await this.get(tenantId, id);
    if (vehicleId) {
      const v = await this.prisma.vehicle.findFirst({ where: { id: vehicleId, tenantId }, select: { id: true } });
      if (!v) throw new NotFoundException('Vehiculul nu a fost găsit');
    }
    if (partyId) {
      const p = await this.prisma.party.findFirst({ where: { id: partyId, tenantId }, select: { id: true } });
      if (!p) throw new NotFoundException('Partenerul nu a fost găsit');
    }
    return this.prisma.document.update({
      where: { id },
      data: {
        vehicleId: vehicleId === undefined ? undefined : vehicleId,
        partyId: partyId === undefined ? undefined : partyId,
      },
    });
  }

  /** Archive is reversible and distinct from delete: the file stays searchable in the archived view. */
  async setArchived(tenantId: number, id: number, userId: number, archived: boolean) {
    await this.getEvenArchived(tenantId, id);
    await this.prisma.document.update({
      where: { id },
      data: { archivedAt: archived ? new Date() : null },
    });
    await this.audit.log({
      tenantId,
      userId,
      action: archived ? 'document.archived' : 'document.unarchived',
      entity: 'Document',
      entityId: id,
    });
    return { ok: true };
  }

  private async getEvenArchived(tenantId: number, id: number) {
    const doc = await this.prisma.document.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!doc) throw new NotFoundException('Documentul nu a fost găsit');
    return doc;
  }

  async softDelete(tenantId: number, id: number, userId: number) {
    const document = await this.get(tenantId, id);
    if (document.reviewStatus === 'APPROVED') {
      throw new BadRequestException(
        'Redeschide documentul înainte de ștergere pentru a elimina nota contabilă',
      );
    }
    await this.prisma.document.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.log({ tenantId, userId, action: 'document.deleted', entity: 'Document', entityId: id });
    return { ok: true };
  }

  /**
   * Review UI: user corrects an extracted field. The correction is persisted
   * (correction-learning flywheel) and the extracted data is patched.
   */
  async correctField(
    tenantId: number,
    userId: number,
    documentId: number,
    field: string,
    newValue: unknown,
  ) {
    const doc = await this.get(tenantId, documentId);
    if (doc.reviewStatus === 'APPROVED') {
      throw new BadRequestException(
        'Documentul este aprobat. Redeschide-l înainte de a modifica datele.',
      );
    }
    const processed = doc.processedData;
    if (!processed) throw new BadRequestException('Documentul nu are date extrase');

    const fields = (processed.extractedFields ?? {}) as Record<string, unknown>;
    const oldRaw = readPath(fields, field);
    const parsedValue = normalizeCorrectionValue(field, newValue);
    const oldValue = oldRaw == null ? null : serializeCorrection(oldRaw);
    writePath(fields, field, parsedValue);
    const fieldConfidence = {
      ...((processed.fieldConfidence ?? {}) as Record<string, unknown>),
      [field]: 1,
    };
    const validationIssues = Array.isArray(processed.validationIssues)
      ? processed.validationIssues.filter(
          (issue: any) => String(issue?.field ?? '') !== field,
        )
      : [];

    // Keep Finova's embedded diagnostic envelope in sync with the normalized
    // ProcessedData columns used by the review UI.
    const embeddedConfidence = fields._confidence;
    if (embeddedConfidence && typeof embeddedConfidence === 'object' && !Array.isArray(embeddedConfidence)) {
      (embeddedConfidence as Record<string, unknown>)[field] = 1;
    }
    const embeddedValidation = fields._validation;
    if (embeddedValidation && typeof embeddedValidation === 'object' && !Array.isArray(embeddedValidation)) {
      const checks = (embeddedValidation as Record<string, unknown>).checks;
      if (Array.isArray(checks)) {
        (embeddedValidation as Record<string, unknown>).checks = checks.filter(
          (check: any) => String(check?.field ?? '') !== field,
        );
      }
    }

    await this.prisma.$transaction([
      this.prisma.userCorrection.create({
        data: {
          documentId,
          tenantId,
          userId,
          field,
          oldValue,
          newValue: serializeCorrection(parsedValue),
        },
      }),
      this.prisma.processedData.update({
        where: { documentId },
        data: {
          extractedFields: fields as any,
          fieldConfidence: fieldConfidence as any,
          validationIssues: validationIssues as any,
        },
      }),
      this.prisma.document.update({
        where: { id: documentId },
        data: {
          needsReview: true,
          reviewStatus:
            doc.reviewStatus === 'LEGACY' ? 'LEGACY' : 'PENDING_APPROVAL',
          postingStatus: 'NONE',
          postingError: null,
        },
      }),
    ]);
    return { ok: true, fields };
  }

  previewPosting(tenantId: number, id: number) {
    return this.posting.preview(tenantId, id);
  }

  approve(tenantId: number, userId: number, id: number) {
    return this.posting.approve(tenantId, userId, id);
  }

  reopen(tenantId: number, userId: number, id: number) {
    return this.posting.reopen(tenantId, userId, id);
  }

  // Compatibility alias for the old UI/API. Review now means approval + posting.
  async markReviewed(tenantId: number, userId: number, id: number) {
    return this.approve(tenantId, userId, id);
  }

  async retryPendingUpload(tenantId: number, id: number) {
    const upload = await this.prisma.pendingUpload.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true },
    });
    if (!upload) throw new NotFoundException('Încărcarea nu a fost găsită');
    if (upload.status !== 'ERROR') {
      throw new BadRequestException(`Încărcarea nu poate fi reluată din starea ${upload.status}`);
    }
    const retried = await this.prisma.pendingUpload.updateMany({
      where: { id, tenantId, status: 'ERROR' },
      data: {
        status: 'QUEUED',
        retryCount: 0,
        processingStartedAt: null,
        lastAttemptAt: null,
        errorMessage: null,
      },
    });
    if (retried.count === 0) {
      throw new BadRequestException('Starea încărcării s-a schimbat; reîmprospătează lista');
    }
    return { ok: true };
  }

  async cancelPendingUpload(tenantId: number, id: number) {
    const cancellable = ['QUEUED', 'UPLOADED', 'PROCESSING', 'PHASE0_COMPLETE'] as const;
    const upload = await this.prisma.pendingUpload.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true },
    });
    if (!upload) throw new NotFoundException('Încărcarea nu a fost găsită');
    if (!(cancellable as readonly string[]).includes(upload.status)) {
      throw new BadRequestException(`Încărcarea nu poate fi anulată din starea ${upload.status}`);
    }
    const cancelled = await this.prisma.pendingUpload.updateMany({
      where: { id, tenantId, status: { in: [...cancellable] } },
      data: { status: 'CANCELLED', processingStartedAt: null },
    });
    if (cancelled.count === 0) {
      throw new BadRequestException('Starea încărcării s-a schimbat; reîmprospătează lista');
    }
    return { ok: true };
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[^\w.\-]+/g, '_').slice(0, 120);
}

function pathParts(path: string): Array<string | number> {
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

function readPath(root: Record<string, unknown>, path: string): unknown {
  let current: any = root;
  for (const part of pathParts(path)) {
    if (current == null) return undefined;
    current = current[part as any];
  }
  return current;
}

function writePath(root: Record<string, unknown>, path: string, value: unknown) {
  const parts = pathParts(path);
  if (parts.length === 0) throw new BadRequestException('Câmp invalid');
  let current: any = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const nextPart = parts[index + 1];
    if (current[part as any] == null) {
      current[part as any] = typeof nextPart === 'number' ? [] : {};
    }
    current = current[part as any];
  }
  current[parts[parts.length - 1] as any] = value;
}

function normalizeCorrectionValue(field: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (
    /(?:amount|price|quantity|rate|total|mileage|exchange)/i.test(field) &&
    trimmed !== ''
  ) {
    const numeric = Number(trimmed.replace(',', '.'));
    if (Number.isFinite(numeric)) return numeric;
  }
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

function serializeCorrection(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
