import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PrismaService } from '../common/prisma.service';
import { S3Service } from '../common/s3.service';
import {
  ExtractionResult,
  ExtractionService,
  Phase0Result,
} from '../extraction/extraction.service';
import { DocumentDomainSyncService } from './document-domain-sync.service';
import {
  applyVehiclePurchaseInvoiceDefaults,
  resolveVehicleFromDocument,
} from '../vehicles/vehicle-document-sync';

const STUCK_PROCESSING_MINUTES = 10;
const CLAIM_BATCH_SIZE = 5;

/**
 * Finova-compatible durable document-processing state machine:
 *
 * QUEUED → PROCESSING → PHASE0_COMPLETE → PROCESSING
 *        → PHASE1_COMPLETE → COMPLETED
 *        ↘ ERROR (backoff/retry) | CANCELLED
 *
 * A multi-document PDF may instead become a SPLIT parent whose child rows run
 * through the same state machine. Claims and phase transitions use compare and
 * set updates, so duplicate cron ticks cannot process the same row.
 */
@Injectable()
export class DocumentsProcessor {
  private readonly logger = new Logger(DocumentsProcessor.name);
  private ticking = false;
  private readonly splitEnabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly extraction: ExtractionService,
    private readonly domainSync: DocumentDomainSyncService,
    config: ConfigService,
  ) {
    this.splitEnabled = config.get('PENDING_UPLOAD_SPLIT_ENABLED', 'false') === 'true';
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.recoverStuck();
      await this.requeueRetryableErrors();
      const candidates = await this.prisma.pendingUpload.findMany({
        where: { status: { in: ['QUEUED', 'UPLOADED'] } },
        orderBy: { createdAt: 'asc' },
        take: CLAIM_BATCH_SIZE,
        select: { id: true },
      });
      await Promise.all(candidates.map(({ id }) => this.processOne(id)));
    } catch (error) {
      this.logger.error(`document queue tick failed: ${(error as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async recoverStuck() {
    const cutoff = new Date(Date.now() - STUCK_PROCESSING_MINUTES * 60_000);
    const stuck = await this.prisma.pendingUpload.findMany({
      where: { status: 'PROCESSING', processingStartedAt: { lt: cutoff } },
      select: { id: true, retryCount: true, maxRetries: true },
    });
    for (const row of stuck) {
      const retryCount = row.retryCount + 1;
      await this.prisma.pendingUpload.updateMany({
        where: {
          id: row.id,
          status: 'PROCESSING',
          processingStartedAt: { lt: cutoff },
        },
        data: {
          status: retryCount >= row.maxRetries ? 'ERROR' : 'QUEUED',
          retryCount,
          processingStartedAt: null,
          lastAttemptAt: new Date(),
          errorMessage:
            retryCount >= row.maxRetries
              ? 'Procesare blocată — numărul maxim de reîncercări a fost atins'
              : 'Procesarea a fost reluată după o întrerupere',
        },
      });
    }
  }

  private async requeueRetryableErrors() {
    const rows = await this.prisma.pendingUpload.findMany({
      where: { status: 'ERROR' },
      select: { id: true, retryCount: true, maxRetries: true, lastAttemptAt: true },
      take: 50,
    });
    const now = Date.now();
    for (const row of rows) {
      if (row.retryCount >= row.maxRetries) continue;
      const backoffMs = 5_000 * 2 ** Math.max(0, row.retryCount - 1);
      if (now - (row.lastAttemptAt?.getTime() ?? 0) < backoffMs) continue;
      await this.prisma.pendingUpload.updateMany({
        where: { id: row.id, status: 'ERROR', retryCount: row.retryCount },
        data: { status: 'QUEUED', processingStartedAt: null },
      });
    }
  }

  private async processOne(id: number) {
    const claimed = await this.prisma.pendingUpload.updateMany({
      where: { id, status: { in: ['QUEUED', 'UPLOADED'] } },
      data: {
        status: 'PROCESSING',
        processingStartedAt: new Date(),
        lastAttemptAt: new Date(),
        errorMessage: null,
      },
    });
    if (claimed.count === 0) return;

    const row = await this.prisma.pendingUpload.findUnique({ where: { id } });
    if (!row) return;

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autoimport-document-'));
    const tmpFile = path.join(tmpDir, sanitizeName(row.fileName) || 'document');
    try {
      const buffer = await this.s3.getObjectBuffer(row.s3Key);
      await fs.writeFile(tmpFile, buffer);

      if (await this.trySplit(row, tmpFile)) return;

      const context = await this.buildExtractionContext(row.tenantId);
      let phase0 = jsonObject(row.phase0Data) as unknown as Phase0Result | undefined;

      if (!phase0?.document_type) {
        const startedAt = new Date();
        await this.prisma.pendingUpload.update({
          where: { id: row.id },
          data: { processingPhase: 0, lastAttemptAt: startedAt },
        });
        phase0 = await this.extraction.categorize(tmpFile, context);
        const completedAt = new Date();
        const phase0Duration = completedAt.getTime() - startedAt.getTime();
        const phase0Saved = await this.prisma.pendingUpload.updateMany({
          where: { id: row.id, status: 'PROCESSING', processingPhase: 0 },
          data: {
            status: 'PHASE0_COMPLETE',
            processingPhase: 1,
            phase0Data: phase0 as any,
            errorMessage: null,
          },
        });
        // A user may cancel while the LLM call is in flight. Never resurrect a
        // cancelled queue item by writing a later phase over that terminal state.
        if (phase0Saved.count === 0) return;
        this.logger.log(
          `upload ${row.id} phase 0 complete: ${phase0.document_type} (${phase0Duration}ms)`,
        );
      }

      const phase1Claim = await this.prisma.pendingUpload.updateMany({
        where: { id: row.id, status: { in: ['PROCESSING', 'PHASE0_COMPLETE'] } },
        data: { status: 'PROCESSING', processingPhase: 1, lastAttemptAt: new Date() },
      });
      if (phase1Claim.count === 0) return;

      const phase1StartedAt = new Date();
      let result = jsonObject(row.phase1Data) as unknown as ExtractionResult | undefined;
      if (!result?.ok) {
        result = await this.extraction.extract(tmpFile, phase0, context);
      }
      if (!result.ok) {
        await this.failOrRetry(
          row.id,
          row.retryCount,
          row.maxRetries,
          result.error ?? 'Extracția Finova a eșuat',
          1,
        );
        return;
      }

      const phase1CompletedAt = new Date();
      const phase1Saved = await this.prisma.pendingUpload.updateMany({
        where: { id: row.id, status: 'PROCESSING', processingPhase: 1 },
        data: {
          status: 'PHASE1_COMPLETE',
          processingPhase: 1,
          phase1Data: result as any,
          errorMessage: null,
        },
      });
      if (phase1Saved.count === 0) return;

      const fields = result.fields ?? {};
      if (result.document_type === 'Invoice') {
        const managements = await this.prisma.management.findMany({
          where: { tenantId: row.tenantId },
          select: { code: true, name: true },
        });
        if (
          applyVehiclePurchaseInvoiceDefaults(fields, managements, context.tenantCui)
        ) {
          this.logger.log(
            `upload ${row.id}: pre-filled vehicle purchase line description/management`,
          );
        }
      }
      const inferredVehicleId = await resolveVehicleFromDocument(
        this.prisma,
        row.tenantId,
        result.document_type,
        fields,
        row.vehicleId,
      );
      let document = await this.prisma.document.findFirst({
        where: { tenantId: row.tenantId, s3Key: row.s3Key, deletedAt: null },
        select: { id: true, vehicleId: true },
      });
      if (!document) {
        document = await this.prisma.document.create({
          data: {
            name: row.fileName,
            type: result.document_type,
            s3Key: row.s3Key,
            contentType: row.contentType,
            fileSize: row.fileSize,
            documentHash: row.documentHash,
            tenantId: row.tenantId,
            vehicleId: inferredVehicleId ?? row.vehicleId,
            partyId: row.partyId,
            processingStatus: 'COMPLETED',
            // Contract workflow: every new accounting/document extraction must
            // be explicitly approved before it can feed the journal or SAGA.
            needsReview: true,
            reviewStatus: 'PENDING_APPROVAL',
            postingStatus: 'NONE',
            processingStartedAt: row.processingStartedAt,
            processingCompletedAt: phase1CompletedAt,
            phase0StartedAt: row.processingStartedAt,
            phase0CompletedAt: phase1StartedAt,
            phase0Duration: millisecondsBetween(row.processingStartedAt, phase1StartedAt),
            phase1StartedAt,
            phase1CompletedAt,
            phase1Duration: phase1CompletedAt.getTime() - phase1StartedAt.getTime(),
            processingDuration: millisecondsBetween(row.processingStartedAt, phase1CompletedAt),
            processedData: {
              create: {
                documentType: result.document_type,
                typeConfidence: result.type_confidence,
                extractedFields: fields as any,
                fieldConfidence: (result.field_confidence ?? {}) as any,
                validationIssues: (result.validation_issues ?? []) as any,
              },
            },
          },
          select: { id: true, vehicleId: true },
        });
      } else if (!document.vehicleId && inferredVehicleId) {
        document = await this.prisma.document.update({
          where: { id: document.id },
          data: { vehicleId: inferredVehicleId },
          select: { id: true, vehicleId: true },
        });
      }

      // Extraction is not complete from the business perspective until stable
      // VIN/CUI/CNP facts have been applied to the vehicle and seller catalogues.
      await this.domainSync.sync(document.id);

      await this.prisma.pendingUpload.updateMany({
        where: { id: row.id, status: 'PHASE1_COMPLETE' },
        data: {
          status: 'COMPLETED',
          documentId: document.id,
          phase1Data: result as any,
          errorMessage: null,
          processingStartedAt: null,
        },
      });
      this.logger.log(
        `processed upload ${row.id} -> document ${document.id} (${result.document_type})`,
      );
    } catch (error) {
      await this.failOrRetry(
        row.id,
        row.retryCount,
        row.maxRetries,
        (error as Error).message,
        row.processingPhase,
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async trySplit(row: any, filePath: string): Promise<boolean> {
    if (
      !this.splitEnabled ||
      row.parentUploadId != null ||
      row.processingPhase !== 0 ||
      row.phase0Data != null ||
      !isPdf(row.contentType, row.fileName)
    ) {
      return false;
    }

    const split = await this.extraction.segment(filePath);
    if (split.singleDocument || split.segments.length < 2) return false;

    const stillProcessing = await this.prisma.pendingUpload.count({
      where: { id: row.id, status: 'PROCESSING' },
    });
    if (stillProcessing === 0) return true;

    const total = split.segments.length;
    for (let index = 0; index < total; index += 1) {
      const segment = split.segments[index];
      if (!segment.filePath) throw new Error(`Segmentul ${index + 1} nu are fișier`);
      const existing = await this.prisma.pendingUpload.findFirst({
        where: { parentUploadId: row.id, segmentIndex: index + 1 },
        select: { id: true },
      });
      if (existing) continue;

      const child = await fs.readFile(segment.filePath);
      await fs.rm(segment.filePath, { force: true }).catch(() => undefined);
      const childName = segmentName(row.fileName, index + 1, total);
      const childKey = `${row.s3Key}.segments/${index + 1}-${sanitizeName(childName)}`;
      await this.s3.putObject(childKey, child, 'application/pdf');
      await this.prisma.pendingUpload.create({
        data: {
          s3Key: childKey,
          fileName: childName,
          contentType: 'application/pdf',
          fileSize: child.length,
          documentHash: createHash('sha256').update(child).digest('hex'),
          tenantId: row.tenantId,
          vehicleId: row.vehicleId,
          partyId: row.partyId,
          status: 'QUEUED',
          processingPhase: 0,
          parentUploadId: row.id,
          pageStart: segment.startPage,
          pageEnd: segment.endPage,
          segmentIndex: index + 1,
          segmentCount: total,
        },
      });
    }

    const splitSaved = await this.prisma.pendingUpload.updateMany({
      where: { id: row.id, status: 'PROCESSING' },
      data: {
        status: 'SPLIT',
        processingStartedAt: null,
        phase0Data: {
          split: {
            totalPages: split.totalPages,
            segments: split.segments.map(({ filePath: _filePath, ...segment }) => segment),
          },
        } as any,
      },
    });
    if (splitSaved.count === 0) return true;
    this.logger.log(`split upload ${row.id}: ${split.totalPages} pages -> ${total} child documents`);
    return true;
  }

  private async buildExtractionContext(tenantId: number) {
    const [tenant, documents, corrections] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { cui: true } }),
      this.prisma.document.findMany({
        where: { tenantId, deletedAt: null, processedData: { isNot: null } },
        include: { processedData: true },
        orderBy: { uploadedAt: 'desc' },
        take: 50,
      }),
      this.prisma.userCorrection.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { field: true, oldValue: true, newValue: true },
      }),
    ]);
    return {
      tenantId,
      tenantCui: tenant?.cui,
      existingDocuments: documents.map((document) => ({
        id: document.id,
        document_type: document.type,
        ...(jsonObject(document.processedData?.extractedFields) ?? {}),
      })),
      corrections: corrections.map((correction) => ({
        correctionType:
          correction.field === 'line_items'
            ? 'LINE_ITEMS'
            : correction.field === 'document_type'
              ? 'DOCUMENT_TYPE'
              : 'FIELD_VALUE',
        field: correction.field,
        originalValue:
          correction.field === 'line_items'
            ? { line_items: parseCorrectionValue(correction.oldValue) }
            : { [correction.field]: correction.oldValue },
        correctedValue:
          correction.field === 'line_items'
            ? { line_items: parseCorrectionValue(correction.newValue) }
            : { [correction.field]: correction.newValue },
      })),
    };
  }

  private async failOrRetry(
    id: number,
    retryCount: number,
    maxRetries: number,
    message: string,
    phase: number,
  ) {
    const nextRetry = retryCount + 1;
    const failed = await this.prisma.pendingUpload.updateMany({
      where: {
        id,
        status: { notIn: ['CANCELLED', 'COMPLETED', 'SPLIT'] },
      },
      data: {
        status: 'ERROR',
        processingPhase: phase,
        retryCount: nextRetry,
        processingStartedAt: null,
        lastAttemptAt: new Date(),
        errorMessage: message.slice(0, 1_000),
      },
    });
    if (failed.count === 0) return;
    this.logger.warn(
      `upload ${id} failed in phase ${phase} (${nextRetry}/${maxRetries}): ${message.slice(0, 240)}`,
    );
  }
}

function isPdf(contentType: string, fileName: string): boolean {
  return contentType.toLowerCase().includes('pdf') || fileName.toLowerCase().endsWith('.pdf');
}

function sanitizeName(name: string): string {
  return name.replace(/[^\w.\-]+/g, '_').slice(0, 120);
}

function segmentName(fileName: string, index: number, total: number): string {
  const base = fileName.replace(/\.pdf$/i, '');
  return `${base} · ${index}-${total}.pdf`;
}

function jsonObject(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;
}

function parseCorrectionValue(value: string | null): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function millisecondsBetween(start: Date | null, end: Date): number | undefined {
  return start ? Math.max(0, end.getTime() - start.getTime()) : undefined;
}
