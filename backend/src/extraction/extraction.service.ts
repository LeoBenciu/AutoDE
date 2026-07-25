import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export interface Phase0Result {
  document_type: string;
  direction?: 'incoming' | 'outgoing' | null;
  confidence: number;
  aviz?: boolean;
  document_hash?: string;
  _needs_type_review?: boolean;
}

export interface ValidationCheck {
  field: string;
  rule?: string;
  passed: boolean;
  detail?: string;
}

export interface ExtractionResult {
  ok: boolean;
  error?: string;
  document_type?: string;
  type_confidence?: number;
  fields?: Record<string, unknown>;
  field_confidence?: Record<string, number>;
  validation_issues?: Array<{ field: string; issue: string }>;
  needs_review?: boolean;
}

export interface SegmentationResult {
  singleDocument: boolean;
  fallbackReason?: string | null;
  totalPages: number;
  segments: Array<{
    startPage: number;
    endPage: number;
    docTypeHint: string;
    confidence: number;
    filePath?: string | null;
  }>;
}

interface FinovaContext {
  tenantId: number;
  tenantCui?: string | null;
  existingDocuments?: unknown[];
  corrections?: unknown[];
}

/**
 * Adapter for Finova's production Python extraction engine.
 *
 * Finova intentionally runs phase 0 and phase 1 in separate subprocesses. That
 * keeps classification cheap, gives the durable queue a resumable phase
 * boundary, and lets bank statements use a longer phase-1 timeout.
 */
@Injectable()
export class ExtractionService {
  private readonly logger = new Logger(ExtractionService.name);
  private readonly workerDir: string;
  private readonly pythonScript: string;
  private readonly pythonBin: string;
  private readonly phase0Concurrency: number;
  private readonly phase1Concurrency: number;
  private readonly phase0TimeoutMs: number;
  private readonly phase1TimeoutMs: number;
  private readonly bankTimeoutMs: number;
  private readonly running = new Map<number, number>([
    [0, 0],
    [1, 0],
  ]);
  private readonly waiters = new Map<number, Array<() => void>>([
    [0, []],
    [1, []],
  ]);

  constructor(private readonly config: ConfigService) {
    this.workerDir = path.resolve(process.cwd(), this.config.get('WORKER_DIR', '../worker'));
    this.pythonScript = path.join(this.workerDir, 'finova', 'main.py');
    this.pythonBin = this.config.get('PYTHON_BIN', 'python3');
    this.phase0Concurrency = positiveInt(this.config.get('FINOVA_MAX_CONCURRENT_PHASE0'), 3);
    this.phase1Concurrency = positiveInt(
      this.config.get('FINOVA_MAX_CONCURRENT_PHASE1') ?? this.config.get('EXTRACTION_CONCURRENCY'),
      2,
    );
    this.phase0TimeoutMs = positiveInt(this.config.get('DATA_EXTRACTION_PYTHON_TIMEOUT_MS'), 180_000);
    this.phase1TimeoutMs = this.phase0TimeoutMs;
    this.bankTimeoutMs = positiveInt(this.config.get('DATA_EXTRACTION_BANK_PYTHON_TIMEOUT_MS'), 480_000);
  }

  async categorize(filePath: string, context: FinovaContext): Promise<Phase0Result> {
    await this.acquire(0);
    try {
      const raw = await this.runPhase(filePath, 0, context);
      const data = unwrapData(raw);
      if (!data.document_type) throw new Error('Finova phase 0 returned no document_type');
      return {
        document_type: String(data.document_type),
        direction: (data.direction as Phase0Result['direction']) ?? null,
        confidence: finiteNumber(data.confidence, 0),
        aviz: data.aviz === true,
        document_hash: stringOrUndefined(data.document_hash),
        _needs_type_review: data._needs_type_review === true,
      };
    } finally {
      this.release(0);
    }
  }

  async extract(
    filePath: string,
    phase0: Phase0Result,
    context: FinovaContext,
  ): Promise<ExtractionResult> {
    await this.acquire(1);
    try {
      const raw = await this.runPhase(filePath, 1, context, phase0);
      const fields = unwrapData(raw);
      const docType = String(fields.document_type ?? phase0.document_type);
      const confidence = objectOfNumbers(fields._confidence);
      const checks = validationChecks(fields);
      const issues = checks
        .filter((check) => check.passed === false)
        .map((check) => ({
          field: String(check.field || 'document'),
          issue: String(check.detail || check.rule || 'Verificare eșuată'),
        }));
      const lowConfidence = Object.values(confidence).some((value) => value < 0.7);
      const invoiceMissingLines =
        docType === 'Invoice' &&
        (!Array.isArray(fields.line_items) || fields.line_items.length === 0);
      const retryRequested = fields._requires_retry === true || invoiceMissingLines;

      if (retryRequested) {
        return {
          ok: false,
          error: String(
            fields._retry_reason ??
              (invoiceMissingLines ? 'Factura nu conține linii extrase' : 'Finova a solicitat reîncercarea'),
          ),
        };
      }

      return {
        ok: true,
        document_type: docType,
        type_confidence: phase0.confidence,
        fields,
        field_confidence: confidence,
        validation_issues: issues,
        needs_review:
          phase0.confidence < 0.7 ||
          phase0._needs_type_review === true ||
          fields._needs_type_review === true ||
          fields._balance_reconciled === false ||
          issues.length > 0 ||
          lowConfidence,
      };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    } finally {
      this.release(1);
    }
  }

  /**
   * Finova's segmentation pass is fail-open. Infrastructure or model failures
   * produce a single-document result and never block the normal pipeline.
   */
  async segment(filePath: string): Promise<SegmentationResult> {
    const encodedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autoimport-segment-'));
    const encodedFile = path.join(encodedDir, 'document.base64');
    try {
      const file = await fs.readFile(filePath);
      await fs.writeFile(encodedFile, file.toString('base64'), 'utf8');
      const raw = await this.spawnJson(
        ['segment', encodedFile],
        positiveInt(this.config.get('FINOVA_SEGMENT_TIMEOUT_MS'), 120_000),
      );
      const data = unwrapData(raw);
      const segments = Array.isArray(data.segments) ? data.segments : [];
      return {
        singleDocument: data.single_document !== false,
        fallbackReason: stringOrNull(data.fallback_reason),
        totalPages: positiveInt(data.total_pages, 1),
        segments: segments.map((segment: any) => ({
          startPage: positiveInt(segment.start_page, 1),
          endPage: positiveInt(segment.end_page, 1),
          docTypeHint: String(segment.doc_type_hint ?? 'Unknown'),
          confidence: finiteNumber(segment.confidence, 0),
          filePath: stringOrNull(segment.file_path),
        })),
      };
    } catch (error) {
      this.logger.warn(`segmentation failed open: ${(error as Error).message}`);
      return {
        singleDocument: true,
        fallbackReason: `adapter:${(error as Error).name}`,
        totalPages: 1,
        segments: [],
      };
    } finally {
      await fs.rm(encodedDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async runPhase(
    filePath: string,
    phase: 0 | 1,
    context: FinovaContext,
    phase0?: Phase0Result,
  ): Promise<Record<string, unknown>> {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), `autoimport-finova-p${phase}-`));
    const token = randomBytes(6).toString('hex');
    const base64File = path.join(runDir, `${token}.base64`);
    const existingFile = path.join(runDir, 'existing-documents.json');
    const correctionsFile = path.join(runDir, 'user-corrections.json');
    const articlesFile = path.join(runDir, 'existing-articles.json');

    try {
      const file = await fs.readFile(filePath);
      await Promise.all([
        fs.writeFile(base64File, file.toString('base64'), 'utf8'),
        fs.writeFile(existingFile, JSON.stringify(context.existingDocuments ?? []), 'utf8'),
        fs.writeFile(correctionsFile, JSON.stringify(context.corrections ?? []), 'utf8'),
        fs.writeFile(articlesFile, '{}', 'utf8'),
      ]);

      const args = [
        context.tenantCui?.trim() || `AUTOIMPORT-${context.tenantId}`,
        base64File,
        existingFile,
        correctionsFile,
        articlesFile,
        String(phase),
        String(context.tenantId),
        'false',
      ];
      if (phase === 1 && phase0) args.push(JSON.stringify(phase0));

      const timeout =
        phase === 1 && phase0?.document_type === 'Bank Statement'
          ? this.bankTimeoutMs
          : phase === 0
            ? this.phase0TimeoutMs
            : this.phase1TimeoutMs;
      return await this.spawnJson(args, timeout);
    } finally {
      await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private spawnJson(args: string[], timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.pythonBin, ['-u', this.pythonScript, ...args], {
        cwd: path.dirname(this.pythonScript),
        env: {
          ...process.env,
          FINOVA_USE_DIRECT_EXTRACTION: 'true',
          FINOVA_VISION_EXTRACTION: process.env.FINOVA_VISION_EXTRACTION ?? 'true',
          FINOVA_TEXTRACT_ANALYZE: process.env.FINOVA_TEXTRACT_ANALYZE ?? 'true',
          FINOVA_BANK_CHUNKING: process.env.FINOVA_BANK_CHUNKING ?? 'true',
          FINOVA_REPAIR_SCOPED: process.env.FINOVA_REPAIR_SCOPED ?? 'true',
          FINOVA_VISION_MAX_DIM: process.env.FINOVA_VISION_MAX_DIM ?? '2200',
          FINOVA_EXTRACTION_LLM_MODEL:
            process.env.FINOVA_EXTRACTION_LLM_MODEL ??
            this.config.get('EXTRACTION_MODEL', 'gpt-4o-mini-2024-07-18'),
          PYTHONPATH: path.dirname(this.pythonScript),
          PYTHONUNBUFFERED: '1',
          MALLOC_ARENA_MAX: '2',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
        finish(() => reject(new Error(`Finova extraction timed out after ${timeoutMs}ms`)));
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        if (bufferSize(stdout) < 50 * 1024 * 1024) stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr.push(chunk);
        while (bufferSize(stderr) > 1024 * 1024) stderr.shift();
      });
      child.on('error', (error) => finish(() => reject(new Error(`Finova worker spawn failed: ${error.message}`))));
      child.on('close', (code) => {
        finish(() => {
          const out = Buffer.concat(stdout).toString('utf8').trim();
          const err = Buffer.concat(stderr).toString('utf8').trim();
          const lastLine = out
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .at(-1);
          if (!lastLine) {
            reject(new Error(`Finova worker exited ${code} without JSON${err ? `: ${err.slice(-800)}` : ''}`));
            return;
          }
          let parsed: any;
          try {
            parsed = JSON.parse(lastLine);
          } catch {
            reject(new Error(`Finova worker returned invalid JSON (exit ${code}): ${err.slice(-800)}`));
            return;
          }
          if (code !== 0 || parsed?.error) {
            reject(new Error(String(parsed?.error ?? `Finova worker exited with code ${code}`)));
            return;
          }
          if (err) this.logger.debug(err.slice(-4_000));
          resolve(parsed as Record<string, unknown>);
        });
      });
    });
  }

  private acquire(phase: 0 | 1): Promise<void> {
    const max = phase === 0 ? this.phase0Concurrency : this.phase1Concurrency;
    const count = this.running.get(phase) ?? 0;
    if (count < max) {
      this.running.set(phase, count + 1);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.get(phase)!.push(() => {
        this.running.set(phase, (this.running.get(phase) ?? 0) + 1);
        resolve();
      });
    });
  }

  private release(phase: 0 | 1) {
    this.running.set(phase, Math.max(0, (this.running.get(phase) ?? 1) - 1));
    this.waiters.get(phase)?.shift()?.();
  }
}

function unwrapData(value: Record<string, unknown>): Record<string, any> {
  const nested = value.data;
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? (nested as Record<string, any>)
    : (value as Record<string, any>);
}

function validationChecks(fields: Record<string, any>): ValidationCheck[] {
  const checks = fields?._validation?.checks;
  return Array.isArray(checks) ? checks : [];
}

function objectOfNumbers(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, raw]) => [key, Number(raw)] as const)
      .filter(([, number]) => Number.isFinite(number)),
  );
}

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function bufferSize(chunks: Buffer[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.length, 0);
}
