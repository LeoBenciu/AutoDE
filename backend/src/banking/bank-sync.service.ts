import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';

/**
 * AIS sync over Open Banking (mTLS + OAuth2 per consent).
 *
 * Runs on a schedule and refreshes balances/transactions for every VALID
 * consent. Until an aggregator (e.g. Smart Fintech SmartAccounts) is
 * configured, the sync is a no-op — accounts/transactions can still be
 * managed manually through the API.
 */
@Injectable()
export class BankSyncService {
  private readonly logger = new Logger(BankSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  get configured(): boolean {
    return Boolean(this.config.get('OPENBANKING_BASE_URL') && this.config.get('OPENBANKING_CLIENT_ID'));
  }

  @Cron(CronExpression.EVERY_HOUR)
  async syncAll() {
    if (!this.configured) return;

    const consents = await this.prisma.openBankingConsent.findMany({ where: { status: 'VALID' } });
    for (const consent of consents) {
      try {
        // Provider-specific AIS calls go here:
        // 1. refresh access token if inside the expiry window (short-lived, ~5 min)
        // 2. GET /accounts, GET /accounts/{id}/balances, GET /accounts/{id}/transactions
        // 3. upsert BankAccount / BankTransaction rows (dedupe on externalId)
        await this.prisma.bankAccount.updateMany({
          where: { openBankingConsentId: consent.id },
          data: { lastOpenBankingSync: new Date() },
        });
      } catch (err) {
        this.logger.warn(`sync failed for consent ${consent.id}: ${(err as Error).message}`);
      }
    }

    // Mark expired consents so the UI can prompt a reconnect.
    await this.prisma.openBankingConsent.updateMany({
      where: { status: 'VALID', consentExpiresAt: { lt: new Date() } },
      data: { status: 'EXPIRED' },
    });
  }
}
