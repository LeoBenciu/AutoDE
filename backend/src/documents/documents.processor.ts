import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PrismaService } from '../common/prisma.service';
import { S3Service } from '../common/s3.service';
import { ExtractionService } from '../extraction/extraction.service';

const STUCK_PROCESSING_MINUTES = 10;

/**
 * Worker over the PendingUpload durable queue.
 *
 * Claims rows via an atomic compare-and-set (updateMany on id+status) so two
 * ticks never grab the same row; a poison-pill cap (maxRetries) stops bad
 * files from looping forever; the recovery sweep re-queues rows stuck in
 * PROCESSING after a crash/restart.
 */
@Injectable()
export class DocumentsProcessor {
  private readonly logger = new Logger(DocumentsProcessor.name);
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly extraction: ExtractionService,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.recoverStuck();
      const candidates = await this.prisma.pendingUpload.findMany({
        where: { status: 'UPLOADED' },
        orderBy: { createdAt: 'asc' },
        take: 5,
      });
      await Promise.all(candidates.map((c) => this.processOne(c.id)));
    } catch (err) {
      this.logger.error(`tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async recoverStuck() {
    const cutoff = new Date(Date.now() - STUCK_PROCESSING_MINUTES * 60 * 1000);
    const stuck = await this.prisma.pendingUpload.findMany({
      where: { status: 'PROCESSING', processingStartedAt: { lt: cutoff } },
    });
    for (const row of stuck) {
      const exhausted = row.retryCount + 1 >= row.maxRetries;
      await this.prisma.pendingUpload.update({
        where: { id: row.id },
        data: {
          status: exhausted ? 'ERROR' : 'UPLOADED',
          retryCount: row.retryCount + 1,
          errorMessage: exhausted ? 'Procesare blocată — număr maxim de reîncercări atins' : 'Reîncercare după blocare',
        },
      });
    }
  }

  private async processOne(id: number) {
    // Atomic claim: only one worker wins the UPLOADED -> PROCESSING transition.
    const claimed = await this.prisma.pendingUpload.updateMany({
      where: { id, status: 'UPLOADED' },
      data: { status: 'PROCESSING', processingStartedAt: new Date() },
    });
    if (claimed.count === 0) return;

    const row = await this.prisma.pendingUpload.findUnique({ where: { id } });
    if (!row) return;

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autoimport-'));
    const tmpFile = path.join(tmpDir, row.fileName.replace(/[^\w.\-]+/g, '_') || 'document');
    try {
      const buffer = await this.s3.getObjectBuffer(row.s3Key);
      await fs.writeFile(tmpFile, buffer);

      const correctionsContext = await this.buildCorrectionsContext(row.tenantId);
      const result = await this.extraction.extract(tmpFile, row.contentType, correctionsContext);

      if (!result.ok) {
        await this.failOrRetry(row.id, row.retryCount, row.maxRetries, result.error ?? 'Extracție eșuată');
        return;
      }

      const document = await this.prisma.document.create({
        data: {
          name: row.fileName,
          type: result.document_type,
          s3Key: row.s3Key,
          contentType: row.contentType,
          fileSize: row.fileSize,
          documentHash: row.documentHash,
          tenantId: row.tenantId,
          vehicleId: row.vehicleId,
          partyId: row.partyId,
          processingStatus: 'COMPLETED',
          needsReview: result.needs_review ?? false,
          processingStartedAt: row.processingStartedAt,
          processingCompletedAt: new Date(),
          processedData: {
            create: {
              documentType: result.document_type,
              typeConfidence: result.type_confidence,
              extractedFields: (result.fields ?? {}) as any,
              fieldConfidence: (result.field_confidence ?? {}) as any,
              validationIssues: (result.validation_issues ?? []) as any,
            },
          },
        },
      });

      await this.prisma.pendingUpload.update({
        where: { id: row.id },
        data: { status: 'COMPLETED', documentId: document.id, errorMessage: null },
      });
      this.logger.log(`processed upload ${row.id} -> document ${document.id} (${result.document_type})`);
    } catch (err) {
      await this.failOrRetry(row.id, row.retryCount, row.maxRetries, (err as Error).message);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async failOrRetry(id: number, retryCount: number, maxRetries: number, message: string) {
    const exhausted = retryCount + 1 >= maxRetries;
    await this.prisma.pendingUpload.update({
      where: { id },
      data: {
        status: exhausted ? 'ERROR' : 'UPLOADED',
        retryCount: retryCount + 1,
        errorMessage: message.slice(0, 1000),
      },
    });
    this.logger.warn(`upload ${id} failed (retry ${retryCount + 1}/${maxRetries}): ${message.slice(0, 200)}`);
  }

  /**
   * RAG-lite over past corrections: recent tenant corrections are passed to
   * the worker as extra context. (pgvector similarity search can replace the
   * recency heuristic without touching the worker contract.)
   */
  private async buildCorrectionsContext(tenantId: number): Promise<string | undefined> {
    const corrections = await this.prisma.userCorrection.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { field: true, oldValue: true, newValue: true },
    });
    if (corrections.length === 0) return undefined;
    return JSON.stringify({ past_corrections: corrections });
  }
}
