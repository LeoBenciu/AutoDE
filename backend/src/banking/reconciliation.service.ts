import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

const DATE_WINDOW_DAYS = 90;

export interface MatchSuggestion {
  payableId: number;
  payeeName: string;
  amount: number;
  currency: string;
  confidence: number;
  reasons: string[];
}

/**
 * Confidence-scored suggestion engine matching bank transactions to payables:
 * amount match + due-date proximity (±90d) + reference/payee text overlap.
 * Returns the top 3; the user confirms (no silent auto-accept by default).
 */
@Injectable()
export class ReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  async suggest(tenantId: number, transactionId: number): Promise<MatchSuggestion[]> {
    const txn = await this.prisma.bankTransaction.findFirst({
      where: { id: transactionId, bankAccount: { tenantId } },
    });
    if (!txn) throw new NotFoundException('Tranzacția nu a fost găsită');

    const candidates = await this.prisma.payable.findMany({
      where: { tenantId, status: { in: ['APPROVED', 'SUBMITTED', 'EXECUTED'] } },
    });

    const txnAmount = Math.abs(Number(txn.amount));
    const txnText = `${txn.description ?? ''} ${txn.reference ?? ''} ${txn.counterparty ?? ''}`.toLowerCase();

    const scored = candidates.map((p) => {
      const reasons: string[] = [];
      let score = 0;

      const amount = Number(p.amount);
      if (Math.abs(amount - txnAmount) < 0.01) {
        score += 0.5;
        reasons.push('sumă identică');
      } else if (txnAmount > 0 && Math.abs(amount - txnAmount) / txnAmount < 0.02) {
        score += 0.3;
        reasons.push('sumă apropiată (±2%)');
      }

      if (p.dueDate) {
        const days = Math.abs(txn.bookingDate.getTime() - p.dueDate.getTime()) / (24 * 3600 * 1000);
        if (days <= DATE_WINDOW_DAYS) {
          const dateScore = 0.2 * (1 - days / DATE_WINDOW_DAYS);
          score += dateScore;
          if (dateScore > 0.1) reasons.push('dată apropiată de scadență');
        }
      }

      const ref = (p.reference ?? '').toLowerCase();
      const payee = p.payeeName.toLowerCase();
      if (ref && txnText.includes(ref)) {
        score += 0.3;
        reasons.push('referință regăsită în descriere');
      }
      if (payee && txnText.includes(payee.split(' ')[0])) {
        score += 0.15;
        reasons.push('beneficiar similar');
      }

      return {
        payableId: p.id,
        payeeName: p.payeeName,
        amount,
        currency: p.currency,
        confidence: Math.min(1, Number(score.toFixed(2))),
        reasons,
      };
    });

    return scored
      .filter((s) => s.confidence > 0.2)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);
  }

  async confirmMatch(tenantId: number, transactionId: number, payableId: number) {
    const txn = await this.prisma.bankTransaction.findFirst({
      where: { id: transactionId, bankAccount: { tenantId } },
    });
    if (!txn) throw new NotFoundException('Tranzacția nu a fost găsită');
    const payable = await this.prisma.payable.findFirst({ where: { id: payableId, tenantId } });
    if (!payable) throw new NotFoundException('Plata nu a fost găsită');

    await this.prisma.$transaction([
      this.prisma.bankTransaction.update({
        where: { id: transactionId },
        data: { matchedPayableId: payableId },
      }),
      this.prisma.payable.update({
        where: { id: payableId },
        data: { status: 'EXECUTED', executedAt: txn.bookingDate },
      }),
    ]);
    return { ok: true };
  }
}
