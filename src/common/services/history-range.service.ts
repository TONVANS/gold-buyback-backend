import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma, UserRole } from '@prisma/client';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';
import { HistoryRangeDto, type PagedResult } from '../dto/history-range.dto';
import { BusinessDayService } from './business-day.service';

export interface TimeFilterQuery {
  start_time?: string;
  end_time?: string;
  startTime?: string;
  endTime?: string;
}

/** Roles that may only ever see the current business day. */
const SAME_DAY_ONLY: ReadonlySet<UserRole> = new Set<UserRole>(['VALUER']);

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
/** Ceiling for `all=true`, so an export cannot pull an unbounded ledger. */
export const MAX_EXPORT_ROWS = 5000;

export interface ResolvedRange {
  /** Inclusive start, midnight shop-local. */
  from: Date;
  /** EXCLUSIVE end — midnight of the day after `to`. */
  until: Date;
  /** Inclusive end, for echoing back and for whole-day date columns. */
  to: Date;
  skip: number;
  take: number;
  page: number;
  pageSize: number;
  fromDate: string;
  toDate: string;
  /** True when the caller asked for the whole range rather than one page. */
  all: boolean;
}

/**
 * Resolves the shared `from_date` / `to_date` / `page` contract.
 *
 * Two things are enforced here rather than in each controller, because a
 * rule repeated twenty-five times is a rule that will be wrong in at least
 * one of them:
 *
 *  1. The default range is TODAY. A history screen that opens on the whole
 *     table gets slower every week it runs and is useless on a counter PC.
 *  2. A Valuer is pinned to today regardless of what they send. The frontend
 *     hides the date picker for them, but hiding a control is not a
 *     permission — the API is where it has to hold.
 */
@Injectable()
export class HistoryRangeService {
  /** Parse YYYY-MM-DD as a shop-local midnight, never as UTC. */
  private parse(value: string, label: string): Date {
    const [y, m, d] = value.split('-').map(Number);
    // `new Date('2026-10-19')` is parsed as UTC and lands on the 18th in
    // Vientiane. Building from parts keeps it local, which is what a
    // business day means here.
    const date = new Date(y!, m! - 1, d!);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${label} ບໍ່ຖືກຕ້ອງ`);
    }
    return date;
  }

  private format(date: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  }

  resolve(query: HistoryRangeDto, user?: AuthenticatedUser): ResolvedRange {
    // ຂອບຂອງຊ່ວງເປັນທ່ຽງຄືນທ້ອງຖິ່ນ (ຄືກັນກັບ `parse` ຂ້າງເທິງ); ຖັນວັນທີ
    // ລ້ວນຖືກປະກອບຄືນເປັນ UTC ຢູ່ `dayWindow`.
    const today = BusinessDayService.localMidnight();

    const rawFrom = query.from_date ?? query.fromDate;
    const rawTo = query.to_date ?? query.toDate;

    let from = rawFrom ? this.parse(rawFrom, 'from_date') : today;
    let to = rawTo ? this.parse(rawTo, 'to_date') : today;

    if (from.getTime() > to.getTime()) {
      throw new BadRequestException('from_date ຕ້ອງບໍ່ຫຼັງ to_date');
    }

    // Not negotiable from the client side.
    if (user && SAME_DAY_ONLY.has(user.role)) {
      from = today;
      to = today;
    }

    const until = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);

    const all = query.all === 'true' || query.all === '1';
    const pageSize = Math.min(
      query.page_size ?? query.pageSize ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );
    const page = query.page ?? 1;

    return {
      from,
      to,
      until,
      skip: all ? 0 : (page - 1) * pageSize,
      take: all ? MAX_EXPORT_ROWS : pageSize,
      page: all ? 1 : page,
      pageSize: all ? MAX_EXPORT_ROWS : pageSize,
      fromDate: this.format(from),
      toDate: this.format(to),
      all,
    };
  }

  /** A Prisma filter for a timestamp column. */
  static window(range: ResolvedRange) {
    return { gte: range.from, lt: range.until };
  }

  private parseTime(value: string, label: string) {
    const match = value.trim().match(/^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
    if (!match) {
      throw new BadRequestException(`${label} ບໍ່ຖືກຕ້ອງ (ຮູບແບບ HH:mm)`);
    }
    return {
      hours: Number(match[1]),
      minutes: Number(match[2]),
      seconds: match[3] ? Number(match[3]) : 0,
      hasSeconds: Boolean(match[3]),
    };
  }

  /**
   * ແປງ start_time - end_time (ຮ່ວມກັບ range.from / range.to ໃນເຂດເວລາຮ້ານ)
   * ເປັນຊ່ວງ timestamp `{ gte, lt }` ສຳລັບ Prisma. ຖ້າບໍ່ໄດ້ສົ່ງມາທັງຄູ່ = null.
   */
  resolveTimeWindow(range: ResolvedRange, query: TimeFilterQuery): { gte: Date; lt: Date } | null {
    const rawStart = query.start_time ?? query.startTime;
    const rawEnd = query.end_time ?? query.endTime;
    if (!rawStart && !rawEnd) return null;

    const startBound = rawStart
      ? (() => {
          const t = this.parseTime(rawStart, 'start_time');
          return new Date(
            range.from.getFullYear(),
            range.from.getMonth(),
            range.from.getDate(),
            t.hours,
            t.minutes,
            t.seconds,
            0,
          );
        })()
      : range.from;

    const endBound = rawEnd
      ? (() => {
          const t = this.parseTime(rawEnd, 'end_time');
          return t.hasSeconds
            ? new Date(
                range.to.getFullYear(),
                range.to.getMonth(),
                range.to.getDate(),
                t.hours,
                t.minutes,
                t.seconds + 1,
                0,
              )
            : new Date(
                range.to.getFullYear(),
                range.to.getMonth(),
                range.to.getDate(),
                t.hours,
                t.minutes + 1,
                0,
                0,
              );
        })()
      : range.until;

    if (startBound.getTime() > endBound.getTime() - 1) {
      throw new BadRequestException('start_time ຕ້ອງບໍ່ຫຼັງ end_time');
    }

    return { gte: startBound, lt: endBound };
  }

  /** ຕົວກອງຄົ້ນຫາຮ່ວມກັນສຳລັບ Order (ເບີໂທລູກຄ້າ / ເລກບິນ / ຊື່ພະນັກງານຮັບ / ລະຫັດ Order). */
  static orderSearchWhere(
    search?: string,
    includeSupplier = false,
  ): Prisma.OrderWhereInput | undefined {
    const q = search?.trim();
    if (!q) return undefined;
    return {
      OR: [
        { customer: { phone: { contains: q, mode: 'insensitive' } } },
        { billNo: { contains: q, mode: 'insensitive' } },
        { staffName: { contains: q, mode: 'insensitive' } },
        { code: { contains: q, mode: 'insensitive' } },
        ...(includeSupplier ? [{ supplier: { nameLo: { contains: q, mode: 'insensitive' as const } } }] : []),
      ],
    };
  }

  /**
   * A Prisma filter for a DATE-only column such as `businessDate`.
   *
   * Those columns come back as UTC midnight (2026-09-16T00:00:00Z), while
   * `from`/`to` are shop-LOCAL midnights — seven hours earlier as instants.
   * Comparing the two directly shifts every range by a day: asking for the
   * 16th matched nothing, and asking for the 16th–21st matched the 16th.
   *
   * So the bounds are rebuilt in UTC from the same calendar date. Both ends
   * stay inclusive, which is what a date column with no time can mean.
   */
  static dayWindow(range: ResolvedRange) {
    const utc = (d: Date) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    return { gte: utc(range.from), lte: utc(range.to) };
  }

  page<T>(rows: T[], total: number, range: ResolvedRange): PagedResult<T> {
    return {
      rows,
      page: range.page,
      pageSize: range.pageSize,
      total,
      pageCount: Math.max(1, Math.ceil(total / range.pageSize)),
      fromDate: range.fromDate,
      toDate: range.toDate,
    };
  }
}
