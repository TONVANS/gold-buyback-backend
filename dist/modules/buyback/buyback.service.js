"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BuybackService = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const domain_1 = require("@kpv/domain");
const prisma_service_1 = require("../../prisma/prisma.service");
const audit_service_1 = require("../../common/services/audit.service");
const history_range_service_1 = require("../../common/services/history-range.service");
const approval_service_1 = require("../../common/services/approval.service");
const business_day_service_1 = require("../../common/services/business-day.service");
const stock_ledger_service_1 = require("../../common/services/stock-ledger.service");
const cash_service_1 = require("../cash/cash.service");
const notifications_service_1 = require("../notifications/notifications.service");
const pricing_context_service_1 = require("../pricing/pricing-context.service");
/** Maps a ປະເພດຄຳ row to the pricing branch it takes in §5.1. */
const KIND_BY_CODE = {
    GOOD: 'GOOD',
    HUMP: 'HUMP',
    BAR: 'BAR',
    BOILED: 'BOILED',
};
const D = (value) => new client_1.Prisma.Decimal(value.toFixed());
/**
 * TOR §5.1 — Buyback (ການຊື້ຄຳຄືນ).
 *
 * Workflow:
 *   ຜູ້ປະເມີນ ສ້າງລາຍການ (PENDING)
 *     -> payment ກົດ Approve (APPROVED)
 *       -> ຜູ້ປະເມີນ ກົດຢືນຢັນອີກຄັ້ງ (COMPLETED)
 *
 * Nothing moves until COMPLETED. At that point the cash/bank payout and the
 * Stock (OLD) receipt are written in ONE transaction, so the shop can never
 * end up having paid for gold it did not book, or booked gold it did not pay
 * for.
 */
let BuybackService = class BuybackService {
    prisma;
    audit;
    approval;
    businessDay;
    notifications;
    pricingContext;
    stockLedger;
    cash;
    range;
    constructor(prisma, audit, approval, businessDay, notifications, pricingContext, stockLedger, cash, range) {
        this.prisma = prisma;
        this.audit = audit;
        this.approval = approval;
        this.businessDay = businessDay;
        this.notifications = notifications;
        this.pricingContext = pricingContext;
        this.stockLedger = stockLedger;
        this.cash = cash;
        this.range = range;
    }
    kindFor(code) {
        const kind = KIND_BY_CODE[code];
        if (!kind) {
            throw new common_1.BadRequestException(`ປະເພດຄຳ "${code}" ບໍ່ຮອງຮັບການຊື້ຄືນ`);
        }
        return kind;
    }
    /**
     * ແປງ dto ເປັນລາຍການແຖວ.
     *
     * ບິນໜຶ່ງມີໄດ້ຫຼາຍລາຍການຄຳ (ທີ່ລູກຄ້າຂໍ). ຖ້າ client ເກົ່າສົ່ງແບບແຖວດຽວມາ
     * ກໍຫໍ່ໃຫ້ເປັນແຖວດຽວ ເພື່ອໃຫ້ເສັ້ນທາງຄິດລາຄາມີທາງດຽວ.
     */
    toLines(dto) {
        if (dto.lines?.length)
            return dto.lines;
        if (!dto.goldTypeId || !dto.weightG || !dto.quantity) {
            throw new common_1.BadRequestException('ຕ້ອງມີລາຍການຄຳຢ່າງໜ້ອຍ 1 ລາຍການ');
        }
        return [
            {
                goldTypeId: dto.goldTypeId,
                goldItemId: dto.goldItemId,
                weightG: dto.weightG,
                quantity: dto.quantity,
                goldPercent: dto.goldPercent,
                deduction: dto.deduction,
            },
        ];
    }
    /**
     * ຄິດລາຄາທຸກແຖວ ດ້ວຍຕາຕະລາງລາຄາຊຸດດຽວກັນ.
     *
     * ຄິດເປັນແຖວ ເພາະແຕ່ລະລາຍການອາດຄົນລະປະເພດຄຳ, ຄົນລະນ້ຳໜັກ ແລະ ຄົນລະ %ຄຳ
     * — ການລວມກ່ອນຄິດຈະໄດ້ລາຄາຜິດ ແລະ ລົງສາງແຍກປະເພດບໍ່ໄດ້.
     */
    async priceLines(source, lines, context) {
        const typeIds = [...new Set(lines.map((l) => l.goldTypeId))];
        const goldTypes = await this.prisma.goldType.findMany({
            where: { id: { in: typeIds }, deletedAt: null },
        });
        if (goldTypes.length !== typeIds.length)
            throw new common_1.NotFoundException('ບໍ່ພົບປະເພດຄຳ');
        const typeById = new Map(goldTypes.map((t) => [t.id, t]));
        return lines.map((line, index) => {
            const goldType = typeById.get(line.goldTypeId);
            const weight = (0, domain_1.dec)(line.weightG);
            if (!weight.isFinite() || weight.lte(0)) {
                throw new common_1.BadRequestException(`ນ້ຳໜັກຕ້ອງໃຫຍ່ກວ່າ 0 (ແຖວທີ ${index + 1})`);
            }
            if (source === 'OTHER_SHOP' && goldType.code !== 'BOILED') {
                throw new common_1.BadRequestException(`ຄຳຮ້ານອື່ນ (ຄຳຕົ້ມ) ຕ້ອງເລືອກປະເພດຄຳຕົ້ມ (ແຖວທີ ${index + 1})`);
            }
            if (source === 'KPV' && goldType.code === 'BOILED') {
                throw new common_1.BadRequestException(`ຄຳຮ້ານ KPV ບໍ່ຮອງຮັບປະເພດຄຳຕົ້ມ — ກະລຸນາເລືອກແຫຼ່ງທີ່ມາ "ຄຳຮ້ານອື່ນ" (ແຖວທີ ${index + 1})`);
            }
            const kind = source === 'OTHER_SHOP' ? 'BOILED' : this.kindFor(goldType.code);
            if (kind === 'BOILED') {
                if (!line.goldPercent) {
                    throw new common_1.BadRequestException(`ຄຳຕົ້ມຕ້ອງປ້ອນ %ຄຳ (ແຖວທີ ${index + 1})`);
                }
                const pct = (0, domain_1.dec)(line.goldPercent);
                if (!pct.isFinite() || pct.lte(0) || pct.gt(100)) {
                    throw new common_1.BadRequestException(`%ຄຳ ຕ້ອງຢູ່ລະຫວ່າງ 0.01 ຫາ 100 (ແຖວທີ ${index + 1})`);
                }
            }
            const result = (0, domain_1.calculateBuyback)({
                kind,
                weightG: line.weightG,
                quantity: line.quantity,
                goldPercent: line.goldPercent,
                deduction: line.deduction,
            }, context.source, context.table);
            return { line, goldType, kind, result, index };
        });
    }
    summarizePriced(priced) {
        for (const p of priced) {
            if (p.result.payableAmount.lte(0)) {
                throw new common_1.BadRequestException(`ຄິດໄລ່ລາຄາບໍ່ໄດ້ ແຖວທີ ${p.index + 1} (${p.result.branch}) — ກະລຸນາກວດສອບນ້ຳໜັກ ແລະ ປະເພດຄຳ`);
            }
        }
        const totalPayable = priced.reduce((sum, p) => sum.plus(p.result.payableAmount), (0, domain_1.dec)(0));
        const totalWeightG = priced.reduce((sum, p) => sum.plus((0, domain_1.dec)(p.line.weightG).mul(p.line.quantity)), (0, domain_1.dec)(0));
        const totalQuantity = priced.reduce((sum, p) => sum + p.line.quantity, 0);
        const head = priced[0];
        return {
            head,
            totalPayable,
            totalWeightG,
            totalQuantity,
            branch: head.result.branch,
            shopBuybackPrice: head.result.shopBuybackPrice,
            deduction: head.result.deduction,
        };
    }
    /**
     * Run the §5.1 calculation without writing anything — backs the live
     * preview on the Valuer's form.
     */
    async preview(dto) {
        const context = await this.pricingContext.load();
        const priced = await this.priceLines(dto.source, this.toLines(dto), context);
        const total = priced.reduce((sum, p) => sum.plus(p.result.payableAmount), (0, domain_1.dec)(0));
        const first = priced[0];
        return {
            snapshotId: context.snapshot.id,
            // ຊ່ອງເກົ່າ = ແຖວທຳອິດ / ຍອດລວມ, ເພື່ອໃຫ້ໜ້າຈໍເກົ່າຍັງອ່ານໄດ້.
            goldTypeCode: first.goldType.code,
            kind: first.kind,
            shopBuybackPrice: first.result.shopBuybackPrice.toFixed(),
            deduction: first.result.deduction.toFixed(),
            payableAmount: total.toFixed(),
            branch: first.result.branch,
            totalWeightG: priced
                .reduce((sum, p) => sum.plus((0, domain_1.dec)(p.line.weightG).mul(p.line.quantity)), (0, domain_1.dec)(0))
                .toFixed(),
            totalQuantity: priced.reduce((sum, p) => sum + p.line.quantity, 0),
            lines: priced.map((p) => ({
                goldTypeId: p.line.goldTypeId,
                goldTypeNameLo: p.goldType.nameLo,
                goldItemId: p.line.goldItemId ?? null,
                weightG: p.line.weightG,
                quantity: p.line.quantity,
                goldPercent: p.line.goldPercent ?? null,
                shopBuybackPrice: p.result.shopBuybackPrice.toFixed(),
                deduction: p.result.deduction.toFixed(),
                payableAmount: p.result.payableAmount.toFixed(),
                branch: p.result.branch,
            })),
        };
    }
    /**
     * ຜູ້ປະເມີນ creates the line. The price is recomputed server-side rather
     * than trusting what the browser previewed.
     */
    async create(dto, user, shiftId) {
        const context = await this.pricingContext.load();
        const priced = await this.priceLines(dto.source, this.toLines(dto), context);
        const summary = this.summarizePriced(priced);
        // ວິທີຈ່າຍ ສົດ / ໂອນ ແຍກກັນ — a ໂອນ leg has to name a real, open account
        // before anything is written, because confirm books it against that
        // account and has nowhere to put the payout otherwise.
        await this.assertBankLegs(dto.payments);
        const payments = this.resolvePayments(dto.payments, summary.totalPayable, context.rates);
        const customer = await this.prisma.customer.upsert({
            where: { phone: dto.phone },
            update: {},
            create: { phone: dto.phone },
        });
        const created = await this.prisma.$transaction(async (tx) => {
            const paidLak = payments.totalLak.minus(payments.changeLak);
            const buyback = await tx.buyback.create({
                data: {
                    code: await this.nextCode(tx),
                    shiftId,
                    customerId: customer.id,
                    snapshotId: context.snapshot.id,
                    source: dto.source,
                    // ຊ່ອງຫົວບິນ = ແຖວທຳອິດ / ຍອດລວມ ເພື່ອບໍ່ໃຫ້ລາຍງານເກົ່າພັງ;
                    // ຄວາມຈິງຕໍ່ລາຍການຢູ່ໃນ `lines`.
                    goldTypeId: summary.head.line.goldTypeId,
                    goldItemId: summary.head.line.goldItemId ?? null,
                    weightG: D(summary.totalWeightG),
                    quantity: summary.totalQuantity,
                    goldPercent: summary.head.line.goldPercent
                        ? new client_1.Prisma.Decimal((0, domain_1.dec)(summary.head.line.goldPercent).toFixed())
                        : null,
                    shopBuybackPrice: D(summary.shopBuybackPrice),
                    deduction: D(summary.deduction),
                    payableAmount: D(summary.totalPayable),
                    lines: {
                        create: this.toLineCreateInput(priced),
                    },
                    // TOR §5.1 History carries ຍອດເງິນຄ້າງຈ່າຍ, so a partly-paid
                    // buyback is visible rather than looking settled.
                    paidAmount: D(paidLak),
                    outstandingAmount: D(summary.totalPayable.minus(paidLak)),
                    status: 'PENDING',
                    createdById: user.id,
                    payments: {
                        create: this.toPaymentCreateInput(payments.lines),
                    },
                },
                include: this.detailInclude,
            });
            await this.audit.record({
                actorId: user.id,
                action: 'CREATE',
                entity: 'Buyback',
                entityId: buyback.id,
                after: {
                    code: buyback.code,
                    payableAmount: buyback.payableAmount.toFixed(),
                    branch: summary.branch,
                },
                summary: `ສ້າງລາຍການ Buyback ${buyback.code} — ${summary.totalPayable.toFixed(0)} LAK`,
            }, tx);
            await this.notifications.notify({
                kind: 'BUYBACK_CREATED',
                recipientRole: 'PAYMENT',
                title: 'ມີລາຍການ Buyback ໃໝ່ລໍຖ້າອະນຸມັດ',
                body: `${buyback.code} — ${summary.totalPayable.toFixed(0)} LAK`,
                refType: 'Buyback',
                refId: buyback.id,
            }, tx);
            return buyback;
        });
        return { ...created, branch: summary.branch };
    }
    /** ແກ້ໄຂລາຍການ Buyback ຂະນະທີ່ຍັງລໍຖ້າອະນຸມັດ (`PENDING`). */
    async update(id, dto, user) {
        const existing = await this.prisma.buyback.findFirst({
            where: { id, deletedAt: null },
            include: {
                customer: true,
                payments: true,
                lines: { orderBy: { sortOrder: 'asc' } },
            },
        });
        if (!existing)
            throw new common_1.NotFoundException('ບໍ່ພົບລາຍການ Buyback');
        this.assertCreatorOrManager(existing.createdById, user, 'ມີພຽງຜູ້ສ້າງລາຍການ ຫຼື ຜູ້ຈັດການ ເທົ່ານັ້ນທີ່ແກ້ໄຂໄດ້');
        if (existing.status !== 'PENDING') {
            throw new common_1.ConflictException('ແກ້ໄຂໄດ້ສະເພາະລາຍການທີ່ລໍຖ້າອະນຸມັດ (PENDING)');
        }
        const nextSource = dto.source ?? existing.source;
        const nextPhone = dto.phone ?? existing.customer.phone;
        const nextLineInputs = dto.lines ??
            (existing.lines.length > 0
                ? existing.lines.map((l) => ({
                    goldTypeId: l.goldTypeId,
                    goldItemId: l.goldItemId ?? undefined,
                    weightG: l.weightG.toFixed(),
                    quantity: l.quantity,
                    goldPercent: l.goldPercent?.toFixed(),
                    deduction: l.deduction.toFixed(),
                }))
                : [
                    {
                        goldTypeId: existing.goldTypeId,
                        goldItemId: existing.goldItemId ?? undefined,
                        weightG: existing.weightG.toFixed(),
                        quantity: existing.quantity,
                        goldPercent: existing.goldPercent?.toFixed(),
                        deduction: existing.deduction.toFixed(),
                    },
                ]);
        const nextPaymentInputs = dto.payments ??
            existing.payments.map((p) => ({
                method: p.method,
                bankAccountId: p.bankAccountId ?? undefined,
                currency: p.currency,
                amount: p.amount.toFixed(),
            }));
        const context = await this.pricingContext.load();
        const priced = await this.priceLines(nextSource, nextLineInputs, context);
        const summary = this.summarizePriced(priced);
        await this.assertBankLegs(nextPaymentInputs);
        const payments = this.resolvePayments(nextPaymentInputs, summary.totalPayable, context.rates);
        const customer = await this.prisma.customer.upsert({
            where: { phone: nextPhone },
            update: {},
            create: { phone: nextPhone },
        });
        const updated = await this.prisma.$transaction(async (tx) => {
            const paidLak = payments.totalLak.minus(payments.changeLak);
            const claim = await tx.buyback.updateMany({
                where: { id, status: 'PENDING', deletedAt: null },
                data: {
                    customerId: customer.id,
                    snapshotId: context.snapshot.id,
                    source: nextSource,
                    goldTypeId: summary.head.line.goldTypeId,
                    goldItemId: summary.head.line.goldItemId ?? null,
                    weightG: D(summary.totalWeightG),
                    quantity: summary.totalQuantity,
                    goldPercent: summary.head.line.goldPercent
                        ? new client_1.Prisma.Decimal((0, domain_1.dec)(summary.head.line.goldPercent).toFixed())
                        : null,
                    shopBuybackPrice: D(summary.shopBuybackPrice),
                    deduction: D(summary.deduction),
                    payableAmount: D(summary.totalPayable),
                    paidAmount: D(paidLak),
                    outstandingAmount: D(summary.totalPayable.minus(paidLak)),
                },
            });
            if (claim.count !== 1) {
                throw new common_1.ConflictException('ສະຖານະລາຍການມີການປ່ຽນແປງແລ້ວ — ກະລຸນາໂຫຼດຄືນ');
            }
            await tx.buybackLine.deleteMany({ where: { buybackId: id } });
            await tx.buybackLine.createMany({
                data: this.toLineCreateInput(priced).map((l) => ({ ...l, buybackId: id })),
            });
            await tx.buybackPayment.deleteMany({ where: { buybackId: id } });
            await tx.buybackPayment.createMany({
                data: this.toPaymentCreateInput(payments.lines).map((p) => ({ ...p, buybackId: id })),
            });
            const saved = await tx.buyback.findUniqueOrThrow({
                where: { id },
                include: this.detailInclude,
            });
            await this.audit.record({
                actorId: user.id,
                action: 'UPDATE',
                entity: 'Buyback',
                entityId: id,
                before: {
                    source: existing.source,
                    payableAmount: existing.payableAmount.toFixed(),
                },
                after: {
                    source: nextSource,
                    payableAmount: summary.totalPayable.toFixed(),
                },
                summary: `ແກ້ໄຂ Buyback ${existing.code} — ${summary.totalPayable.toFixed(0)} LAK`,
            }, tx);
            return saved;
        });
        return { ...updated, branch: summary.branch };
    }
    /** payment ກົດ Approve / Reject (TOR §4.2). */
    async review(id, dto, user) {
        const buyback = await this.prisma.buyback.findFirst({
            where: { id, deletedAt: null },
            include: { payments: true },
        });
        if (!buyback)
            throw new common_1.NotFoundException('ບໍ່ພົບລາຍການ Buyback');
        const next = dto.decision === 'APPROVED' ? 'APPROVED' : 'REJECTED';
        this.approval.assertTransition(buyback.status, next);
        if (dto.decision === 'APPROVED') {
            await this.cash.assertSufficientFunds(buyback.payments, `ການຈ່າຍ Buyback ${buyback.code}`);
        }
        return this.prisma.$transaction(async (tx) => {
            const claim = await tx.buyback.updateMany({
                where: { id, status: buyback.status, deletedAt: null },
                data: {
                    status: next,
                    approvedById: user.id,
                    approvedAt: new Date(),
                    rejectReason: dto.decision === 'REJECTED' ? (dto.reason ?? null) : null,
                },
            });
            if (claim.count !== 1) {
                throw new common_1.ConflictException('ສະຖານະລາຍການມີການປ່ຽນແປງແລ້ວ — ກະລຸນາໂຫຼດຄືນ');
            }
            const updated = await tx.buyback.findUniqueOrThrow({ where: { id } });
            await this.audit.record({
                actorId: user.id,
                action: dto.decision === 'APPROVED' ? 'APPROVE' : 'REJECT',
                entity: 'Buyback',
                entityId: id,
                before: { status: buyback.status },
                after: { status: next },
                summary: `${dto.decision === 'APPROVED' ? 'ອະນຸມັດ' : 'ປະຕິເສດ'} Buyback ${buyback.code}`,
            }, tx);
            await this.notifications.notify({
                kind: 'APPROVAL_RESULT',
                recipientUserId: buyback.createdById,
                title: dto.decision === 'APPROVED'
                    ? `Buyback ${buyback.code} ຖືກອະນຸມັດ — ກະລຸນາກົດຢືນຢັນ`
                    : `Buyback ${buyback.code} ຖືກປະຕິເສດ`,
                body: dto.reason ?? undefined,
                refType: 'Buyback',
                refId: id,
            }, tx);
            return updated;
        });
    }
    /**
     * ຜູ້ປະເມີນ ກົດຢືນຢັນອີກຄັ້ງ -> COMPLETED.
     *
     * This is the only point at which anything moves. Cash/bank out and Stock
     * (OLD) in are posted together; if either fails, neither happens.
     */
    async confirm(id, user, openShiftId) {
        const buyback = await this.prisma.buyback.findFirst({
            where: { id, deletedAt: null },
            include: {
                shift: { select: { id: true, status: true } },
                payments: true,
                goldType: true,
                lines: { orderBy: { sortOrder: 'asc' } },
            },
        });
        if (!buyback)
            throw new common_1.NotFoundException('ບໍ່ພົບລາຍການ Buyback');
        this.assertCreatorOrManager(buyback.createdById, user, 'ມີພຽງຜູ້ສ້າງລາຍການເທົ່ານັ້ນທີ່ຢືນຢັນໄດ້');
        const effectiveShiftId = openShiftId ?? (buyback.shift.status === 'OPEN' ? buyback.shiftId : undefined);
        if (!effectiveShiftId) {
            throw new common_1.BadRequestException('ຕ້ອງເປີດກະກ່ອນຢືນຢັນ Buyback');
        }
        this.approval.assertTransition(buyback.status, 'COMPLETED');
        await this.cash.assertSufficientFunds(buyback.payments, `ການຈ່າຍ Buyback ${buyback.code}`);
        const day = await this.businessDay.current();
        return this.prisma.$transaction(async (tx) => {
            const claim = await tx.buyback.updateMany({
                where: { id, status: 'APPROVED', deletedAt: null },
                data: { status: 'COMPLETED', confirmedAt: new Date() },
            });
            if (claim.count !== 1) {
                throw new common_1.ConflictException('ສະຖານະລາຍການມີການປ່ຽນແປງແລ້ວ — ກະລຸນາໂຫຼດຄືນ');
            }
            // 1. Money leaves the shop, split across the recorded payment legs.
            await this.postCashAndBankOut(tx, {
                businessDayId: day.id,
                shiftId: effectiveShiftId,
                buybackId: buyback.id,
                code: buyback.code,
                payments: buyback.payments,
                actorId: user.id,
            });
            /*
             * 2. ຄຳເຂົ້າ Stock (OLD) ຕາມ ປະເພດຄຳ ຂອງແຕ່ລະແຖວ ດ້ວຍລາຄາຂອງແຖວນັ້ນ.
             *
             * ບິນດຽວມີຫຼາຍປະເພດຄຳໄດ້ ສະນັ້ນຈຶ່ງລົງເປັນແຖວ — ຖ້າລົງກ້ອນດຽວຕາມ
             * ປະເພດຂອງຫົວບິນ ສາງຂອງປະເພດອື່ນຈະຂາດ ແລະ WAC ຈະຜິດ.
             */
            const postings = buyback.lines.length
                ? buyback.lines.map((line) => ({
                    goldTypeId: line.goldTypeId,
                    goldG: (0, domain_1.dec)(line.weightG.toFixed()).mul(line.quantity),
                    priceIn: (0, domain_1.dec)(line.payableAmount.toFixed()),
                }))
                : [
                    {
                        goldTypeId: buyback.goldTypeId,
                        goldG: (0, domain_1.dec)(buyback.weightG.toFixed()),
                        priceIn: (0, domain_1.dec)(buyback.payableAmount.toFixed()),
                    },
                ];
            for (const posting of postings) {
                await this.stockLedger.postOld(tx, {
                    goldTypeId: posting.goldTypeId,
                    businessDayId: day.id,
                    goldInG: posting.goldG,
                    priceIn: posting.priceIn,
                    partnerLabel: 'Cashier',
                    typeLabel: `Buyback ${buyback.code}`,
                    createdById: user.id,
                });
            }
            const goldG = postings.reduce((sum, p) => sum.plus(p.goldG), (0, domain_1.dec)(0));
            const updated = await tx.buyback.findUniqueOrThrow({ where: { id } });
            await this.audit.record({
                actorId: user.id,
                action: 'COMPLETE',
                entity: 'Buyback',
                entityId: id,
                before: { status: buyback.status },
                after: { status: 'COMPLETED' },
                summary: `ຢືນຢັນ Buyback ${buyback.code} — ຈ່າຍ ${buyback.payableAmount.toFixed(0)} LAK, ຮັບຄຳ ${goldG.toFixed()} g`,
            }, tx);
            return updated;
        });
    }
    /** ຍົກເລີກລາຍການກ່ອນທີ່ຈະ COMPLETED (`PENDING` ຫຼື `APPROVED`). */
    async cancel(id, dto, user) {
        const buyback = await this.prisma.buyback.findFirst({
            where: { id, deletedAt: null },
        });
        if (!buyback)
            throw new common_1.NotFoundException('ບໍ່ພົບລາຍການ Buyback');
        if (buyback.createdById !== user.id &&
            !['PAYMENT', 'ADMIN', 'MANAGER'].includes(user.role)) {
            throw new common_1.ConflictException('ທ່ານບໍ່ມີສິດຍົກເລີກລາຍການນີ້');
        }
        this.approval.assertTransition(buyback.status, 'CANCELLED');
        return this.prisma.$transaction(async (tx) => {
            const claim = await tx.buyback.updateMany({
                where: { id, status: buyback.status, deletedAt: null },
                data: {
                    status: 'CANCELLED',
                    rejectReason: dto.reason?.trim() || buyback.rejectReason || null,
                },
            });
            if (claim.count !== 1) {
                throw new common_1.ConflictException('ສະຖານະລາຍການມີການປ່ຽນແປງແລ້ວ — ກະລຸນາໂຫຼດຄືນ');
            }
            const updated = await tx.buyback.findUniqueOrThrow({ where: { id } });
            await this.audit.record({
                actorId: user.id,
                action: 'UPDATE',
                entity: 'Buyback',
                entityId: id,
                before: { status: buyback.status },
                after: { status: 'CANCELLED', reason: dto.reason ?? null },
                summary: `ຍົກເລີກ Buyback ${buyback.code}${dto.reason ? ` (${dto.reason})` : ''}`,
            }, tx);
            if (buyback.createdById !== user.id) {
                await this.notifications.notify({
                    kind: 'APPROVAL_RESULT',
                    recipientUserId: buyback.createdById,
                    title: `Buyback ${buyback.code} ຖືກຍົກເລີກ`,
                    body: dto.reason ?? undefined,
                    refType: 'Buyback',
                    refId: id,
                }, tx);
            }
            return updated;
        });
    }
    /** ຊຳລະຍອດຄ້າງຈ່າຍເພີ່ມເຕີມ (`outstandingAmount > 0`). */
    async addPayment(id, dto, user, openShiftId) {
        const buyback = await this.prisma.buyback.findFirst({
            where: { id, deletedAt: null },
            include: { shift: { select: { id: true, status: true } } },
        });
        if (!buyback)
            throw new common_1.NotFoundException('ບໍ່ພົບລາຍການ Buyback');
        if (!['APPROVED', 'COMPLETED'].includes(buyback.status)) {
            throw new common_1.ConflictException('ຊຳລະເພີ່ມໄດ້ສະເພາະລາຍການທີ່ອະນຸມັດແລ້ວ ຫຼື ສຳເລັດແລ້ວ');
        }
        const outstanding = (0, domain_1.dec)(buyback.outstandingAmount.toFixed());
        if (outstanding.lte(0)) {
            throw new common_1.BadRequestException('ລາຍການນີ້ບໍ່ມີຍອດຄ້າງຈ່າຍ');
        }
        await this.assertBankLegs(dto.payments);
        const context = await this.pricingContext.load();
        const resolved = this.resolvePayments(dto.payments, outstanding, context.rates);
        if (buyback.status === 'COMPLETED') {
            await this.cash.assertSufficientFunds(resolved.lines.map((l) => ({
                method: l.method,
                bankAccountId: l.bankAccountId ?? null,
                currency: l.currency,
                amount: l.amount,
            })), `ການຈ່າຍຄ້າງ Buyback ${buyback.code}`);
        }
        const effectiveShiftId = openShiftId ?? (buyback.shift.status === 'OPEN' ? buyback.shiftId : undefined);
        if (buyback.status === 'COMPLETED' && !effectiveShiftId) {
            throw new common_1.BadRequestException('ຕ້ອງເປີດກະກ່ອນບັນທຶກການຈ່າຍເງິນ');
        }
        const day = buyback.status === 'COMPLETED' ? await this.businessDay.current() : null;
        return this.prisma.$transaction(async (tx) => {
            const appliedLak = resolved.totalLak.minus(resolved.changeLak);
            const nextPaid = (0, domain_1.dec)(buyback.paidAmount.toFixed()).plus(appliedLak);
            const nextOutstanding = (0, domain_1.dec)(buyback.payableAmount.toFixed()).minus(nextPaid);
            const claim = await tx.buyback.updateMany({
                where: {
                    id,
                    status: buyback.status,
                    outstandingAmount: buyback.outstandingAmount,
                    deletedAt: null,
                },
                data: {
                    paidAmount: D(nextPaid),
                    outstandingAmount: D(nextOutstanding.gt(0) ? nextOutstanding : (0, domain_1.dec)(0)),
                },
            });
            if (claim.count !== 1) {
                throw new common_1.ConflictException('ຍອດຄ້າງຈ່າຍມີການປ່ຽນແປງແລ້ວ — ກະລຸນາໂຫຼດຄືນ');
            }
            const createdPayments = await Promise.all(this.toPaymentCreateInput(resolved.lines).map((p) => tx.buybackPayment.create({ data: { ...p, buybackId: id } })));
            if (buyback.status === 'COMPLETED' && day && effectiveShiftId) {
                await this.postCashAndBankOut(tx, {
                    businessDayId: day.id,
                    shiftId: effectiveShiftId,
                    buybackId: buyback.id,
                    code: buyback.code,
                    payments: createdPayments,
                    actorId: user.id,
                });
            }
            await this.audit.record({
                actorId: user.id,
                action: 'UPDATE',
                entity: 'Buyback',
                entityId: id,
                before: { outstandingAmount: outstanding.toFixed(0) },
                after: { outstandingAmount: nextOutstanding.toFixed(0) },
                summary: `ຊຳລະຄ້າງ Buyback ${buyback.code} — ${appliedLak.toFixed(0)} LAK`,
            }, tx);
            return tx.buyback.findUniqueOrThrow({
                where: { id },
                include: this.detailInclude,
            });
        });
    }
    /** Soft delete (ສະເພາະ PENDING / REJECTED / CANCELLED — ຫ້າມລຶບ COMPLETED). */
    async remove(id, user) {
        const buyback = await this.prisma.buyback.findFirst({
            where: { id, deletedAt: null },
        });
        if (!buyback)
            throw new common_1.NotFoundException('ບໍ່ພົບລາຍການ Buyback');
        this.assertCreatorOrManager(buyback.createdById, user, 'ມີພຽງຜູ້ສ້າງລາຍການ ຫຼື ຜູ້ຈັດການ ເທົ່ານັ້ນທີ່ລຶບໄດ້');
        if (!['PENDING', 'REJECTED', 'CANCELLED'].includes(buyback.status)) {
            throw new common_1.ConflictException('ລຶບໄດ້ສະເພາະລາຍການທີ່ຍັງບໍ່ອະນຸມັດ, ຖືກປະຕິເສດ ຫຼື ຍົກເລີກ');
        }
        return this.prisma.$transaction(async (tx) => {
            const claim = await tx.buyback.updateMany({
                where: { id, status: buyback.status, deletedAt: null },
                data: { deletedAt: new Date(), deletedById: user.id },
            });
            if (claim.count !== 1) {
                throw new common_1.ConflictException('ສະຖານະລາຍການມີການປ່ຽນແປງແລ້ວ — ກະລຸນາໂຫຼດຄືນ');
            }
            await this.audit.record({
                actorId: user.id,
                action: 'DELETE',
                entity: 'Buyback',
                entityId: id,
                before: { code: buyback.code, status: buyback.status },
                summary: `ລຶບລາຍການ Buyback ${buyback.code}`,
            }, tx);
            return { id, deleted: true };
        });
    }
    async list(status, query, user) {
        const range = this.range.resolve(query, user);
        const timeWin = this.range.resolveTimeWindow(range, query);
        const q = query.search?.trim();
        /*
         * ລາຍການ Buyback ທີ່ຍັງຄ້າງດຳເນີນການ (PENDING / APPROVED / ຫຼື COMPLETED ທີ່ຍັງມີຍອດຄ້າງຈ່າຍ)
         * ຕ້ອງປາກົດຢູ່ໜ້າປະຫວັດຈົນກວ່າຈະສຳເລັດຄົບຖ້ວນ (Success), ເພື່ອບໍ່ໃຫ້ລາຍການຄ້າງຂ້າມມື້
         * ຫາຍໄປຈາກໜ້າຈໍເມື່ອຂຶ້ນມື້ໃໝ່ — ເຊັ່ນດຽວກັບ Module Order ແລະ ຝາກສິນຄ້າ.
         * ເມື່ອມີຕົວກອງຊ່ວງເວລາ (start_time / end_time), ກອງຕາມຊ່ວງ timestamp ທີ່ຂໍໂດຍກົງ.
         */
        const inRange = { createdAt: timeWin ?? history_range_service_1.HistoryRangeService.window(range) };
        const zero = D((0, domain_1.dec)(0));
        const stillOpen = {
            status: { notIn: ['REJECTED', 'CANCELLED'] },
            OR: [{ status: { not: 'COMPLETED' } }, { outstandingAmount: { gt: zero } }],
        };
        const dateOrStatusWhere = timeWin
            ? {
                ...inRange,
                ...(status ? { status } : {}),
            }
            : status
                ? {
                    status,
                    ...(status === 'REJECTED' || status === 'CANCELLED'
                        ? inRange
                        : status === 'COMPLETED'
                            ? { OR: [inRange, { outstandingAmount: { gt: zero } }] }
                            : {}),
                }
                : { OR: [inRange, stillOpen] };
        const andClauses = [dateOrStatusWhere];
        if (query.source)
            andClauses.push({ source: query.source });
        if (q) {
            andClauses.push({
                OR: [
                    { code: { contains: q, mode: 'insensitive' } },
                    { customer: { phone: { contains: q, mode: 'insensitive' } } },
                ],
            });
        }
        const where = {
            deletedAt: null,
            AND: andClauses,
        };
        const [rows, total] = await this.prisma.$transaction([
            this.prisma.buyback.findMany({
                where,
                include: this.detailInclude,
                orderBy: { createdAt: 'desc' },
                skip: range.skip,
                take: range.take,
            }),
            this.prisma.buyback.count({ where }),
        ]);
        // TOR History tables carry UPDATED BY.
        return this.range.page(await this.audit.withActorNames(rows), total, range);
    }
    async getOne(id, _user) {
        const row = await this.prisma.buyback.findFirst({
            where: { id, deletedAt: null },
            include: this.detailInclude,
        });
        if (!row)
            throw new common_1.NotFoundException('ບໍ່ພົບລາຍການ Buyback');
        const [withActors] = await this.audit.withActorNames([row]);
        const audits = await this.audit.forEntity('Buyback', id);
        return { ...withActors, audits };
    }
    /* ---------------------------------------------------------------- *
     * Helpers
     * ---------------------------------------------------------------- */
    detailInclude = {
        customer: true,
        goldType: true,
        goldItem: true,
        // ແຖວໂອນ ຕ້ອງບອກໄດ້ວ່າ ເງິນອອກຈາກບັນຊີໃດ — ບໍ່ດັ່ງນັ້ນ ປະຫວັດຈະ
        // ແຍກ ສົດ/ໂອນ ບໍ່ອອກ.
        payments: { include: { bankAccount: { select: { nameLo: true } } } },
        // ລາຍການຄຳໃນບິນ — View ຕ້ອງເຫັນຄົບທຸກແຖວ.
        lines: {
            include: { goldType: { select: { nameLo: true } }, goldItem: { select: { nameLo: true } } },
            orderBy: { sortOrder: 'asc' },
        },
    };
    assertCreatorOrManager(createdById, user, message) {
        if (createdById !== user.id && !['ADMIN', 'MANAGER'].includes(user.role)) {
            throw new common_1.ConflictException(message);
        }
    }
    toLineCreateInput(priced) {
        return priced.map((p) => ({
            goldTypeId: p.line.goldTypeId,
            goldItemId: p.line.goldItemId ?? null,
            weightG: new client_1.Prisma.Decimal((0, domain_1.dec)(p.line.weightG).toFixed()),
            quantity: p.line.quantity,
            goldPercent: p.line.goldPercent
                ? new client_1.Prisma.Decimal((0, domain_1.dec)(p.line.goldPercent).toFixed())
                : null,
            shopBuybackPrice: D(p.result.shopBuybackPrice),
            deduction: D(p.result.deduction),
            payableAmount: D(p.result.payableAmount),
            branch: p.result.branch,
            sortOrder: p.index,
        }));
    }
    toPaymentCreateInput(lines) {
        return lines.map((line) => ({
            method: line.method,
            bankAccountId: line.bankAccountId ?? null,
            currency: line.currency,
            rate: D(line.rate),
            amount: D(line.amount),
            amountLak: D(line.amountLak),
            changeLak: D(line.changeLak),
        }));
    }
    async postCashAndBankOut(tx, input) {
        for (const payment of input.payments) {
            if (payment.method === 'CASH') {
                await tx.cashTransaction.create({
                    data: {
                        businessDayId: input.businessDayId,
                        shiftId: input.shiftId,
                        type: 'OUT',
                        currency: payment.currency,
                        amount: payment.amount,
                        refType: 'Buyback',
                        refId: input.buybackId,
                        note: `ຈ່າຍ Buyback ${input.code}`,
                        createdById: input.actorId,
                    },
                });
            }
            else {
                // Checked at creation, re-checked here: a ໂອນ leg with no account
                // would otherwise take gold into stock without the money ever
                // leaving a bank balance.
                if (!payment.bankAccountId) {
                    throw new common_1.BadRequestException(`ແຖວຈ່າຍແບບໂອນຂອງ ${input.code} ບໍ່ມີບັນຊີທະນາຄານ — ຢືນຢັນບໍ່ໄດ້`);
                }
                await tx.bankTransaction.create({
                    data: {
                        businessDayId: input.businessDayId,
                        bankAccountId: payment.bankAccountId,
                        type: 'WITHDRAW',
                        currency: payment.currency,
                        amount: payment.amount,
                        refType: 'Buyback',
                        refId: input.buybackId,
                        note: `ຈ່າຍ Buyback ${input.code}`,
                        createdById: input.actorId,
                    },
                });
            }
            // เງິນທອນ LAK ທີ່ລູກຄ້າທອນຄືນຮ້ານ ຕ້ອງບັນທຶກເຂົ້າ Module Cash ເພື່ອໃຫ້ຍອດຕົງກັບຄວາມຈິງ.
            if ((0, domain_1.dec)(payment.changeLak.toFixed()).gt(0)) {
                await tx.cashTransaction.create({
                    data: {
                        businessDayId: input.businessDayId,
                        shiftId: input.shiftId,
                        type: 'IN',
                        currency: 'LAK',
                        amount: payment.changeLak,
                        refType: 'Buyback',
                        refId: input.buybackId,
                        note: `ເງິນທອນ Buyback ${input.code}`,
                        createdById: input.actorId,
                    },
                });
            }
        }
    }
    /**
     * ສົດ ແລະ ໂອນ ເປັນສອງເສັ້ນທາງແຍກກັນ: a ສົດ leg settles against the drawer
     * of the open shift, a ໂອນ leg against one named bank account. One buyback
     * may carry both, so each leg is checked on its own.
     */
    async assertBankLegs(lines) {
        const bankLegs = lines.filter((line) => line.method === 'BANK');
        if (bankLegs.length === 0)
            return;
        if (bankLegs.some((line) => !line.bankAccountId)) {
            throw new common_1.BadRequestException('ການຈ່າຍແບບໂອນ ຕ້ອງເລືອກທະນາຄານ');
        }
        const ids = [...new Set(bankLegs.map((line) => line.bankAccountId))];
        const open = await this.prisma.bankAccount.findMany({
            where: { id: { in: ids }, isActive: true },
            select: { id: true },
        });
        if (open.length !== ids.length) {
            throw new common_1.BadRequestException('ບັນຊີທະນາຄານທີ່ເລືອກບໍ່ມີ ຫຼື ຖືກປິດໃຊ້ງານແລ້ວ');
        }
    }
    resolvePayments(lines, payableAmount, rates) {
        let lakLegsTotal = (0, domain_1.dec)(0);
        let foreignLakTotal = (0, domain_1.dec)(0);
        const resolved = lines.map((line) => {
            if (line.method === 'BANK' && !line.bankAccountId) {
                throw new common_1.BadRequestException('ກະລຸນາເລືອກທະນາຄານ');
            }
            const amount = (0, domain_1.dec)(line.amount);
            if (!amount.isFinite() || amount.lte(0)) {
                throw new common_1.BadRequestException('ຈຳນວນເງິນຕ້ອງໃຫຍ່ກວ່າ 0');
            }
            const rate = pricing_context_service_1.PricingContextService.rateFor(rates, line.currency, 'buyback');
            const amountLak = amount.mul(rate);
            if (line.currency === 'LAK') {
                lakLegsTotal = lakLegsTotal.plus(amount);
            }
            else {
                foreignLakTotal = foreignLakTotal.plus(amountLak);
            }
            return { ...line, rate, amount, amountLak, changeLak: (0, domain_1.dec)(0) };
        });
        // §5.1: total LAK paid out across all LAK legs may not exceed the amount owed.
        if (lakLegsTotal.gt(payableAmount)) {
            throw new common_1.BadRequestException(`ຈຳນວນເງິນ LAK (${lakLegsTotal.toFixed(0)}) ຕ້ອງບໍ່ເກີນລວມເງິນທີ່ຕ້ອງຈ່າຍ (${payableAmount.toFixed(0)})`);
        }
        if (lakLegsTotal.gt(0) && foreignLakTotal.gte(payableAmount)) {
            throw new common_1.BadRequestException('ຍອດສະກຸນເງິນຕ່າງປະເທດຄົບຍອດແລ້ວ ບໍ່ຄວນຈ່າຍ LAK ເພີ່ມ');
        }
        const totalLak = resolved.reduce((sum, line) => sum.plus(line.amountLak), (0, domain_1.dec)(0));
        const change = totalLak.minus(payableAmount);
        // Change is LAK-only and is attributed to the last foreign-currency leg (or last leg).
        if (change.gt(0) && resolved.length > 0) {
            const targetIdx = [...resolved].reverse().findIndex((l) => l.currency !== 'LAK');
            const idx = targetIdx >= 0 ? resolved.length - 1 - targetIdx : resolved.length - 1;
            resolved[idx].changeLak = change;
        }
        return { lines: resolved, totalLak, changeLak: change.gt(0) ? change : (0, domain_1.dec)(0) };
    }
    /** Atomic, sequential code in Vientiane local business date: BB-YYMMDD-NNN. */
    async nextCode(tx) {
        const today = business_day_service_1.BusinessDayService.toDateOnly();
        const yymmdd = String(today.getUTCFullYear()).slice(2) +
            String(today.getUTCMonth() + 1).padStart(2, '0') +
            String(today.getUTCDate()).padStart(2, '0');
        const prefix = `BB-${yymmdd}`;
        const scope = `BUYBACK_${yymmdd}`;
        for (let attempt = 0; attempt < 50; attempt++) {
            const rows = await tx.$queryRaw `
        INSERT INTO code_sequences (scope, next, "updatedAt")
        VALUES (${scope}, 2, NOW())
        ON CONFLICT (scope)
        DO UPDATE SET next = code_sequences.next + 1, "updatedAt" = NOW()
        RETURNING code_sequences.next - 1 AS next
      `;
            const seq = rows[0]?.next;
            if (seq === undefined) {
                throw new common_1.InternalServerErrorException('ອອກລະຫັດອັດຕະໂນມັດບໍ່ສຳເລັດ');
            }
            const code = `${prefix}-${String(seq).padStart(3, '0')}`;
            const taken = await tx.buyback.findUnique({ where: { code }, select: { id: true } });
            if (!taken)
                return code;
        }
        throw new common_1.InternalServerErrorException('ອອກລະຫັດ Buyback ບໍ່ສຳເລັດ');
    }
};
exports.BuybackService = BuybackService;
exports.BuybackService = BuybackService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        audit_service_1.AuditService,
        approval_service_1.ApprovalService,
        business_day_service_1.BusinessDayService,
        notifications_service_1.NotificationsService,
        pricing_context_service_1.PricingContextService,
        stock_ledger_service_1.StockLedgerService,
        cash_service_1.CashService,
        history_range_service_1.HistoryRangeService])
], BuybackService);
//# sourceMappingURL=buyback.service.js.map