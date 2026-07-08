import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import * as path from 'path';

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

/**
 * Spawns the Python extraction worker per document, with a bounded concurrency
 * lane so batch uploads can't OOM the box (each worker renders PDF pages).
 */
@Injectable()
export class ExtractionService {
  private readonly logger = new Logger(ExtractionService.name);
  private readonly workerDir: string;
  private readonly pythonBin: string;
  private readonly maxConcurrency: number;
  private running = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly config: ConfigService) {
    this.workerDir = path.resolve(process.cwd(), this.config.get('WORKER_DIR', '../worker'));
    this.pythonBin = this.config.get('PYTHON_BIN', 'python3');
    this.maxConcurrency = Number(this.config.get('EXTRACTION_CONCURRENCY', 2));
  }

  async extract(filePath: string, contentType: string, correctionsContext?: string): Promise<ExtractionResult> {
    await this.acquire();
    try {
      return await this.runWorker(['extract', filePath, '--content-type', contentType], correctionsContext);
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.maxConcurrency) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) =>
      this.waiters.push(() => {
        this.running += 1;
        resolve();
      }),
    );
  }

  private release() {
    this.running -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  private runWorker(args: string[], stdinPayload?: string): Promise<ExtractionResult> {
    return new Promise((resolve) => {
      const child = spawn(this.pythonBin, [path.join(this.workerDir, 'main.py'), ...args], {
        cwd: this.workerDir,
        env: {
          ...process.env,
          EXTRACTION_MODEL: this.config.get('EXTRACTION_MODEL', 'claude-opus-4-8'),
        },
        timeout: 5 * 60 * 1000,
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));

      if (stdinPayload) child.stdin.write(stdinPayload);
      child.stdin.end();

      child.on('error', (err) => {
        resolve({ ok: false, error: `worker spawn failed: ${err.message}` });
      });

      child.on('close', (code) => {
        // The worker prints exactly one JSON object as its last stdout line.
        const lines = stdout.trim().split('\n');
        const last = lines[lines.length - 1] ?? '';
        try {
          const parsed = JSON.parse(last);
          resolve(parsed as ExtractionResult);
        } catch {
          this.logger.error(`worker exited ${code}; stderr: ${stderr.slice(0, 2000)}`);
          resolve({
            ok: false,
            error: `worker exited with code ${code}: ${stderr.slice(0, 500) || 'no JSON output'}`,
          });
        }
      });
    });
  }
}
