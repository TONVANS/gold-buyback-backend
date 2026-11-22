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
exports.ExchangeService = void 0;
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
const fees_service_1 = require("../fees/fees.service");
const notifications_service_1 = require("../notifications/notifications.service");
const pricing_context_service_1 = require("../pricing/pricing-context.service");
const D = (value) => new client_1.Prisma.Decimal(value.toFixed());
const KIND_BY_CODE = {
    GOOD: 'GOOD',
    HUMP: 'HUMP',
    BAR: 'BAR',
    BOILED: 'BOILED',
};
/**
 * Buyback price boards key 5/3/1 ຫຸນ by printed display weight (1.87 / 1.12 / 0.37).
 */
const EXCHANGE_TO_DISPLAY_WEIGHT = {
    '1.875': '1.87',
    '1.125': '1.12',
    '0.375': '0.37',
};
const toBuybackLookupWeight = (weightG) => {
    const raw = (0, domain_1.dec)(weightG).toFixed();
    return EXCHANGE_TO_DISPLAY_WEIGHT[raw] ?? raw;
};
/**
 * TOR §5.2 — ລາຍການປ່ຽນເປັນເງິນ (Gold Exchange & Trade-in).
 *
 * The rule that governs this module is the zero-balance check: every gram the
 * customer brings in must leave as either new gold or remaining old gold.
 * It is evaluated in the domain layer and enforced HERE as well as in the
 * browser, so a bypassed UI still cannot let gold leak out of the shop.
 */
let ExchangeService = class ExchangeService {
    prisma;
    audit;
    approval;
    businessDay;
    stockLedger;
    cash;
    fees;
    notifications;
    pricingContext;
    range;
    constructor(prisma, audit, approval, businessDay, stockLedger, cash, fees, notifications, pricingContext, range) {
        this.prisma = prisma;
        this.audit = audit;
        this.approval = approval;
        this.businessDay = businessDay;
        this.stockLedger = stockLedger;
        this.cash = cash;
        this.fees = fees;
        this.notifications = notifications;
        this.pricingContext = pricingContext;
        this.range = range;
    }
    detailInclude = {
        customer: true,
        oldLines: {
            include: {
                goldType: { select: { id: true, code: true, nameLo: true } },
                goldItem: { select: { id: true, nameLo: true } },
            },
        },
        newLines: {
            include: {
                goldSku: { select: { id: true, fullSkuName: true, weightG: true } },
                cabinet: { select: { id: true, nameLo: true } },
            },
        },
        remainingLines: true,
        payments: {
            include: {
                bankAccount: { select: { id: true, nameLo: true } },
            },
        },
    };
    /**
     * Assemble domain input from server-side tables (not client-supplied fees).
     *
     * - ຄ່າອ່ອນ applies ONLY to `HUMP` (ຄຳຫຍຸບ).
     * - ຄຳເກົ່າ exchanged for ຄຳໃໝ່ is a gold-for-gold swap; only `ຄຳເກົ່າຄົງເຫຼືອ`
     *   is cashed out at ລາຄາຊື້ຄືນໜ້າຮ້ານ for `totalPayable`. `oldLineStockPrices`
     *   keeps the full valuation of incoming old gold for Stock (OLD) costing.
     * - ຄ່າຫຍຸບ vs ຄ່າປ່ຽນຄຳແທ່ງ are mutually exclusive per line depending on
     *   whether old gold is bar vs jewellery.
     */
    async buildInput(dto, context) {
        const requestedTypeIds = [
            ...dto.oldLines.map((l) => l.goldTypeId),
            ...dto.remainingLines.map((l) => l.goldTypeId).filter((id) => Boolean(id)),
        ];
        const goldTypeIds = [...new Set(requestedTypeIds)];
        const goldTypes = await this.prisma.goldType.findMany({
            where: { id: { in: goldTypeIds }, deletedAt: null },
        });
        const typeById = new Map(goldTypes.map((t) => [t.id, t]));
        const resolveKind = (goldTypeId) => {
            const goldType = typeById.get(goldTypeId);
            if (!goldType)
                throw new common_1.NotFoundException('ບໍ່ພົບປະເພດຄຳ');
            const kind = KIND_BY_CODE[goldType.code];
            if (!kind || kind === 'BOILED') {
                throw new common_1.BadRequestException(`ປະເພດຄຳ "${goldType.nameLo}" ບໍ່ຮອງຮັບການປ່ຽນເປັນເງິນ`);
            }
            return kind;
        };
        const priceLineAtBuyback = (kind, weightG, quantity) => {
            const lookupWeight = toBuybackLookupWeight(weightG);
            const { price } = (0, domain_1.shopBuybackPriceKpv)(kind, lookupWeight, context.source, context.table);
            return price.mul((0, domain_1.dec)(quantity));
        };
        const skuIds = [...new Set(dto.newLines.map((l) => l.goldSkuId))];
        const skus = skuIds.length
            ? await this.prisma.goldSku.findMany({
                where: { id: { in: skuIds }, deletedAt: null },
                include: { goldItem: { select: { code: true } } },
            })
            : [];
        const skuById = new Map(skus.map((s) => [s.id, s]));
        const [jewelryFees, barFees] = await Promise.all([
            this.fees.currentJewelryFees(),
            this.fees.currentBarFees(),
        ]);
        const feeByWeight = new Map();
        for (const fee of jewelryFees) {
            feeByWeight.set((0, domain_1.normalizeExchangeWeightKey)(fee.weightG.toFixed()), {
                good: (0, domain_1.dec)(fee.feeGoodShape.toFixed()),
                damaged: (0, domain_1.dec)(fee.feeDamagedShape.toFixed()),
            });
        }
        const barFeeByWeight = new Map();
        for (const fee of barFees) {
            barFeeByWeight.set((0, domain_1.normalizeExchangeWeightKey)(fee.weightG.toFixed()), {
                toJewelry: (0, domain_1.dec)(fee.barToJewelry.toFixed()),
                toBar: (0, domain_1.dec)(fee.barToBar.toFixed()),
            });
        }
        const oldMeta = dto.oldLines.map((line, idx) => {
            const w = (0, domain_1.dec)(line.weightG);
            if (!w.isFinite() || w.lte(0)) {
                throw new common_1.BadRequestException(`ນ້ຳໜັກຄຳເກົ່າຕ້ອງໃຫຍ່ກວ່າ 0 (ແຖວທີ ${idx + 1})`);
            }
            const kind = resolveKind(line.goldTypeId);
            const derived = (0, domain_1.deriveOldStandardWeight)(kind, line.weightG);
            if (!derived.valid) {
                throw new common_1.BadRequestException(`${derived.errorLo} (ແຖວທີ ${idx + 1})`);
            }
            const stockPrice = priceLineAtBuyback(kind, line.weightG, line.quantity);
            return {
                line,
                kind,
                standardWeightG: derived.standardWeightG,
                softGoldStandardG: derived.softGoldStandardG,
                stockPrice,
            };
        });
        const hasOldBar = oldMeta.some((m) => m.kind === 'BAR');
        const hasOldJewelry = oldMeta.some((m) => m.kind === 'GOOD' || m.kind === 'HUMP');
        const primaryOldKind = oldMeta[0]?.kind ?? 'HUMP';
        const isFree = dto.txnType === 'FREE_EXCHANGE';
        const newLinesInput = dto.newLines.map((line, idx) => {
            const w = (0, domain_1.dec)(line.weightG);
            if (!w.isFinite() || w.lte(0)) {
                throw new common_1.BadRequestException(`ນ້ຳໜັກຄຳໃໝ່ຕ້ອງໃຫຍ່ກວ່າ 0 (ແຖວທີ ${idx + 1})`);
            }
            const sku = skuById.get(line.goldSkuId);
            if (!sku)
                throw new common_1.NotFoundException('ບໍ່ພົບ SKU ຂອງຄຳໃໝ່');
            const isNewBar = sku.goldItem?.code === 'GOLD_BAR';
            const useBarFee = (hasOldBar && !hasOldJewelry) || (hasOldBar && isNewBar);
            if (useBarFee) {
                const { valid, fee } = (0, domain_1.resolveConversionFeeForWeight)(line.weightG, (k) => {
                    const entry = barFeeByWeight.get(k);
                    return entry ? (isNewBar ? entry.toBar : entry.toJewelry) : undefined;
                });
                if (!isFree && !valid) {
                    throw new common_1.BadRequestException(`ນ້ຳໜັກຄຳໃໝ່ (${line.weightG} g) ບໍ່ຕົງຕາມເງືອນໄຂ — ເກີນ 15g ຕ້ອງຫານ 15 ລົງໂຕ (ແຖວທີ ${idx + 1})`);
                }
                return {
                    weightG: line.weightG,
                    quantity: line.quantity,
                    humpFee: (0, domain_1.dec)(0),
                    barConvertFee: fee,
                    patternFee: line.patternFee ?? 0,
                };
            }
            const { valid, fee } = (0, domain_1.resolveConversionFeeForWeight)(line.weightG, (k) => {
                const entry = feeByWeight.get(k);
                return entry ? (dto.shapeCondition === 'GOOD' ? entry.good : entry.damaged) : undefined;
            });
            if (!isFree && !valid) {
                throw new common_1.BadRequestException(`ນ້ຳໜັກຄຳໃໝ່ (${line.weightG} g) ບໍ່ຕົງຕາມເງືອນໄຂ — ເກີນ 15g ຕ້ອງຫານ 15 ລົງໂຕ (ແຖວທີ ${idx + 1})`);
            }
            return {
                weightG: line.weightG,
                quantity: line.quantity,
                humpFee: fee,
                barConvertFee: (0, domain_1.dec)(0),
                patternFee: line.patternFee ?? 0,
            };
        });
        const remainingLinesInput = dto.remainingLines.map((line, idx) => {
            const w = (0, domain_1.dec)(line.weightG);
            if (!w.isFinite() || w.lte(0)) {
                throw new common_1.BadRequestException(`ນ້ຳໜັກຄຳເກົ່າຄົງເຫຼືອຕ້ອງໃຫຍ່ກວ່າ 0 (ແຖວທີ ${idx + 1})`);
            }
            const kind = line.goldTypeId ? resolveKind(line.goldTypeId) : primaryOldKind;
            const unitBuyback = (0, domain_1.exchangeRemainingBuybackPrice)(kind, line.weightG, context.source);
            if (unitBuyback === null) {
                throw new common_1.BadRequestException(`ນ້ຳໜັກຄຳເກົ່າຄົງເຫຼືອ (${line.weightG} g) ບໍ່ຕົງຕາມເກນມາດຕະຖານ — ກະລຸນາແຍກຕາມເກນ (ແຖວທີ ${idx + 1})`);
            }
            return {
                weightG: line.weightG,
                quantity: line.quantity,
                shopBuybackPrice: unitBuyback.mul((0, domain_1.dec)(line.quantity)),
            };
        });
        return {
            input: {
                txnType: dto.txnType,
                shapeCondition: dto.shapeCondition,
                softGoldFeePerGram: context.softGoldFeePerGram,
                oldLines: oldMeta.map((m) => ({
                    weightG: m.line.weightG,
                    quantity: m.line.quantity,
                    standardWeightG: m.standardWeightG,
                    softGoldStandardG: m.softGoldStandardG,
                    goldKind: m.kind,
                    shopBuybackPrice: (0, domain_1.dec)(0),
                })),
                newLines: newLinesInput,
                remainingLines: remainingLinesInput,
            },
            oldLineStockPrices: oldMeta.map((m) => m.stockPrice),
        };
    }
    /** Calculate without writing — backs the live form and the Save gate. */
    async preview(dto) {
        const context = await this.pricingContext.load();
        const { input } = await this.buildInput(dto, context);
        const totals = (0, domain_1.calculateExchange)(input);
        const validation = (0, domain_1.validateExchangeBalance)(totals);
        const isFree = dto.txnType === 'FREE_EXCHANGE';
        return {
            standardOldWeightG: totals.standardOldWeightG.toFixed(),
            actualOldWeightG: totals.actualOldWeightG.toFixed(),
            totalNewWeightG: totals.totalNewWeightG.toFixed(),
            totalRemainingWeightG: totals.totalRemainingWeightG.toFixed(),
            softGoldFee: totals.softGoldFee.toFixed(),
            humpFee: totals.humpFee.toFixed(),
            barConvertFee: totals.barConvertFee.toFixed(),
            patternFee: totals.patternFee.toFixed(),
            shopBuybackPrice: totals.shopBuybackPrice.toFixed(),
            totalPayable: totals.totalPayable.toFixed(),
            isBalanced: validation.isBalanced,
            difference: validation.difference.toFixed(),
            messageLo: validation.messageLo,
            newLines: input.newLines.map((l) => ({
                humpFee: isFree ? '0' : (0, domain_1.dec)(l.humpFee).mul(l.quantity).toFixed(),
                barConvertFee: isFree ? '0' : (0, domain_1.dec)(l.barConvertFee).mul(l.quantity).toFixed(),
                patternFee: isFree ? '0' : (0, domain_1.dec)(l.patternFee).mul(l.quantity).toFixed(),
            })),
            remainingLines: input.remainingLines.map((l) => ({
                shopBuybackPrice: l.shopBuybackPrice.toFixed(),
            })),
        };
    }
    async create(dto, user, shiftId) {
        const context = await this.pricingContext.load();
        const { input, oldLineStockPrices } = await this.buildInput(dto, context);
        const totals = (0, domain_1.calculateExchange)(input);
        const validation = (0, domain_1.validateExchangeBalance)(totals);
        // ⚠ TOR §5.2 CRITICAL rule — the save gate.
        if (!validation.isBalanced) {
            throw new common_1.BadRequestException(validation.messageLo ?? 'ນ້ຳໜັກບໍ່ສົມດຸນ');
        }
        await this.assertBankLegs(dto.payments ?? []);
        const resolvedPayments = this.resolvePayments(dto.payments ?? [], totals.totalPayable, context.rates);
        const customer = await this.prisma.customer.upsert({
            where: { phone: dto.phone },
            update: {},
            create: { phone: dto.phone },
        });
        return this.prisma.$transaction(async (tx) => {
            const exchange = await tx.goldExchange.create({
                data: {
                    code: await this.nextCode(tx),
                    shiftId,
                    customerId: customer.id,
                    snapshotId: context.snapshot.id,
                    txnType: dto.txnType,
                    shapeCondition: dto.shapeCondition,
                    softGoldFee: D(totals.softGoldFee),
                    totalPayable: D(totals.totalPayable),
                    paidAmount: D(resolvedPayments.appliedLak),
                    outstandingAmount: D(resolvedPayments.outstandingAmount),
                    status: 'PENDING',
                    createdById: user.id,
                    payments: {
                        create: this.toPaymentCreateInput(resolvedPayments.lines, user.id),
                    },
                    oldLines: {
                        create: dto.oldLines.map((line, index) => ({
                            goldTypeId: line.goldTypeId,
                            goldItemId: line.goldItemId ?? null,
                            weightG: D((0, domain_1.dec)(line.weightG)),
                            quantity: line.quantity,
                            standardWeightG: D((0, domain_1.dec)(input.oldLines[index].standardWeightG)),
                            shopBuybackPrice: D(oldLineStockPrices[index]),
                        })),
                    },
                    newLines: {
                        create: dto.newLines.map((line, index) => ({
                            goldSkuId: line.goldSkuId,
                            cabinetId: line.cabinetId ?? null,
                            weightG: D((0, domain_1.dec)(line.weightG)),
                            quantity: line.quantity,
                            humpFee: D(dto.txnType === 'FREE_EXCHANGE' ? (0, domain_1.dec)(0) : (0, domain_1.dec)(input.newLines[index].humpFee)),
                            barConvertFee: D(dto.txnType === 'FREE_EXCHANGE' ? (0, domain_1.dec)(0) : (0, domain_1.dec)(input.newLines[index].barConvertFee)),
                            patternFee: D(dto.txnType === 'FREE_EXCHANGE' ? (0, domain_1.dec)(0) : (0, domain_1.dec)(input.newLines[index].patternFee)),
                        })),
                    },
                    remainingLines: {
                        create: dto.remainingLines.map((line, index) => ({
                            weightG: D((0, domain_1.dec)(line.weightG)),
                            quantity: line.quantity,
                            shopBuybackPrice: D(input.remainingLines[index].shopBuybackPrice),
                        })),
                    },
                },
                include: this.detailInclude,
            });
            await this.audit.record({
                actorId: user.id,
                action: 'CREATE',
                entity: 'GoldExchange',
                entityId: exchange.id,
                after: {
                    code: exchange.code,
                    totalPayable: exchange.totalPayable.toFixed(),
                    standardOldWeightG: totals.standardOldWeightG.toFixed(),
                },
                summary: `ສ້າງລາຍການປ່ຽນເປັນເງິນ ${exchange.code}`,
            }, tx);
            await this.notifications.notify({
                kind: 'EXCHANGE_CREATED',
                recipientRole: 'PAYMENT',
                title: 'ມີລາຍການປ່ຽນເປັນເງິນລໍຖ້າອະນຸມັດ',
                body: `${exchange.code} — ${totals.totalPayable.toFixed(0)} LAK`,
                refType: 'GoldExchange',
                refId: exchange.id,
            }, tx);
            return exchange;
        });
    }
    /** ແກ້ໄຂລາຍການປ່ຽນເປັນເງິນຂະນະທີ່ຍັງລໍຖ້າອະນຸມັດ (`PENDING`). */
    async update(id, dto, user) {
        const existing = await this.prisma.goldExchange.findFirst({
            where: { id, deletedAt: null },
            include: this.detailInclude,
        });
        if (!existing)
            throw new common_1.NotFoundException('ບໍ່ພົບລາຍການ');
        this.assertCreatorOrManager(existing.createdById, user, 'ມີພຽງຜູ້ສ້າງລາຍການ ຫຼື ຜູ້ຈັດການ ເທົ່ານັ້ນທີ່ແກ້ໄຂໄດ້');
        if (existing.status !== 'PENDING') {
            throw new common_1.ConflictException('ແກ້ໄຂໄດ້ສະເພາະລາຍການທີ່ລໍຖ້າອະນຸມັດ (PENDING)');
        }
        const nextDto = {
            phone: dto.phone ?? existing.customer.phone,
            txnType: dto.txnType ?? existing.txnType,
            shapeCondition: dto.shapeCondition ?? existing.shapeCondition,
            oldLines: dto.oldLines ??
                existing.oldLines.map((l) => ({
                    goldTypeId: l.goldTypeId,
                    goldItemId: l.goldItemId ?? undefined,
                    weightG: l.weightG.toFixed(),
                    quantity: l.quantity,
                    standardWeightG: l.standardWeightG.toFixed(),
                })),
            newLines: dto.newLines ??
                existing.newLines.map((l) => ({
                    goldSkuId: l.goldSkuId,
                    cabinetId: l.cabinetId ?? undefined,
                    weightG: l.weightG.toFixed(),
                    quantity: l.quantity,
                    patternFee: l.patternFee.toFixed(),
                })),
            remainingLines: dto.remainingLines ??
                existing.remainingLines.map((l) => ({
                    weightG: l.weightG.toFixed(),
                    quantity: l.quantity,
                })),
            payments: dto.payments ??
                existing.payments.map((p) => ({
                    method: p.method,
                    bankAccountId: p.bankAccountId ?? undefined,
                    currency: p.currency,
                    amount: p.amount.toFixed(),
                })),
        };
        const context = await this.pricingContext.load();
        const { input, oldLineStockPrices } = await this.buildInput(nextDto, context);
        const totals = (0, domain_1.calculateExchange)(input);
        const validation = (0, domain_1.validateExchangeBalance)(totals);
        if (!validation.isBalanced) {
            throw new common_1.BadRequestException(validation.messageLo ?? 'ນ້ຳໜັກບໍ່ສົມດຸນ');
        }
        await this.assertBankLegs(nextDto.payments ?? []);
        const resolvedPayments = this.resolvePayments(nextDto.payments ?? [], totals.totalPayable, context.rates);
        const customer = await this.prisma.customer.upsert({
            where: { phone: nextDto.phone },
            update: {},
            create: { phone: nextDto.phone },
        });
        return this.prisma.$transaction(async (tx) => {
            const claim = await tx.goldExchange.updateMany({
                where: { id, status: 'PENDING', deletedAt: null },
                data: {
                    customerId: customer.id,
                    snapshotId: context.snapshot.id,
                    txnType: nextDto.txnType,
                    shapeCondition: nextDto.shapeCondition,
                    softGoldFee: D(totals.softGoldFee),
                    totalPayable: D(totals.totalPayable),
                    paidAmount: D(resolvedPayments.appliedLak),
                    outstandingAmount: D(resolvedPayments.outstandingAmount),
                },
            });
            if (claim.count !== 1) {
                throw new common_1.ConflictException('ສະຖານະລາຍການມີການປ່ຽນແປງແລ້ວ — ກະລຸນາໂຫຼດຄືນ');
            }
            await tx.exchangeOldLine.deleteMany({ where: { exchangeId: id } });
            await tx.exchangeOldLine.createMany({
                data: nextDto.oldLines.map((line, index) => ({
                    exchangeId: id,
                    goldTypeId: line.goldTypeId,
                    goldItemId: line.goldItemId ?? null,
                    weightG: D((0, domain_1.dec)(line.weightG)),
                    quantity: line.quantity,
                    standardWeightG: D((0, domain_1.dec)(input.oldLines[index].standardWeightG)),
                    shopBuybackPrice: D(oldLineStockPrices[index]),
                })),
            });
            await tx.exchangeNewLine.deleteMany({ where: { exchangeId: id } });
            await tx.exchangeNewLine.createMany({
                data: nextDto.newLines.map((line, index) => ({
                    exchangeId: id,
                    goldSkuId: line.goldSkuId,
                    cabinetId: line.cabinetId ?? null,
                    weightG: D((0, domain_1.dec)(line.weightG)),
                    quantity: line.quantity,
                    humpFee: D(nextDto.txnType === 'FREE_EXCHANGE' ? (0, domain_1.dec)(0) : (0, domain_1.dec)(input.newLines[index].humpFee)),
                    barConvertFee: D(nextDto.txnType === 'FREE_EXCHANGE'
                        ? (0, domain_1.dec)(0)
                        : (0, domain_1.dec)(input.newLines[index].barConvertFee)),
                    patternFee: D(nextDto.txnType === 'FREE_EXCHANGE' ? (0, domain_1.dec)(0) : (0, domain_1.dec)(input.newLines[index].patternFee)),
                })),
            });
            await tx.exchangeRemainingLine.deleteMany({ where: { exchangeId: id } });
            await tx.exchangeRemainingLine.createMany({
                data: nextDto.remainingLines.map((line, index) => ({
                    exchangeId: id,
                    weightG: D((0, domain_1.dec)(line.weightG)),
                    quantity: line.quantity,
                    shopBuybackPrice: D(input.remainingLines[index].shopBuybackPrice),
                })),
            });
            await tx.exchangePayment.deleteMany({ where: { exchangeId: id } });
            if (resolvedPayments.lines.length > 0) {
                await tx.exchangePayment.createMany({
                    data: this.toPaymentCreateInput(resolvedPayments.lines, user.id).map((p) => ({
                        ...p,
                        exchangeId: id,
                    })),
                });
            }
            const saved = await tx.goldExchange.findUniqueOrThrow({
                where: { id },
                include: this.detailInclude,
            });
            await this.audit.record({
                actorId: user.id,
                action: 'UPDATE',
                entity: 'GoldExchange',
                entityId: id,
                before: { totalPayable: existing.totalPayable.toFixed() },
                after: { totalPayable: totals.totalPayable.toFixed() },
                summary: `ແກ້ໄຂລາຍການປ່ຽນເປັນເງິນ ${existing.code}`,
            }, tx);
            return saved;
        });
    }
    /** payment ກົດ Approve / Reject. */
    async review(id, dto, user, openShiftId) {
        const exchange = await this.prisma.goldExchange.findFirst({
            where: { id, deletedAt: null },
            include: { oldLines: true, newLines: true, payments: true },
        });
        if (!exchange)
            throw new common_1.NotFoundException('ບໍ່ພົບລາຍການ');
        const next = dto.decision === 'APPROVED' ? 'APPROVED' : 'REJECTED';
        this.approval.assertTransition(exchange.status, next);
        const isIncoming = (0, domain_1.dec)(exchange.totalPayable.toFixed()).lt(0);
        const day = await this.businessDay.current();
        return this.prisma.$transaction(async (tx) => {
            const hasCashOrChange = exchange.payments.some((p) => p.method === 'CASH' || (0, domain_1.dec)(p.changeLak.toFixed()).gt(0));
            const cashShiftId = await this.cash.resolveCounterCashShiftId({
                actor: user,
                openShiftId,
                client: tx,
            });
            if (dto.decision === 'APPROVED') {
                if (hasCashOrChange && !cashShiftId) {
                    throw new common_1.BadRequestException('ກະລຸນາເປີດກະ Payment ແລະ ເບີກເງິນເຂົ້າກະເປົ໋າເງິນສົດ (To Day) ກ່ອນອະນຸມັດລາຍການເງິນສົດ');
                }
                await this.assertFundsForPosting(exchange.payments, isIncoming, `ການຈ່າຍປ່ຽນເປັນເງິນ ${exchange.code}`, cashShiftId, tx);
            }
            const claim = await tx.goldExchange.updateMany({
                where: { id, status: exchange.status, deletedAt: null },
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
            if (dto.decision === 'APPROVED') {
                await this.postCashAndBank(tx, {
                    businessDayId: day.id,
                    shiftId: cashShiftId ?? openShiftId ?? exchange.shiftId,
                    exchangeId: exchange.id,
                    code: exchange.code,
                    isIncoming,
                    payments: exchange.payments,
                    actorId: user.id,
                });
                // Old gold enters Stock (OLD) at what the shop valued it; the
                // new pieces leave Stock (NEW) at WAC.
                for (const line of exchange.oldLines) {
                    await this.stockLedger.postOld(tx, {
                        goldTypeId: line.goldTypeId,
                        businessDayId: day.id,
                        goldInG: (0, domain_1.dec)(line.weightG.toFixed()).mul(line.quantity),
                        priceIn: (0, domain_1.dec)(line.shopBuybackPrice.toFixed()),
                        partnerLabel: 'Cashier',
                        typeLabel: `Exchange ${exchange.code}`,
                        createdById: user.id,
                    });
                }
                const wac = await this.stockLedger.currentWac(tx);
                for (const line of exchange.newLines) {
                    const goldG = (0, domain_1.dec)(line.weightG.toFixed()).mul(line.quantity);
                    await this.stockLedger.postNew(tx, {
                        businessDayId: day.id,
                        goldOutG: goldG,
                        priceOut: goldG.mul(wac.pricePerG),
                        partnerLabel: 'Cashier',
                        typeLabel: `Exchange ${exchange.code}`,
                        createdById: user.id,
                    });
                }
            }
            const updated = await tx.goldExchange.findUniqueOrThrow({ where: { id } });
            await this.audit.record({
                actorId: user.id,
                action: dto.decision === 'APPROVED' ? 'APPROVE' : 'REJECT',
                entity: 'GoldExchange',
                entityId: id,
                before: { status: exchange.status },
                after: { status: next },
                summary: `${dto.decision === 'APPROVED' ? 'ອະນຸມັດ' : 'ປະຕິເສດ'}ລາຍການປ່ຽນເປັນເງິນ ${exchange.code}`,
            }, tx);
            await this.notifications.notify({
                kind: 'APPROVAL_RESULT',
                recipientUserId: exchange.createdById,
                title: dto.decision === 'APPROVED'
                    ? `ລາຍການປ່ຽນເປັນເງິນ ${exchange.code} ຖືກອະນຸມັດ`
                    : `ລາຍການປ່ຽນເປັນເງິນ ${exchange.code} ຖືກປະຕິເສດ`,
                body: dto.reason ?? undefined,
                refType: 'GoldExchange',
                refId: id,
            }, tx);
            return updated;
        });
    }
    /** ຍົກເລີກລາຍການຂະນະທີ່ຍັງ `PENDING` (ກ່ອນ Payment ອະນຸມັດ). */
    async cancel(id, dto, user) {
        const exchange = await this.prisma.goldExchange.findFirst({
            where: { id, deletedAt: null },
        });
        if (!exchange)
            throw new common_1.NotFoundException('ບໍ່ພົບລາຍການ');
        if (exchange.createdById !== user.id &&
            !['PAYMENT', 'ADMIN', 'MANAGER'].includes(user.role)) {
            throw new common_1.ConflictException('ທ່ານບໍ່ມີສິດຍົກເລີກລາຍການນີ້');
        }
        if (exchange.status !== 'PENDING') {
            throw new common_1.ConflictException('ຍົກເລີກໄດ້ສະເພາະລາຍການທີ່ຍັງລໍຖ້າອະນຸມັດ (PENDING)');
        }
        this.approval.assertTransition(exchange.status, 'CANCELLED');
        return this.prisma.$transaction(async (tx) => {
            const claim = await tx.goldExchange.updateMany({
                where: { id, status: 'PENDING', deletedAt: null },
                data: {
                    status: 'CANCELLED',
                    rejectReason: dto.reason?.trim() || exchange.rejectReason || null,
                },
            });
            if (claim.count !== 1) {
                throw new common_1.ConflictException('ສະຖານະລາຍການມີການປ່ຽນແປງແລ້ວ — ກະລຸນາໂຫຼດຄືນ');
            }
            const updated = await tx.goldExchange.findUniqueOrThrow({ where: { id } });
            await this.audit.record({
                actorId: user.id,
                action: 'UPDATE',
                entity: 'GoldExchange',
                entityId: id,
                before: { status: exchange.status },
                after: { status: 'CANCELLED', reason: dto.reason ?? null },
                summary: `ຍົກເລີກລາຍການປ່ຽນເປັນເງິນ ${exchange.code}${dto.reason ? ` (${dto.reason})` : ''}`,
            }, tx);
            if (exchange.createdById !== user.id) {
                await this.notifications.notify({
                    kind: 'APPROVAL_RESULT',
                    recipientUserId: exchange.createdById,
                    title: `ລາຍການປ່ຽນເປັນເງິນ ${exchange.code} ຖືກຍົກເລີກ`,
                    body: dto.reason ?? undefined,
                    refType: 'GoldExchange',
                    refId: id,
                }, tx);
            }
            return updated;
        });
    }
    /** ຊຳລະຍອດຄ້າງຈ່າຍເພີ່ມເຕີມ (`outstandingAmount > 0`). */
    async addPayment(id, dto, user, openShiftId) {
        const exchange = await this.prisma.goldExchange.findFirst({
            where: { id, deletedAt: null },
            include: { shift: { select: { id: true, status: true } } },
        });
        if (!exchange)
            throw new common_1.NotFoundException('ບໍ່ພົບລາຍການ');
        if (exchange.status !== 'APPROVED') {
            throw new common_1.ConflictException('ຊຳລະຄ້າງໄດ້ສະເພາະລາຍການທີ່ອະນຸມັດແລ້ວ');
        }
        const outstanding = (0, domain_1.dec)(exchange.outstandingAmount.toFixed());
        if (outstanding.lte(0)) {
            throw new common_1.BadRequestException('ລາຍການນີ້ບໍ່ມີຍອດຄ້າງຈ່າຍ');
        }
        const isIncoming = (0, domain_1.dec)(exchange.totalPayable.toFixed()).lt(0);
        const signedOutstanding = isIncoming ? outstanding.neg() : outstanding;
        await this.assertBankLegs(dto.payments);
        const context = await this.pricingContext.load();
        const resolved = this.resolvePayments(dto.payments, signedOutstanding, context.rates);
        const effectiveShiftId = openShiftId ?? (exchange.shift.status === 'OPEN' ? exchange.shiftId : undefined);
        if (!effectiveShiftId) {
            throw new common_1.BadRequestException('ຕ້ອງເປີດກະກ່ອນບັນທຶກການຈ່າຍເງິນ');
        }
        const day = await this.businessDay.current();
        return this.prisma.$transaction(async (tx) => {
            const cashShiftId = await this.cash.resolveCounterCashShiftId({
                actor: user,
                openShiftId,
                preferredUserId: exchange.approvedById ?? undefined,
                client: tx,
            });
            const hasCashOrChange = resolved.lines.some((l) => l.method === 'CASH' || (0, domain_1.dec)(l.changeLak).gt(0));
            if (hasCashOrChange && !cashShiftId) {
                throw new common_1.BadRequestException('ກະລຸນາເປີດກະ Payment ແລະ ເບີກເງິນເຂົ້າກະເປົ໋າເງິນສົດ (To Day) ກ່ອນດຳເນີນການເງິນສົດ');
            }
            await this.assertFundsForPosting(resolved.lines, isIncoming, `ການຊຳລະຄ້າງປ່ຽນເປັນເງິນ ${exchange.code}`, cashShiftId, tx);
            const nextPaid = (0, domain_1.dec)(exchange.paidAmount.toFixed()).plus(resolved.appliedLak);
            const nextOutstanding = outstanding.minus(resolved.appliedLak);
            const claim = await tx.goldExchange.updateMany({
                where: {
                    id,
                    status: exchange.status,
                    outstandingAmount: exchange.outstandingAmount,
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
            const createdPayments = await Promise.all(this.toPaymentCreateInput(resolved.lines, user.id).map((p) => tx.exchangePayment.create({ data: { ...p, exchangeId: id } })));
            await this.postCashAndBank(tx, {
                businessDayId: day.id,
                shiftId: cashShiftId ?? effectiveShiftId,
                exchangeId: exchange.id,
                code: exchange.code,
                isIncoming,
                payments: createdPayments,
                actorId: user.id,
            });
            await this.audit.record({
                actorId: user.id,
                action: 'UPDATE',
                entity: 'GoldExchange',
                entityId: id,
                before: { outstandingAmount: outstanding.toFixed(0) },
                after: { outstandingAmount: (nextOutstanding.gt(0) ? nextOutstanding : (0, domain_1.dec)(0)).toFixed(0) },
                summary: `ຊຳລະຄ້າງປ່ຽນເປັນເງິນ ${exchange.code} — ${resolved.appliedLak.toFixed(0)} LAK`,
            }, tx);
            return tx.goldExchange.findUniqueOrThrow({
                where: { id },
                include: this.detailInclude,
            });
        });
    }
    /** Soft delete (ສະເພາະ PENDING / REJECTED / CANCELLED). */
    async remove(id, user) {
        const exchange = await this.prisma.goldExchange.findFirst({
            where: { id, deletedAt: null },
        });
        if (!exchange)
            throw new common_1.NotFoundException('ບໍ່ພົບລາຍການ');
        this.assertCreatorOrManager(exchange.createdById, user, 'ມີພຽງຜູ້ສ້າງລາຍການ ຫຼື ຜູ້ຈັດການ ເທົ່ານັ້ນທີ່ລຶບໄດ້');
        if (!['PENDING', 'REJECTED', 'CANCELLED'].includes(exchange.status)) {
            throw new common_1.ConflictException('ລຶບໄດ້ສະເພາະລາຍການທີ່ຍັງບໍ່ອະນຸມັດ, ຖືກປະຕິເສດ ຫຼື ຍົກເລີກ');
        }
        return this.prisma.$transaction(async (tx) => {
            const claim = await tx.goldExchange.updateMany({
                where: { id, status: exchange.status, deletedAt: null },
                data: { deletedAt: new Date(), deletedById: user.id },
            });
            if (claim.count !== 1) {
                throw new common_1.ConflictException('ສະຖານະລາຍການມີການປ່ຽນແປງແລ້ວ — ກະລຸນາໂຫຼດຄືນ');
            }
            await this.audit.record({
                actorId: user.id,
                action: 'DELETE',
                entity: 'GoldExchange',
                entityId: id,
                before: { code: exchange.code, status: exchange.status },
                summary: `ລຶບລາຍການປ່ຽນເປັນເງິນ ${exchange.code}`,
            }, tx);
            return { id, deleted: true };
        });
    }
    async list(status, query, user) {
        const range = this.range.resolve(query, user);
        const timeWin = this.range.resolveTimeWindow(range, query);
        const q = query.search?.trim();
        const where = {
            deletedAt: null,
            createdAt: timeWin ?? history_range_service_1.HistoryRangeService.window(range),
            ...(status ? { status } : {}),
            ...(query.txnType ? { txnType: query.txnType } : {}),
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
            this.prisma.goldExchange.findMany({
                where,
                include: this.detailInclude,
                orderBy: { createdAt: 'desc' },
                skip: range.skip,
                take: range.take,
            }),
            this.prisma.goldExchange.count({ where }),
        ]);
        // TOR History tables carry UPDATED BY.
        return this.range.page(await this.audit.withActorNames(rows), total, range);
    }
    async getOne(id, _user) {
        const row = await this.prisma.goldExchange.findFirst({
            where: { id, deletedAt: null },
            include: this.detailInclude,
        });
        if (!row)
            throw new common_1.NotFoundException('ບໍ່ພົບລາຍການ');
        const [withActors] = await this.audit.withActorNames([row]);
        const audits = await this.audit.forEntity('GoldExchange', id);
        return { ...withActors, audits };
    }
    /* ---------------------------------------------------------------- *
     * Helpers
     * ---------------------------------------------------------------- */
    assertCreatorOrManager(createdById, user, message) {
        if (createdById !== user.id && !['ADMIN', 'MANAGER'].includes(user.role)) {
            throw new common_1.ConflictException(message);
        }
    }
    /** ສົດ ຕັດຈາກລີ້ນຊັກ, ໂອນ ຕັດຈາກບັນຊີທີ່ລະບຸ — ກວດແຕ່ລະແຖວແຍກກັນ. */
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
    /**
     * Resolve all payment legs together:
     * - `totalPayable > 0`: shop pays out (`buyback` rate, LAK legs cannot exceed payable)
     * - `totalPayable < 0`: customer pays shop (`sell` rate, change in LAK if overpaid)
     * - `totalPayable === 0`: no cash movement expected
     */
    resolvePayments(lines, totalPayable, rates) {
        if (totalPayable.eq(0)) {
            if (lines.length > 0) {
                throw new common_1.BadRequestException('ລາຍການນີ້ມູນຄ່າເທົ່າ 0 — ບໍ່ຕ້ອງປ້ອນການຈ່າຍເງິນ');
            }
            return { lines: [], totalLak: (0, domain_1.dec)(0), changeLak: (0, domain_1.dec)(0), appliedLak: (0, domain_1.dec)(0), outstandingAmount: (0, domain_1.dec)(0) };
        }
        const isIncoming = totalPayable.lt(0);
        const owedLak = totalPayable.abs();
        const rateDirection = isIncoming ? 'sell' : 'buyback';
        let lakLegsTotal = (0, domain_1.dec)(0);
        let foreignLakTotal = (0, domain_1.dec)(0);
        let hasCashLakLeg = false;
        const resolved = lines.map((line) => {
            if (line.method === 'BANK' && !line.bankAccountId) {
                throw new common_1.BadRequestException('ກະລຸນາເລືອກທະນາຄານ');
            }
            const rawAmount = (0, domain_1.dec)(line.amount);
            if (!rawAmount.isFinite() || rawAmount.lte(0)) {
                throw new common_1.BadRequestException('ຈຳນວນເງິນຕ້ອງໃຫຍ່ກວ່າ 0');
            }
            const isCashLak = line.method === 'CASH' && line.currency === 'LAK';
            const amount = isCashLak ? (0, domain_1.roundDownCashLak)(rawAmount) : rawAmount;
            if (amount.lte(0)) {
                throw new common_1.BadRequestException('ຈຳນວນເງິນສົດ LAK ຕ້ອງຢ່າງໜ້ອຍ 500 LAK');
            }
            if (isCashLak)
                hasCashLakLeg = true;
            const rate = pricing_context_service_1.PricingContextService.rateFor(rates, line.currency, rateDirection);
            const amountLak = amount.mul(rate);
            if (line.currency === 'LAK') {
                lakLegsTotal = lakLegsTotal.plus(amount);
            }
            else {
                foreignLakTotal = foreignLakTotal.plus(amountLak);
            }
            return { ...line, rate, amount, amountLak, changeLak: (0, domain_1.dec)(0) };
        });
        if (!isIncoming) {
            if (lakLegsTotal.gt(owedLak)) {
                throw new common_1.BadRequestException(`ຈຳນວນເງິນ LAK (${lakLegsTotal.toFixed(0)}) ຕ້ອງບໍ່ເກີນລວມເງິນທີ່ຕ້ອງຈ່າຍ (${owedLak.toFixed(0)})`);
            }
            if (lakLegsTotal.gt(0) && foreignLakTotal.gte(owedLak)) {
                throw new common_1.BadRequestException('ຍອດສະກຸນເງິນຕ່າງປະເທດຄົບຍອດແລ້ວ ບໍ່ຄວນຈ່າຍ LAK ເພີ່ມ');
            }
        }
        const totalLak = lakLegsTotal.plus(foreignLakTotal);
        const settlement = (0, domain_1.resolveCashLakSettlement)(owedLak, totalLak, hasCashLakLeg);
        const changeLak = settlement.changeLak;
        if (changeLak.gt(0) && resolved.length > 0) {
            let targetIdx = resolved.length - 1;
            for (let idx = resolved.length - 1; idx >= 0; idx--) {
                if (resolved[idx].currency !== 'LAK') {
                    targetIdx = idx;
                    break;
                }
            }
            resolved[targetIdx].changeLak = changeLak;
        }
        return {
            lines: resolved,
            totalLak,
            changeLak,
            appliedLak: settlement.appliedLak,
            outstandingAmount: settlement.remainingLak,
        };
    }
    toPaymentCreateInput(lines, actorId) {
        return lines.map((line) => ({
            method: line.method,
            bankAccountId: line.bankAccountId ?? null,
            currency: line.currency,
            rate: D(line.rate),
            amount: D(line.amount),
            amountLak: D(line.amountLak),
            changeLak: D(line.changeLak),
            createdById: actorId,
        }));
    }
    async assertFundsForPosting(payments, isIncoming, labelLo, shiftId, client) {
        if (!isIncoming) {
            await this.cash.assertShiftWalletAndBankFunds(shiftId, payments, labelLo, { client });
            return;
        }
        const changeTotal = payments.reduce((sum, p) => {
            const raw = typeof p.changeLak === 'object' && p.changeLak !== null && 'toFixed' in p.changeLak
                ? p.changeLak.toFixed()
                : p.changeLak;
            return sum.plus((0, domain_1.dec)(raw));
        }, (0, domain_1.dec)(0));
        if (changeTotal.gt(0)) {
            await this.cash.assertShiftWalletAndBankFunds(shiftId, [{ method: 'CASH', currency: 'LAK', amount: changeTotal }], `ເງິນທອນ ${labelLo}`, { client });
        }
    }
    async postCashAndBank(tx, input) {
        const cashType = input.isIncoming ? 'IN' : 'OUT';
        const bankType = input.isIncoming ? 'DEPOSIT' : 'WITHDRAW';
        const changeCashType = input.isIncoming ? 'OUT' : 'IN';
        for (const payment of input.payments) {
            if (payment.method === 'CASH') {
                await tx.cashTransaction.create({
                    data: {
                        businessDayId: input.businessDayId,
                        shiftId: input.shiftId,
                        type: cashType,
                        currency: payment.currency,
                        amount: payment.amount,
                        refType: 'GoldExchange',
                        refId: input.exchangeId,
                        note: `${input.isIncoming ? 'ຮັບ' : 'ຈ່າຍ'}ປ່ຽນເປັນເງິນ ${input.code}`,
                        createdById: input.actorId,
                    },
                });
            }
            else {
                if (!payment.bankAccountId) {
                    throw new common_1.BadRequestException(`ແຖວຈ່າຍແບບໂອນຂອງ ${input.code} ບໍ່ມີບັນຊີທະນາຄານ — ອະນຸມັດບໍ່ໄດ້`);
                }
                await tx.bankTransaction.create({
                    data: {
                        businessDayId: input.businessDayId,
                        bankAccountId: payment.bankAccountId,
                        type: bankType,
                        currency: payment.currency,
                        amount: payment.amount,
                        refType: 'GoldExchange',
                        refId: input.exchangeId,
                        note: `${input.isIncoming ? 'ຮັບ' : 'ຈ່າຍ'}ປ່ຽນເປັນເງິນ ${input.code}`,
                        createdById: input.actorId,
                    },
                });
            }
            if ((0, domain_1.dec)(payment.changeLak.toFixed()).gt(0)) {
                await tx.cashTransaction.create({
                    data: {
                        businessDayId: input.businessDayId,
                        shiftId: input.shiftId,
                        type: changeCashType,
                        currency: 'LAK',
                        amount: payment.changeLak,
                        refType: 'GoldExchange',
                        refId: input.exchangeId,
                        note: `ເງິນທອນປ່ຽນເປັນເງິນ ${input.code}`,
                        createdById: input.actorId,
                    },
                });
            }
        }
    }
    async nextCode(tx) {
        const now = new Date();
        const prefix = `EX-${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
        const count = await tx.goldExchange.count({ where: { code: { startsWith: prefix } } });
        return `${prefix}-${String(count + 1).padStart(3, '0')}`;
    }
};
exports.ExchangeService = ExchangeService;
exports.ExchangeService = ExchangeService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        audit_service_1.AuditService,
        approval_service_1.ApprovalService,
        business_day_service_1.BusinessDayService,
        stock_ledger_service_1.StockLedgerService,
        cash_service_1.CashService,
        fees_service_1.FeesService,
        notifications_service_1.NotificationsService,
        pricing_context_service_1.PricingContextService,
        history_range_service_1.HistoryRangeService])
], ExchangeService);
//# sourceMappingURL=exchange.service.js.map