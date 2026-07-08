import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(params: {
    tenantId: number;
    userId?: number;
    action: string;
    entity: string;
    entityId?: number;
    details?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          tenantId: params.tenantId,
          userId: params.userId,
          action: params.action,
          entity: params.entity,
          entityId: params.entityId,
          details: (params.details as any) ?? undefined,
        },
      });
    } catch (err) {
      // Audit writes must never break the main flow, but the failure is logged.
      this.logger.error(`audit write failed: ${(err as Error).message}`);
    }
  }
}
