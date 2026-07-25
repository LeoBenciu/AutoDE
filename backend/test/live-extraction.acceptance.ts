import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma.service';
import { S3Service } from '../src/common/s3.service';
import { DocumentsService } from '../src/documents/documents.service';
import { DocumentsProcessor } from '../src/documents/documents.processor';
import { cleanupTenant } from './test-helpers';

const fixturePath = process.env.LIVE_EXTRACTION_FILE;

if (!fixturePath) {
  console.log(
    'Live extraction acceptance skipped. Set LIVE_EXTRACTION_FILE and the required LLM/OCR credentials to run it.',
  );
  process.exit(0);
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const prisma = app.get(PrismaService);
  const s3 = app.get(S3Service);
  const documents = app.get(DocumentsService);
  const processor = app.get(DocumentsProcessor);
  const marker = `live-extraction-${Date.now()}`;
  const tenant = await prisma.tenant.create({
    data: {
      name: marker,
      cui: process.env.LIVE_EXTRACTION_TENANT_CUI ?? '50675950',
      accountingCutoverAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  });

  try {
    const buffer = await readFile(fixturePath!);
    const extension = extname(fixturePath!).toLowerCase();
    const contentType =
      extension === '.pdf'
        ? 'application/pdf'
        : extension === '.png'
          ? 'image/png'
          : 'image/jpeg';
    const upload = await documents.upload(tenant.id, {
      originalname: basename(fixturePath!),
      mimetype: contentType,
      size: buffer.length,
      buffer,
    });

    await processor.tick();
    const pending = await prisma.pendingUpload.findUnique({
      where: { id: upload.pendingUploadId },
    });
    assert.equal(
      pending?.status,
      'COMPLETED',
      `Extraction did not complete: ${pending?.status} ${pending?.errorMessage ?? ''}`,
    );
    assert.ok(pending.documentId, 'Extraction did not create a Document');
    const document = await prisma.document.findFirst({
      where: { id: pending.documentId!, tenantId: tenant.id },
      include: { processedData: true },
    });
    assert.ok(document?.processedData, 'ProcessedData is missing');
    assert.ok(document.type, 'Document classification is missing');
    assert.ok(
      Object.keys(
        (document.processedData!.extractedFields ?? {}) as Record<
          string,
          unknown
        >,
      ).length > 0,
      'Typed extraction fields are empty',
    );
    assert.equal(document.reviewStatus, 'PENDING_APPROVAL');
    console.log(
      `Live extraction passed: ${document.name} → ${document.type}, document ${document.id}.`,
    );
  } finally {
    await cleanupTenant(prisma, tenant.id, s3);
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
