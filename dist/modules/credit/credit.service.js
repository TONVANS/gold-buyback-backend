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
exports.CreditService = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const domain_1 = require("@kpv/domain");
const prisma_service_1 = require("../../prisma/prisma.service");
const audit_service_1 = require("../../common/services/audit.service");
const history_range_service_1 = require("../../common/services/history-range.service");
const approval_service_1 = require("../../common/services/approval.service");
const business_day_service_1 = require("../../common/services/business-day.service");
const apar_posting_service_1 = require("../../common/services/apar-posting.service");
const cash_service_1 = require("../cash/cash.service");
const notifications_service_1 = require("../notifications/notifications.service");
const pricing_context_service_1 = require("../pricing/pricing-context.service");
const D = (value) => new client_1.Prisma.Decimal(value.toFixed());
/**
 * TOR §5.3 change limits. Foreign notes are accepted for convenience, not as
 * a currency exchange service, so the amount that can come back as LAK change
 * is capped.
 */
const CHANGE_LIMIT = {
    THB: (0, domain_1.dec)(1_000),
    USD: (0, domain_1.dec)(100),
};
/**
 * TOR §5.3 — ລາຍການສິນເຊື່ອ (Gold Credit / Installment).
 *
 *   ຍອດເງິນສິນເຊື່ອຕິດໜີ້ = ລາຄາຂາຍ − ເງິນວາງດາວ
 *
 * The outstanding balance is an AR (Cash): the shop has handed over gold and
 * is owed money. It is posted on approval and drawn down by each instalment.
 */
let CreditService = class CreditService {
    prisma;
    audit;
    approval;
    businessDay;
    apar;
    cash;
    notifications;
    pricingContext;
    range;
    constructor(prisma, audit, approval, businessDay, apar, cash, notifications, pricingContext, range) {
        this.prisma = prisma;
        this.audit = audit;
        this.approval = approval;
        this.businessDay = businessDay;
        this.apar = apar;
        this.cash = cash;
        this.notifications = notifications;
        this.pricingContext = pricingContext;
        this.range = range;
    }
    detailInclude = {
        customer: true,
        goldItem: true,
        cabinet: true,
        lines: {
            include: { goldItem: true, cabinet: true },
            orderBy: { sortOrder: 'asc' },
        },
        receipts: {
            include: { bankAccount: { select: { nameLo: true } } },
            orderBy: { createdAt: 'asc' },
        },
    };
    /**
     * Resolve every leg of one receipt using Price Rate Sell (§5.3).
     *
     * A customer may pay part in cash and part by transfer, in more than one
     * currency. LAK legs may not exceed the amount owed (nor be added once
     * foreign legs already cover it), and any LAK change from foreign currency
     * is attributed to foreign legs and capped at 1,000 THB / 100 USD regardless
     * of leg order.
     */
    resolveReceipts(lines, rates, owed, options) {
        if (owed.eq(0)) {
            if (lines.length === 0 && options?.allowEmptyWhenZero) {
                return {
                    lines: [],
                    totalLak: (0, domain_1.dec)(0),
                    changeLak: (0, domain_1.dec)(0),
                    appliedLak: (0, domain_1.dec)(0),
                    remainingLak: (0, domain_1.dec)(0),
                };
            }
            throw new common_1.BadRequestException('ບໍ່ມີຍອດເງິນທີ່ຕ້ອງຮັບ — ບໍ່ຕ້ອງປ້ອນລາຍການຮັບເງິນ');
        }
        if (lines.length === 0) {
            throw new common_1.BadRequestException('ຕ້ອງມີລາຍການຮັບເງິນຢ່າງໜ້ອຍ 1 ລາຍການ');
        }
        let lakLegsTotal = (0, domain_1.dec)(0);
        let foreignLakTotal = (0, domain_1.dec)(0);
        let hasCashLakLeg = false;
        const resolved = lines.map((dto) => {
            if (dto.method === 'BANK' && !dto.bankAccountId) {
                throw new common_1.BadRequestException('ກະລຸນາເລືອກທະນາຄານ');
            }
            const rawAmount = (0, domain_1.dec)(dto.amount);
            if (!rawAmount.isFinite() || rawAmount.lte(0)) {
                throw new common_1.BadRequestException('ຈຳນວນເງິນຕ້ອງໃຫຍ່ກວ່າ 0');
            }
            const isCashLak = dto.method === 'CASH' && dto.currency === 'LAK';
            const amount = isCashLak ? (0, domain_1.roundDownCashLak)(rawAmount) : rawAmount;
            if (amount.lte(0)) {
                throw new common_1.BadRequestException('ຈຳນວນເງິນສົດ LAK ຕ້ອງຢ່າງໜ້ອຍ 500 LAK');
            }
            if (isCashLak)
                hasCashLakLeg = true;
            const rate = pricing_context_service_1.PricingContextService.rateFor(rates, dto.currency, 'sell');
            const amountLak = amount.mul(rate);
            if (dto.currency === 'LAK') {
                lakLegsTotal = lakLegsTotal.plus(amount);
            }
            else {
                foreignLakTotal = foreignLakTotal.plus(amountLak);
            }
            return { ...dto, amount, rate, amountLak, changeLak: (0, domain_1.dec)(0) };
        });
        const totalLak = resolved.reduce((sum, l) => sum.plus(l.amountLak), (0, domain_1.dec)(0));
        const rawChange = totalLak.gt(owed) ? totalLak.minus(owed) : (0, domain_1.dec)(0);
        const settlement = (0, domain_1.resolveCashLakSettlement)(owed, totalLak, hasCashLakLeg);
        const change = settlement.changeLak;
        if (rawChange.gt(0)) {
            if (lakLegsTotal.gt(owed)) {
                throw new common_1.BadRequestException(`ຈຳນວນເງິນ LAK (${lakLegsTotal.toFixed(0)}) ຕ້ອງບໍ່ເກີນຍອດທີ່ຕ້ອງຮັບ (${owed.toFixed(0)})`);
            }
            if (lakLegsTotal.gt(0) && foreignLakTotal.gte(owed)) {
                throw new common_1.BadRequestException('ຍອດສະກຸນເງິນຕ່າງປະເທດຄົບຍອດແລ້ວ ບໍ່ຄວນຮັບ LAK ເພີ່ມ');
            }
            // Attribute change across foreign-currency legs from last to first so an
            // extra LAK leg at the end can never bypass the §5.3 foreign change cap.
            let remainingChange = change;
            for (let i = resolved.length - 1; i >= 0 && remainingChange.gt(0); i--) {
                const leg = resolved[i];
                if (leg.currency === 'LAK')
                    continue;
                const legChange = remainingChange.lte(leg.amountLak) ? remainingChange : leg.amountLak;
                const limit = CHANGE_LIMIT[leg.currency];
                if (limit && legChange.gt(limit.mul(leg.rate))) {
                    throw new common_1.BadRequestException(`ເງິນທອນຈາກ ${leg.currency} ປ້ອນໄດ້ບໍ່ເກີນ ${limit.toFixed(0)} ${leg.currency}`);
                }
                leg.changeLak = legChange;
                remainingChange = remainingChange.minus(legChange);
            }
            if (remainingChange.gt(0)) {
                throw new common_1.BadRequestException('ເງິນທອນເກີນຂອບເຂດທີ່ກຳນົດ');
            }
        }
        return {
            lines: resolved,
            totalLak,
            changeLak: change,
            appliedLak: settlement.appliedLak,
            remainingLak: settlement.remainingLak,
        };
    }
    /**
     * The legs of a request, however the client spelled them: nested under
     * `receipt`, listed under `receipts`, or — on the receive endpoint —
     * spread across the body itself.
     */
    receiptLines(dto) {
        if (dto.receipts !== undefined)
            return dto.receipts;
        if (dto.receipt)
            return [dto.receipt];
        if (dto.method && dto.currency && dto.amount) {
            return [dto];
        }
        return [];
    }
    async assertBankLegs(lines) {
        const bankLegs = lines.filter((line) => line.method === 'BANK');
        if (bankLegs.length === 0)
            return;
        if (bankLegs.some((line) => !line.bankAccountId)) {
            throw new common_1.BadRequestException('ການຮັບເງິນແບບໂອນ ຕ້ອງເລືອກທະນາຄານ');
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
    extractLines(dto) {
        if (dto.lines?.length)
            return dto.lines;
        if (dto.goldItemId &&
            dto.cabinetId &&
            dto.weightG !== undefined &&
            dto.quantity !== undefined &&
            dto.sellPrice !== undefined) {
            return [
                {
                    goldItemId: dto.goldItemId,
                    cabinetId: dto.cabinetId,
                    weightG: dto.weightG,
                    quantity: dto.quantity,
                    patternFee: dto.patternFee,
                    sellPrice: dto.sellPrice,
                },
            ];
        }
        return [];
    }
    async resolveLines(rawLines) {
        if (rawLines.length === 0) {
            throw new common_1.BadRequestException('ຕ້ອງມີລາຍການຄຳຢ່າງໜ້ອຍ 1 ລາຍການ');
        }
        const parsed = rawLines.map((line) => {
            if (!line.goldItemId)
                throw new common_1.BadRequestException('ກະລຸນາເລືອກລາຍການຄຳ');
            if (!line.cabinetId)
                throw new common_1.BadRequestException('ກະລຸນາເລືອກຕູ້ເຄື່ອງ');
            const weightG = (0, domain_1.dec)(line.weightG);
            if (!weightG.isFinite() || weightG.lte(0)) {
                throw new common_1.BadRequestException('ນ້ຳໜັກຕ້ອງໃຫຍ່ກວ່າ 0');
            }
            if (!Number.isInteger(line.quantity) || line.quantity < 1) {
                throw new common_1.BadRequestException('ຈຳນວນຕ້ອງຢ່າງໜ້ອຍ 1');
            }
            const patternFee = (0, domain_1.dec)(line.patternFee ?? 0);
            if (!patternFee.isFinite() || patternFee.isNegative()) {
                throw new common_1.BadRequestException('ຄ່າລາຍຕ້ອງບໍ່ຕິດລົບ');
            }
            const sellPrice = (0, domain_1.dec)(line.sellPrice);
            if (!sellPrice.isFinite() || sellPrice.lte(0)) {
                throw new common_1.BadRequestException('ລາຄາຂາຍຕ້ອງໃຫຍ່ກວ່າ 0');
            }
            return {
                goldItemId: line.goldItemId,
                cabinetId: line.cabinetId,
                weightG,
                quantity: line.quantity,
                patternFee,
                sellPrice,
            };
        });
        const itemIds = [...new Set(parsed.map((l) => l.goldItemId))];
        const cabinetIds = [...new Set(parsed.map((l) => l.cabinetId))];
        const [items, cabinets] = await Promise.all([
            this.prisma.goldItem.findMany({
                where: { id: { in: itemIds }, deletedAt: null },
                select: { id: true },
            }),
            this.prisma.cabinet.findMany({
                where: { id: { in: cabinetIds }, deletedAt: null },
                select: { id: true },
            }),
        ]);
        if (items.length !== itemIds.length) {
            throw new common_1.NotFoundException('ບໍ່ພົບລາຍການຄຳ');
        }
        if (cabinets.length !== cabinetIds.length) {
            throw new common_1.NotFoundException('ບໍ່ພົບຕູ້ເຄື່ອງ');
        }
        const totalWeightG = parsed.reduce((sum, l) => sum.plus(l.weightG.mul(l.quantity)), (0, domain_1.dec)(0));
        const totalQuantity = parsed.reduce((sum, l) => sum + l.quantity, 0);
        const totalPatternFee = parsed.reduce((sum, l) => sum.plus(l.patternFee.mul(l.quantity)), (0, domain_1.dec)(0));
        const totalSellPrice = parsed.reduce((sum, l) => sum.plus(l.sellPrice), (0, domain_1.dec)(0));
        return {
            lines: parsed,
            head: parsed[0],
            totalWeightG,
            totalQuantity,
            totalPatternFee,
            totalSellPrice,
        };
    }
    assertCreatorOrManager(createdById, user, message) {
        if (createdById !== user.id && !['ADMIN', 'MANAGER'].includes(user.role)) {
            throw new common_1.ConflictException(message);
        }
    }
    async create(dto, user, shiftId) {
        const context = await this.pricingContext.load();
        const resolvedLines = await this.resolveLines(this.extractLines(dto));
        const sellPrice = resolvedLines.totalSellPrice;
        const downPayment = (0, domain_1.dec)(dto.downPayment);
        if (downPayment.isNegative())
            throw new common_1.BadRequestException('ເງິນວາງດາວຕ້ອງບໍ່ຕິດລົບ');
        if (downPayment.gt(sellPrice)) {
            throw new common_1.BadRequestException('ເງິນວາງດາວຕ້ອງບໍ່ເກີນລາຄາຂາຍ');
        }
        const receiptInputs = this.receiptLines(dto);
        await this.assertBankLegs(receiptInputs);
        const outstanding = sellPrice.minus(downPayment);
        // §5.3: the down payment received must cover the agreed down payment.
        const receipt = this.resolveReceipts(receiptInputs, context.rates, downPayment, {
            allowEmptyWhenZero: true,
        });
        if (receipt.remainingLak.gt(0)) {
            throw new common_1.BadRequestException(`ຮັບເງິນ (${receipt.totalLak.toFixed(0)} LAK) ຕ້ອງບໍ່ໜ້ອຍກວ່າເງິນວາງດາວ (${downPayment.toFixed(0)} LAK)`);
        }
        const customer = await this.prisma.customer.upsert({
            where: { phone: dto.phone },
            update: {},
            create: { phone: dto.phone },
        });
        return this.prisma.$transaction(async (tx) => {
            const credit = await tx.goldCredit.create({
                data: {
                    code: await this.nextCode(tx),
                    shiftId,
                    customerId: customer.id,
                    // ຊ່ອງຫົວບິນ = ແຖວທຳອິດ / ຍອດລວມ ເພື່ອບໍ່ໃຫ້ລາຍງານເກົ່າພັງ;
                    // ລາຍລະອຽດແຕ່ລະລາຍການຢູ່ໃນ `lines`.
                    goldItemId: resolvedLines.head.goldItemId,
                    cabinetId: resolvedLines.head.cabinetId,
                    weightG: D(resolvedLines.totalWeightG),
                    quantity: resolvedLines.totalQuantity,
                    patternFee: D(resolvedLines.totalPatternFee),
                    sellPrice: D(sellPrice),
                    downPayment: D(downPayment),
                    outstanding: D(outstanding),
                    status: 'PENDING',
                    createdById: user.id,
                    lines: {
                        create: resolvedLines.lines.map((line, index) => ({
                            goldItemId: line.goldItemId,
                            cabinetId: line.cabinetId,
                            weightG: D(line.weightG),
                            quantity: line.quantity,
                            patternFee: D(line.patternFee),
                            sellPrice: D(line.sellPrice),
                            sortOrder: index,
                        })),
                    },
                    receipts: {
                        create: receipt.lines.map((line) => ({
                            method: line.method,
                            bankAccountId: line.bankAccountId ?? null,
                            currency: line.currency,
                            rate: D(line.rate),
                            amount: D(line.amount),
                            amountLak: D(line.amountLak),
                            changeLak: D(line.changeLak),
                            isDownPayment: true,
                            createdById: user.id,
                        })),
                    },
                },
                include: this.detailInclude,
            });
            await this.audit.record({
                actorId: user.id,
                action: 'CREATE',
                entity: 'GoldCredit',
                entityId: credit.id,
                after: { code: credit.code, outstanding: outstanding.toFixed() },
                summary: `ສ້າງລາຍການສິນເຊື່ອ ${credit.code} — ຕິດໜີ້ ${outstanding.toFixed(0)} LAK`,
            }, tx);
            await this.notifications.notify({
                kind: 'CREDIT_CREATED',
                recipientRole: 'PAYMENT',
                title: 'ມີລາຍການສິນເຊື່ອລໍຖ້າອະນຸມັດ',
                body: `${credit.code} — ຕິດໜີ້ ${outstanding.toFixed(0)} LAK`,
                refType: 'GoldCredit',
                refId: credit.id,
            }, tx);
            return credit;
        });
    }
    /** ແກ້ໄຂລາຍການສິນເຊື່ອ (ສະເພາະ PENDING). */
    async update(id, dto, user) {
        const existing = await this.prisma.goldCredit.findFirst({
            where: { id, deletedAt: null },
            include: {
                customer: true,
                receipts: true,
                lines: { orderBy: { sortOrder: 'asc' } },
            },
        });
        if (!existing)
            throw new common_1.NotFoundException('ບໍ່ພົບລາຍການສິນເຊື່ອ');
        this.assertCreatorOrManager(existing.createdById, user, 'ມີພຽງຜູ້ສ້າງລາຍການ ຫຼື ຜູ້ຈັດການ ເທົ່ານັ້ນທີ່ແກ້ໄຂໄດ້');
        if (existing.status !== 'PENDING') {
            throw new common_1.ConflictException('ແກ້ໄຂໄດ້ສະເພາະລາຍການທີ່ລໍຖ້າອະນຸມັດ (PENDING)');
        }
        const nextPhone = dto.phone ?? existing.customer.phone;
        const existingUnitPatternFee = existing.quantity > 0
            ? (0, domain_1.dec)(existing.patternFee).div(existing.quantity).toFixed()
            : '0';
        const rawNextLines = dto.lines?.length
            ? dto.lines
            : dto.goldItemId !== undefined ||
                dto.cabinetId !== undefined ||
                dto.weightG !== undefined ||
                dto.quantity !== undefined ||
                dto.patternFee !== undefined ||
                dto.sellPrice !== undefined
                ? [
                    {
                        goldItemId: dto.goldItemId ?? existing.goldItemId,
                        cabinetId: dto.cabinetId ?? existing.cabinetId ?? '',
                        weightG: dto.weightG ?? existing.weightG.toFixed(),
                        quantity: dto.quantity ?? existing.quantity,
                        patternFee: dto.patternFee ?? existingUnitPatternFee,
                        sellPrice: dto.sellPrice ?? existing.sellPrice.toFixed(),
                    },
                ]
                : existing.lines.length > 0
                    ? existing.lines.map((l) => ({
                        goldItemId: l.goldItemId,
                        cabinetId: l.cabinetId ?? existing.cabinetId ?? '',
                        weightG: l.weightG.toFixed(),
                        quantity: l.quantity,
                        patternFee: l.patternFee.toFixed(),
                        sellPrice: l.sellPrice.toFixed(),
                    }))
                    : [
                        {
                            goldItemId: existing.goldItemId,
                            cabinetId: existing.cabinetId ?? '',
                            weightG: existing.weightG.toFixed(),
                            quantity: existing.quantity,
                            patternFee: existingUnitPatternFee,
                            sellPrice: existing.sellPrice.toFixed(),
                        },
                    ];
        const resolvedLines = await this.resolveLines(rawNextLines);
        const nextSellPrice = resolvedLines.totalSellPrice;
        const nextDownPayment = (0, domain_1.dec)(dto.downPayment ?? existing.downPayment.toFixed());
        if (nextDownPayment.isNegative())
            throw new common_1.BadRequestException('ເງິນວາງດາວຕ້ອງບໍ່ຕິດລົບ');
        if (nextDownPayment.gt(nextSellPrice)) {
            throw new common_1.BadRequestException('ເງິນວາງດາວຕ້ອງບໍ່ເກີນລາຄາຂາຍ');
        }
        const nextReceiptInputs = dto.receipts !== undefined
            ? dto.receipts
            : existing.receipts
                .filter((r) => r.isDownPayment)
                .map((r) => ({
                method: r.method,
                bankAccountId: r.bankAccountId ?? undefined,
                currency: r.currency,
                amount: r.amount.toFixed(),
            }));
        await this.assertBankLegs(nextReceiptInputs);
        const context = await this.pricingContext.load();
        const receipt = this.resolveReceipts(nextReceiptInputs, context.rates, nextDownPayment, {
            allowEmptyWhenZero: true,
        });
        if (receipt.remainingLak.gt(0)) {
            throw new common_1.BadRequestException(`ຮັບເງິນ (${receipt.totalLak.toFixed(0)} LAK) ຕ້ອງບໍ່ໜ້ອຍກວ່າເງິນວາງດາວ (${nextDownPayment.toFixed(0)} LAK)`);
        }
        const outstanding = nextSellPrice.minus(nextDownPayment);
        const customer = await this.prisma.customer.upsert({
            where: { phone: nextPhone },
            update: {},
            create: { phone: nextPhone },
        });
        return this.prisma.$transaction(async (tx) => {
            const claim = await tx.goldCredit.updateMany({
                where: { id, status: 'PENDING', deletedAt: null },
                data: {
                    customerId: customer.id,
                    goldItemId: resolvedLines.head.goldItemId,
                    cabinetId: resolvedLines.head.cabinetId,
                    weightG: D(resolvedLines.totalWeightG),
                    quantity: resolvedLines.totalQuantity,
                    patternFee: D(resolvedLines.totalPatternFee),
                    sellPrice: D(nextSellPrice),
                    downPayment: D(nextDownPayment),
                    outstanding: D(outstanding),
                },
            });
            if (claim.count !== 1) {
                throw new common_1.ConflictException('ສະຖານະລາຍການມີການປ່ຽນແປງແລ້ວ — ກະລຸນາໂຫຼດຄືນ');
            }
            await tx.creditLine.deleteMany({ where: { creditId: id } });
            await tx.creditLine.createMany({
                data: resolvedLines.lines.map((line, index) => ({
                    creditId: id,
                    goldItemId: line.goldItemId,
                    cabinetId: line.cabinetId,
                    weightG: D(line.weightG),
                    quantity: line.quantity,
                    patternFee: D(line.patternFee),
                    sellPrice: D(line.sellPrice),
                    sortOrder: index,
                })),
            });
            await tx.creditReceipt.deleteMany({ where: { creditId: id, isDownPayment: true } });
            if (receipt.lines.length > 0) {
                await tx.creditReceipt.createMany({
                    data: receipt.lines.map((line) => ({
                        creditId: id,
                        method: line.method,
                        bankAccountId: line.bankAccountId ?? null,
                        currency: line.currency,
                        rate: D(line.rate),
                        amount: D(line.amount),
                        amountLak: D(line.amountLak),
                        changeLak: D(line.changeLak),
                        isDownPayment: true,
                        createdById: user.id,
                    })),
                });
            }
            const saved = await tx.goldCredit.findUniqueOrThrow({
                where: { id },
                include: this.detailInclude,
            });
            await this.audit.record({
                actorId: user.id,
                action: 'UPDATE',
                entity: 'GoldCredit',
                entityId: id,
                before: {
                    sellPrice: existing.sellPrice.toFixed(),
                    downPayment: existing.downPayment.toFixed(),
                    outstanding: existing.outstanding.toFixed(),
                },
                after: {
                    sellPrice: nextSellPrice.toFixed(),
                    downPayment: nextDownPayment.toFixed(),
                    outstanding: outstanding.toFixed(),
                },
                summary: `ແກ້ໄຂສິນເຊື່ອ ${existing.code} — ຕິດໜີ້ ${outstanding.toFixed(0)} LAK`,
            }, tx);
            return saved;
        });
    }
    /**
     * payment approves. On approval the down payment lands in cash/bank and the
     * outstanding balance is recognised as AR (Cash) — TOR §9.2.
     */
    async review(id, dto, user, openShiftId) {
        const credit = await this.prisma.goldCredit.findFirst({
            where: { id, deletedAt: null },
            include: { receipts: true },
        });
        if (!credit)
            throw new common_1.NotFoundException('ບໍ່ພົບລາຍການສິນເຊື່ອ');
        const nextDecisionStatus = dto.decision === 'APPROVED' ? 'APPROVED' : 'REJECTED';
        this.approval.assertTransition(credit.status, nextDecisionStatus);
        const next = dto.decision === 'APPROVED' ? 'COMPLETED' : 'REJECTED';
        const day = await this.businessDay.current();
        return this.prisma.$transaction(async (tx) => {
            let downApplied = (0, domain_1.dec)(0);
            if (dto.decision === 'APPROVED') {
                const changeTotalLak = credit.receipts.reduce((sum, r) => sum.plus((0, domain_1.dec)(r.changeLak.toFixed())), (0, domain_1.dec)(0));
                const touchesCash = credit.receipts.some((r) => r.method === 'CASH') || changeTotalLak.gt(0);
                const cashShiftId = touchesCash
                    ? await this.cash.resolveCounterCashShiftId({
                        actor: user,
                        openShiftId,
                        client: tx,
                    })
                    : undefined;
                if (touchesCash && !cashShiftId) {
                    throw new common_1.BadRequestException('ກະລຸນາເປີດກະ Payment ກ່ອນຮັບ/ທອນເງິນສົດເຂົ້າກະເປົ໋າເງິນສົດ (To Day)');
                }
                if (changeTotalLak.gt(0)) {
                    await this.cash.assertShiftWalletAndBankFunds(cashShiftId, [{ method: 'CASH', currency: 'LAK', amount: changeTotalLak }], `ເງິນທອນສິນເຊື່ອ ${credit.code}`, { client: tx });
                }
                for (const receipt of credit.receipts) {
                    downApplied = downApplied.plus((0, domain_1.dec)(receipt.amountLak.toFixed()).minus((0, domain_1.dec)(receipt.changeLak.toFixed())));
                    await this.recordReceiptMoney(tx, {
                        receipt,
                        businessDayId: day.id,
                        shiftId: cashShiftId ?? null,
                        note: `ເງິນວາງດາວສິນເຊື່ອ ${credit.code}`,
                        changeNote: `ເງິນທອນສິນເຊື່ອ ${credit.code}`,
                        refId: credit.id,
                        createdById: user.id,
                    });
                }
                await this.apar.postCash(tx, {
                    reason: 'CREDIT_ISSUED',
                    currency: 'LAK',
                    amount: (0, domain_1.dec)(credit.outstanding.toFixed()),
                    refId: credit.id,
                    note: `ຍອດສິນເຊື່ອຕິດໜີ້ ${credit.code}`,
                    createdById: user.id,
                });
            }
            const now = new Date();
            const claim = await tx.goldCredit.updateMany({
                where: { id, status: credit.status, deletedAt: null },
                data: {
                    status: next,
                    approvedById: user.id,
                    approvedAt: now,
                    rejectReason: dto.decision === 'REJECTED' ? (dto.reason ?? null) : null,
                    ...(dto.decision === 'APPROVED'
                        ? {
                            paidAmount: D(downApplied),
                            ...((0, domain_1.dec)(credit.outstanding.toFixed()).lte(0) ? { settledAt: now } : {}),
                        }
                        : {}),
                },
            });
            if (claim.count !== 1) {
                throw new common_1.ConflictException('ສະຖານະລາຍການມີການປ່ຽນແປງແລ້ວ — ກະລຸນາໂຫຼດຄືນ');
            }
            const updated = await tx.goldCredit.findUniqueOrThrow({ where: { id } });
            await this.audit.record({
                actorId: user.id,
                action: dto.decision === 'APPROVED' ? 'APPROVE' : 'REJECT',
                entity: 'GoldCredit',
                entityId: id,
                before: { status: credit.status },
                after: { status: next },
                summary: `${dto.decision === 'APPROVED' ? 'ອະນຸມັດ' : 'ປະຕິເສດ'} ສິນເຊື່ອ ${credit.code}`,
            }, tx);
            await this.notifications.notify({
                kind: 'APPROVAL_RESULT',
                recipientUserId: credit.createdById,
                title: dto.decision === 'APPROVED'
                    ? `ສິນເຊື່ອ ${credit.code} ຖືກອະນຸມັດ`
                    : `ສິນເຊື່ອ ${credit.code} ຖືກປະຕິເສດ`,
                body: dto.reason ?? undefined,
                refType: 'GoldCredit',
                refId: id,
            }, tx);
            return updated;
        });
    }
    /** ຍົກເລີກລາຍການທີ່ຍັງລໍຖ້າອະນຸມັດ (PENDING). */
    async cancel(id, dto, user) {
        const credit = await this.prisma.goldCredit.findFirst({
            where: { id, deletedAt: null },
        });
        if (!credit)
            throw new common_1.NotFoundException('ບໍ່ພົບລາຍການສິນເຊື່ອ');
        if (credit.createdById !== user.id &&
            !['PAYMENT', 'ADMIN', 'MANAGER'].includes(user.role)) {
            throw new common_1.ConflictException('ທ່ານບໍ່ມີສິດຍົກເລີກລາຍການນີ້');
        }
        if (credit.status !== 'PENDING') {
            throw new common_1.ConflictException('ຍົກເລີກໄດ້ສະເພາະລາຍການທີ່ລໍຖ້າອະນຸມັດ (PENDING)');
        }
        return this.prisma.$transaction(async (tx) => {
            const claim = await tx.goldCredit.updateMany({
                where: { id, status: 'PENDING', deletedAt: null },
                data: {
                    status: 'CANCELLED',
                    rejectReason: dto.reason?.trim() || credit.rejectReason || null,
                },
            });
            if (claim.count !== 1) {
                throw new common_1.ConflictException('ສະຖານະລາຍການມີການປ່ຽນແປງແລ້ວ — ກະລຸນາໂຫຼດຄືນ');
            }
            const updated = await tx.goldCredit.findUniqueOrThrow({ where: { id } });
            await this.audit.record({
                actorId: user.id,
                action: 'UPDATE',
                entity: 'GoldCredit',
                entityId: id,
                before: { status: credit.status },
                after: { status: 'CANCELLED', reason: dto.reason ?? null },
                summary: `ຍົກເລີກສິນເຊື່ອ ${credit.code}${dto.reason ? ` (${dto.reason})` : ''}`,
            }, tx);
            if (credit.createdById !== user.id) {
                await this.notifications.notify({
                    kind: 'APPROVAL_RESULT',
                    recipientUserId: credit.createdById,
                    title: `ສິນເຊື່ອ ${credit.code} ຖືກຍົກເລີກ`,
                    body: dto.reason ?? undefined,
                    refType: 'GoldCredit',
                    refId: id,
                }, tx);
            }
            return updated;
        });
    }
    /** Soft delete (ສະເພາະ PENDING / REJECTED / CANCELLED). */
    async remove(id, user) {
        const credit = await this.prisma.goldCredit.findFirst({
            where: { id, deletedAt: null },
        });
        if (!credit)
            throw new common_1.NotFoundException('ບໍ່ພົບລາຍການສິນເຊື່ອ');
        this.assertCreatorOrManager(credit.createdById, user, 'ມີພຽງຜູ້ສ້າງລາຍການ ຫຼື ຜູ້ຈັດການ ເທົ່ານັ້ນທີ່ລຶບໄດ້');
        if (!['PENDING', 'REJECTED', 'CANCELLED'].includes(credit.status)) {
            throw new common_1.ConflictException('ລຶບໄດ້ສະເພາະລາຍການທີ່ຍັງບໍ່ອະນຸມັດ, ຖືກປະຕິເສດ ຫຼື ຍົກເລີກ');
        }
        return this.prisma.$transaction(async (tx) => {
            const claim = await tx.goldCredit.updateMany({
                where: { id, status: credit.status, deletedAt: null },
                data: { deletedAt: new Date(), deletedById: user.id },
            });
            if (claim.count !== 1) {
                throw new common_1.ConflictException('ສະຖານະລາຍການມີການປ່ຽນແປງແລ້ວ — ກະລຸນາໂຫຼດຄືນ');
            }
            await this.audit.record({
                actorId: user.id,
                action: 'DELETE',
                entity: 'GoldCredit',
                entityId: id,
                before: { code: credit.code, status: credit.status },
                summary: `ລຶບລາຍການສິນເຊື່ອ ${credit.code}`,
            }, tx);
            return { id, deleted: true };
        });
    }
    /** An instalment against an outstanding credit — draws down the AR. */
    async addReceipt(id, dto, user, openShiftId) {
        const credit = await this.prisma.goldCredit.findFirst({ where: { id, deletedAt: null } });
        if (!credit)
            throw new common_1.NotFoundException('ບໍ່ພົບລາຍການສິນເຊື່ອ');
        if (credit.status !== 'APPROVED' && credit.status !== 'COMPLETED') {
            throw new common_1.BadRequestException('ສິນເຊື່ອຍັງບໍ່ໄດ້ຮັບການອະນຸມັດ');
        }
        const outstanding = (0, domain_1.dec)(credit.outstanding.toFixed());
        if (outstanding.lte(0))
            throw new common_1.BadRequestException('ສິນເຊື່ອນີ້ຊຳຣະຄົບແລ້ວ');
        const receiptInputs = this.receiptLines(dto);
        await this.assertBankLegs(receiptInputs);
        const context = await this.pricingContext.load();
        const receipt = this.resolveReceipts(receiptInputs, context.rates, outstanding);
        const applied = receipt.appliedLak;
        const remaining = receipt.remainingLak;
        const day = await this.businessDay.current();
        const settled = remaining.lte(0);
        const nextOutstanding = settled ? (0, domain_1.dec)(0) : remaining;
        const nextPaidAmount = (0, domain_1.dec)(credit.paidAmount.toFixed()).plus(applied);
        return this.prisma.$transaction(async (tx) => {
            const changeTotalLak = receipt.changeLak;
            const touchesCash = receipt.lines.some((l) => l.method === 'CASH') || changeTotalLak.gt(0);
            const usesCounterWallet = touchesCash && user.role === 'PAYMENT';
            const cashShiftId = usesCounterWallet
                ? await this.cash.resolveCounterCashShiftId({
                    actor: user,
                    openShiftId,
                    preferredUserId: credit.approvedById ?? undefined,
                    client: tx,
                })
                : undefined;
            if (usesCounterWallet && !cashShiftId) {
                throw new common_1.BadRequestException('ກະລຸນາເປີດກະ Payment ກ່ອນຮັບ/ທອນເງິນສົດເຂົ້າກະເປົ໋າເງິນສົດ (To Day)');
            }
            if (changeTotalLak.gt(0)) {
                if (usesCounterWallet) {
                    await this.cash.assertShiftWalletAndBankFunds(cashShiftId, [{ method: 'CASH', currency: 'LAK', amount: changeTotalLak }], `ເງິນທອນຄ່າງວດສິນເຊື່ອ ${credit.code}`, { client: tx });
                }
                else {
                    await this.cash.assertSufficientFunds([{ method: 'CASH', currency: 'LAK', amount: changeTotalLak }], `ເງິນທອນຄ່າງວດສິນເຊື່ອ ${credit.code}`);
                }
            }
            const claim = await tx.goldCredit.updateMany({
                where: {
                    id,
                    status: credit.status,
                    outstanding: credit.outstanding,
                    deletedAt: null,
                },
                data: {
                    outstanding: D(nextOutstanding),
                    paidAmount: D(nextPaidAmount),
                    ...(settled ? { status: 'COMPLETED', settledAt: new Date() } : {}),
                },
            });
            if (claim.count !== 1) {
                throw new common_1.ConflictException('ຍອດຄ້າງຮັບມີການປ່ຽນແປງແລ້ວ — ກະລຸນາໂຫຼດຄືນ');
            }
            // One row and one cash/bank movement per leg, so Payment Wallet and
            // Module Bank each show what actually arrived in them.
            for (const line of receipt.lines) {
                const created = await tx.creditReceipt.create({
                    data: {
                        creditId: id,
                        method: line.method,
                        bankAccountId: line.bankAccountId ?? null,
                        currency: line.currency,
                        rate: D(line.rate),
                        amount: D(line.amount),
                        amountLak: D(line.amountLak),
                        changeLak: D(line.changeLak),
                        createdById: user.id,
                    },
                });
                await this.recordReceiptMoney(tx, {
                    receipt: created,
                    businessDayId: day.id,
                    shiftId: cashShiftId ?? null,
                    note: `ຮັບຄ່າງວດສິນເຊື່ອ ${credit.code}`,
                    changeNote: `ເງິນທອນຄ່າງວດສິນເຊື່ອ ${credit.code}`,
                    refId: credit.id,
                    createdById: user.id,
                });
            }
            await this.apar.postCash(tx, {
                reason: 'CREDIT_RECEIPT',
                currency: 'LAK',
                amount: applied,
                refId: credit.id,
                note: `ຮັບຄ່າງວດ ${credit.code}`,
                createdById: user.id,
            });
            const updated = await tx.goldCredit.findUniqueOrThrow({
                where: { id },
                include: this.detailInclude,
            });
            await this.audit.record({
                actorId: user.id,
                action: 'UPDATE',
                entity: 'GoldCredit',
                entityId: id,
                before: { outstanding: outstanding.toFixed() },
                after: { outstanding: updated.outstanding.toFixed() },
                summary: `ຮັບຄ່າງວດ ${credit.code} — ${applied.toFixed(0)} LAK`,
            }, tx);
            return updated;
        });
    }
    async list(status, query, user) {
        const range = this.range.resolve(query, user);
        const timeWin = this.range.resolveTimeWindow(range, query);
        const q = query.search?.trim();
        const outstandingOnly = query.outstandingOnly === 'true' ||
            query.outstandingOnly === '1' ||
            query.outstanding_only === 'true' ||
            query.outstanding_only === '1';
        const hasExplicitDate = Boolean(query.from_date ?? query.fromDate ?? query.to_date ?? query.toDate);
        const where = {
            deletedAt: null,
            ...(outstandingOnly && user?.role !== 'VALUER' && !hasExplicitDate && !timeWin
                ? {}
                : { createdAt: timeWin ?? history_range_service_1.HistoryRangeService.window(range) }),
            ...(outstandingOnly
                ? {
                    status: status ?? { in: ['APPROVED', 'COMPLETED'] },
                    outstanding: { gt: 0 },
                }
                : status
                    ? { status }
                    : {}),
            ...(q
                ? {
                    OR: [
                        { code: { contains: q, mode: 'insensitive' } },
                        { customer: { phone: { contains: q, mode: 'insensitive' } } },
                    ],
                }
                : {}),
        };
        const [rows, total] = await this.prisma.$transaction([
            this.prisma.goldCredit.findMany({
                where,
                include: this.detailInclude,
                orderBy: { createdAt: 'desc' },
                skip: range.skip,
                take: range.take,
            }),
            this.prisma.goldCredit.count({ where }),
        ]);
        // TOR History tables carry UPDATED BY.
        return this.range.page(await this.audit.withActorNames(rows), total, range);
    }
    async getOne(id, _user) {
        const row = await this.prisma.goldCredit.findFirst({
            where: { id, deletedAt: null },
            include: this.detailInclude,
        });
        if (!row)
            throw new common_1.NotFoundException('ບໍ່ພົບລາຍການສິນເຊື່ອ');
        const [withActors] = await this.audit.withActorNames([row]);
        const audits = await this.audit.forEntity('GoldCredit', id);
        return { ...withActors, audits };
    }
    /** Money in, to cash or bank depending on how it was taken, plus LAK change out. */
    async recordReceiptMoney(tx, input) {
        if (input.receipt.method === 'CASH') {
            await tx.cashTransaction.create({
                data: {
                    businessDayId: input.businessDayId,
                    ...(input.shiftId ? { shiftId: input.shiftId } : {}),
                    type: 'IN',
                    currency: input.receipt.currency,
                    amount: input.receipt.amount,
                    refType: 'GoldCredit',
                    refId: input.refId,
                    note: input.note,
                    createdById: input.createdById,
                },
            });
        }
        else if (input.receipt.bankAccountId) {
            await tx.bankTransaction.create({
                data: {
                    businessDayId: input.businessDayId,
                    bankAccountId: input.receipt.bankAccountId,
                    type: 'DEPOSIT',
                    currency: input.receipt.currency,
                    amount: input.receipt.amount,
                    refType: 'GoldCredit',
                    refId: input.refId,
                    note: input.note,
                    createdById: input.createdById,
                },
            });
        }
        if (input.receipt.changeLak && (0, domain_1.dec)(input.receipt.changeLak.toFixed()).gt(0)) {
            await tx.cashTransaction.create({
                data: {
                    businessDayId: input.businessDayId,
                    ...(input.shiftId ? { shiftId: input.shiftId } : {}),
                    type: 'OUT',
                    currency: 'LAK',
                    amount: input.receipt.changeLak,
                    refType: 'GoldCredit',
                    refId: input.refId,
                    note: input.changeNote ?? `ເງິນທອນ ${input.note}`,
                    createdById: input.createdById,
                },
            });
        }
    }
    /** Atomic, sequential code in Vientiane local business date: CR-YYMMDD-NNN. */
    async nextCode(tx) {
        const today = business_day_service_1.BusinessDayService.toDateOnly();
        const yymmdd = String(today.getUTCFullYear()).slice(2) +
            String(today.getUTCMonth() + 1).padStart(2, '0') +
            String(today.getUTCDate()).padStart(2, '0');
        const prefix = `CR-${yymmdd}`;
        const scope = `CREDIT_${yymmdd}`;
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
            const taken = await tx.goldCredit.findUnique({ where: { code }, select: { id: true } });
            if (!taken)
                return code;
        }
        throw new common_1.InternalServerErrorException('ອອກລະຫັດສິນເຊື່ອບໍ່ສຳເລັດ');
    }
};
exports.CreditService = CreditService;
exports.CreditService = CreditService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        audit_service_1.AuditService,
        approval_service_1.ApprovalService,
        business_day_service_1.BusinessDayService,
        apar_posting_service_1.ApArPostingService,
        cash_service_1.CashService,
        notifications_service_1.NotificationsService,
        pricing_context_service_1.PricingContextService,
        history_range_service_1.HistoryRangeService])
], CreditService);
//# sourceMappingURL=credit.service.js.map