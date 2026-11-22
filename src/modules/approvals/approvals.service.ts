import { Injectable } from '@nestjs/common';
import type { ApprovalStatus, Currency, PaymentMethod, Prisma } from '@prisma/client';
import { dec } from '@kpv/domain';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/services/audit.service';
import { HistoryRangeService, MAX_EXPORT_ROWS } from '../../common/services/history-range.service';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type { ApprovalHistoryType, ListApprovalsHistoryDto } from './dto/approvals.dto';

export interface ApprovalHistoryLeg {
  id: string;
  method: PaymentMethod;
  bankAccountId: string | null;
  bankNameLo: string | null;
  currency: Currency;
  amount: string;
  amountLak: string;
  changeLak: string;
}

export interface ApprovalHistoryLine {
  id: string;
  label: string;
  weightG: string;
  quantity: number;
  amountLak: string | null;
}

export interface ApprovalHistoryRecord {
  id: string;
  type: ApprovalHistoryType;
  code: string;
  decision: 'APPROVED' | 'REJECTED' | 'CANCELLED';
  status: ApprovalStatus;
  createdAt: Date;
  approvedAt: Date | null;
  confirmedAt: Date | null;
  settledAt: Date | null;
  rejectReason: string | null;
  customerPhone: string;
  detailSummary: string;
  amountLak: string;
  sellPrice: string | null;
  downPayment: string | null;
  outstanding: string | null;
  createdById: string;
  approvedById: string | null;
  legs: ApprovalHistoryLeg[];
  lines: ApprovalHistoryLine[];
}

function fmtWeight(v: Prisma.Decimal | string | number): string {
  const s = typeof v === 'object' && 'toFixed' in v ? v.toFixed() : String(v);
  return dec(s).toFixed();
}

function normalizeDecision(status: ApprovalStatus): 'APPROVED' | 'REJECTED' | 'CANCELLED' {
  if (status === 'REJECTED') return 'REJECTED';
  if (status === 'CANCELLED') return 'CANCELLED';
  return 'APPROVED';
}

/**
 * Unified Payment Approval History (TOR §4.2).
 *
 * Addresses the 3 gaps of querying /buyback, /exchange, /credit separately:
 *  1. Single endpoint for Buyback, Exchange, and Credit approval history.
 *  2. Filters by `approvedAt` (when Payment reviewed), falling back to `createdAt`
 *     only for legacy rows with `approvedAt = null`, so items created yesterday
 *     and approved today appear on today's history.
 *  3. Normalizes `decision` (`APPROVED` | `REJECTED`) across modules even though
 *     Buyback/Exchange use `APPROVED`/`COMPLETED` and Credit transitions to `COMPLETED`.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly range: HistoryRangeService,
  ) {}

  async history(query: ListApprovalsHistoryDto, user?: AuthenticatedUser) {
    const range = this.range.resolve(query, user);
    const timeWin = this.range.resolveTimeWindow(range, query);
    const window = timeWin ?? HistoryRangeService.window(range);

    const statusFilter = this.resolveStatusFilter(query);
    const dateFilter = {
      OR: [
        { approvedAt: window },
        { approvedAt: null, createdAt: window },
      ],
    };

    const q = query.search?.trim();
    const matchedUserIds = q
      ? (
          await this.prisma.user.findMany({
            where: { fullName: { contains: q, mode: 'insensitive' } },
            select: { id: true },
          })
        ).map((u) => u.id)
      : [];

    const searchClause = q
      ? {
          OR: [
            { code: { contains: q, mode: 'insensitive' as const } },
            { customer: { phone: { contains: q, mode: 'insensitive' as const } } },
            { rejectReason: { contains: q, mode: 'insensitive' as const } },
            ...(matchedUserIds.length > 0
              ? [
                  { createdById: { in: matchedUserIds } },
                  { approvedById: { in: matchedUserIds } },
                ]
              : []),
          ],
        }
      : undefined;

    const fetchTake = range.all ? MAX_EXPORT_ROWS : range.skip + range.take;
    const includeBuyback = !query.type || query.type === 'BUYBACK';
    const includeExchange = !query.type || query.type === 'EXCHANGE';
    const includeCredit = !query.type || query.type === 'CREDIT';

    const [buybackRes, exchangeRes, creditRes] = await Promise.all([
      includeBuyback
        ? this.fetchBuybacks(statusFilter, dateFilter, searchClause, fetchTake)
        : Promise.resolve({ rows: [] as ApprovalHistoryRecord[], total: 0 }),
      includeExchange
        ? this.fetchExchanges(statusFilter, dateFilter, searchClause, fetchTake)
        : Promise.resolve({ rows: [] as ApprovalHistoryRecord[], total: 0 }),
      includeCredit
        ? this.fetchCredits(statusFilter, dateFilter, searchClause, fetchTake)
        : Promise.resolve({ rows: [] as ApprovalHistoryRecord[], total: 0 }),
    ]);

    const merged = [...buybackRes.rows, ...exchangeRes.rows, ...creditRes.rows].sort((a, b) => {
      const ta = (a.approvedAt ?? a.createdAt).getTime();
      const tb = (b.approvedAt ?? b.createdAt).getTime();
      return tb - ta || b.code.localeCompare(a.code);
    });

    const total = buybackRes.total + exchangeRes.total + creditRes.total;
    const sliced = merged.slice(range.skip, range.skip + range.take);
    const withActors = await this.audit.withActorNames(sliced);

    return this.range.page(withActors, total, range);
  }

  private resolveStatusFilter(query: ListApprovalsHistoryDto) {
    if (query.status) {
      if (query.status === 'CANCELLED') {
        return { status: 'CANCELLED' as ApprovalStatus, approvedAt: { not: null } };
      }
      return { status: query.status as ApprovalStatus };
    }
    if (query.decision === 'APPROVED') {
      return { status: { in: ['APPROVED', 'COMPLETED'] as ApprovalStatus[] } };
    }
    if (query.decision === 'REJECTED') {
      return { status: 'REJECTED' as ApprovalStatus };
    }
    return {
      OR: [
        { status: { in: ['APPROVED', 'COMPLETED', 'REJECTED'] as ApprovalStatus[] } },
        { status: 'CANCELLED' as ApprovalStatus, approvedAt: { not: null } },
      ],
    };
  }

  private async fetchBuybacks(
    statusFilter: Prisma.BuybackWhereInput,
    dateFilter: Prisma.BuybackWhereInput,
    searchClause: Prisma.BuybackWhereInput | undefined,
    take: number,
  ): Promise<{ rows: ApprovalHistoryRecord[]; total: number }> {
    const where: Prisma.BuybackWhereInput = {
      deletedAt: null,
      AND: [statusFilter, dateFilter, ...(searchClause ? [searchClause] : [])],
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.buyback.findMany({
        where,
        include: {
          customer: { select: { phone: true } },
          goldType: { select: { nameLo: true } },
          goldItem: { select: { nameLo: true } },
          payments: { include: { bankAccount: { select: { nameLo: true } } } },
          lines: {
            include: {
              goldType: { select: { nameLo: true } },
              goldItem: { select: { nameLo: true } },
            },
            orderBy: { sortOrder: 'asc' },
          },
        },
        orderBy: [{ approvedAt: 'desc' }, { createdAt: 'desc' }],
        take,
      }),
      this.prisma.buyback.count({ where }),
    ]);

    return {
      total,
      rows: rows.map((r) => {
        const lineCount = r.lines.length;
        const baseSummary = `${r.goldType.nameLo} · ${fmtWeight(r.weightG)} g`;
        return {
          id: r.id,
          type: 'BUYBACK',
          code: r.code,
          decision: normalizeDecision(r.status),
          status: r.status,
          createdAt: r.createdAt,
          approvedAt: r.approvedAt,
          confirmedAt: r.confirmedAt,
          settledAt: null,
          rejectReason: r.rejectReason,
          customerPhone: r.customer.phone,
          detailSummary: lineCount > 1 ? `${baseSummary} (${lineCount} ແຖວ)` : baseSummary,
          amountLak: r.payableAmount.toFixed(),
          sellPrice: null,
          downPayment: null,
          outstanding: null,
          createdById: r.createdById,
          approvedById: r.approvedById,
          legs: r.payments.map((p) => ({
            id: p.id,
            method: p.method,
            bankAccountId: p.bankAccountId,
            bankNameLo: p.bankAccount?.nameLo ?? null,
            currency: p.currency,
            amount: p.amount.toFixed(),
            amountLak: p.amountLak.toFixed(),
            changeLak: p.changeLak.toFixed(),
          })),
          lines:
            r.lines.length > 0
              ? r.lines.map((l) => ({
                  id: l.id,
                  label: l.goldItem?.nameLo
                    ? `${l.goldType.nameLo} · ${l.goldItem.nameLo}`
                    : l.goldType.nameLo,
                  weightG: l.weightG.toFixed(),
                  quantity: l.quantity,
                  amountLak: l.payableAmount.toFixed(),
                }))
              : [
                  {
                    id: r.id,
                    label: r.goldItem?.nameLo
                      ? `${r.goldType.nameLo} · ${r.goldItem.nameLo}`
                      : r.goldType.nameLo,
                    weightG: r.weightG.toFixed(),
                    quantity: r.quantity,
                    amountLak: r.payableAmount.toFixed(),
                  },
                ],
        };
      }),
    };
  }

  private async fetchExchanges(
    statusFilter: Prisma.GoldExchangeWhereInput,
    dateFilter: Prisma.GoldExchangeWhereInput,
    searchClause: Prisma.GoldExchangeWhereInput | undefined,
    take: number,
  ): Promise<{ rows: ApprovalHistoryRecord[]; total: number }> {
    const where: Prisma.GoldExchangeWhereInput = {
      deletedAt: null,
      AND: [statusFilter, dateFilter, ...(searchClause ? [searchClause] : [])],
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.goldExchange.findMany({
        where,
        include: {
          customer: { select: { phone: true } },
          oldLines: {
            include: {
              goldType: { select: { nameLo: true } },
              goldItem: { select: { nameLo: true } },
            },
          },
          newLines: {
            include: {
              goldSku: { select: { fullSkuName: true } },
            },
          },
          payments: { include: { bankAccount: { select: { nameLo: true } } } },
        },
        orderBy: [{ approvedAt: 'desc' }, { createdAt: 'desc' }],
        take,
      }),
      this.prisma.goldExchange.count({ where }),
    ]);

    return {
      total,
      rows: rows.map((r) => {
        const oldW = r.oldLines.reduce(
          (sum, l) => sum.plus(dec(l.weightG.toFixed()).mul(l.quantity)),
          dec(0),
        );
        const newW = r.newLines.reduce(
          (sum, l) => sum.plus(dec(l.weightG.toFixed()).mul(l.quantity)),
          dec(0),
        );
        const txnLabel = r.txnType === 'FREE_EXCHANGE' ? 'ປ່ຽນຟຣີ' : 'ປ່ຽນເປັນເງິນ';
        const detailSummary =
          oldW.gt(0) || newW.gt(0)
            ? `${txnLabel} (${oldW.toFixed()} → ${newW.toFixed()} g)`
            : txnLabel;

        return {
          id: r.id,
          type: 'EXCHANGE',
          code: r.code,
          decision: normalizeDecision(r.status),
          status: r.status,
          createdAt: r.createdAt,
          approvedAt: r.approvedAt,
          confirmedAt: null,
          settledAt: null,
          rejectReason: r.rejectReason,
          customerPhone: r.customer.phone,
          detailSummary,
          amountLak: r.totalPayable.toFixed(),
          sellPrice: null,
          downPayment: null,
          outstanding: null,
          createdById: r.createdById,
          approvedById: r.approvedById,
          legs: r.payments.map((p) => ({
            id: p.id,
            method: p.method,
            bankAccountId: p.bankAccountId,
            bankNameLo: p.bankAccount?.nameLo ?? null,
            currency: p.currency,
            amount: p.amount.toFixed(),
            amountLak: p.amountLak.toFixed(),
            changeLak: p.changeLak.toFixed(),
          })),
          lines: [
            ...r.oldLines.map((l) => ({
              id: `old:${l.id}`,
              label: `ຄຳເກົ່າ: ${l.goldType.nameLo}${l.goldItem?.nameLo ? ` · ${l.goldItem.nameLo}` : ''}`,
              weightG: l.weightG.toFixed(),
              quantity: l.quantity,
              amountLak: l.shopBuybackPrice.toFixed(),
            })),
            ...r.newLines.map((l) => ({
              id: `new:${l.id}`,
              label: `ຄຳໃໝ່: ${l.goldSku.fullSkuName}`,
              weightG: l.weightG.toFixed(),
              quantity: l.quantity,
              amountLak: null,
            })),
          ],
        };
      }),
    };
  }

  private async fetchCredits(
    statusFilter: Prisma.GoldCreditWhereInput,
    dateFilter: Prisma.GoldCreditWhereInput,
    searchClause: Prisma.GoldCreditWhereInput | undefined,
    take: number,
  ): Promise<{ rows: ApprovalHistoryRecord[]; total: number }> {
    const where: Prisma.GoldCreditWhereInput = {
      deletedAt: null,
      AND: [statusFilter, dateFilter, ...(searchClause ? [searchClause] : [])],
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.goldCredit.findMany({
        where,
        include: {
          customer: { select: { phone: true } },
          goldItem: { select: { nameLo: true } },
          lines: {
            include: { goldItem: { select: { nameLo: true } } },
            orderBy: { sortOrder: 'asc' },
          },
          receipts: {
            include: { bankAccount: { select: { nameLo: true } } },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: [{ approvedAt: 'desc' }, { createdAt: 'desc' }],
        take,
      }),
      this.prisma.goldCredit.count({ where }),
    ]);

    return {
      total,
      rows: rows.map((r) => {
        const lineCount = r.lines.length;
        const baseSummary = `${r.goldItem.nameLo} · ${fmtWeight(r.weightG)} g`;
        return {
          id: r.id,
          type: 'CREDIT',
          code: r.code,
          decision: normalizeDecision(r.status),
          status: r.status,
          createdAt: r.createdAt,
          approvedAt: r.approvedAt,
          confirmedAt: null,
          settledAt: r.settledAt,
          rejectReason: r.rejectReason,
          customerPhone: r.customer.phone,
          detailSummary: lineCount > 1 ? `${baseSummary} (${lineCount} ແຖວ)` : baseSummary,
          amountLak: r.sellPrice.toFixed(),
          sellPrice: r.sellPrice.toFixed(),
          downPayment: r.downPayment.toFixed(),
          outstanding: r.outstanding.toFixed(),
          createdById: r.createdById,
          approvedById: r.approvedById,
          legs: r.receipts.map((rc) => ({
            id: rc.id,
            method: rc.method,
            bankAccountId: rc.bankAccountId,
            bankNameLo: rc.bankAccount?.nameLo ?? null,
            currency: rc.currency,
            amount: rc.amount.toFixed(),
            amountLak: rc.amountLak.toFixed(),
            changeLak: rc.changeLak.toFixed(),
          })),
          lines:
            r.lines.length > 0
              ? r.lines.map((l) => ({
                  id: l.id,
                  label: l.goldItem.nameLo,
                  weightG: l.weightG.toFixed(),
                  quantity: l.quantity,
                  amountLak: l.sellPrice.toFixed(),
                }))
              : [
                  {
                    id: r.id,
                    label: r.goldItem.nameLo,
                    weightG: r.weightG.toFixed(),
                    quantity: r.quantity,
                    amountLak: r.sellPrice.toFixed(),
                  },
                ],
        };
      }),
    };
  }
}
