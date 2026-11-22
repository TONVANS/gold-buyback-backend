import { Decimal, type Numeric } from './decimal.js';
/** The four ປະເພດຄຳ that can be bought back over the counter. */
export type BuybackGoldKind = 'GOOD' | 'HUMP' | 'BAR' | 'BOILED';
/**
 * One row of the weight -> price lookup the TOR calls PriceByMatch,
 * PriceMatchExact or PriceMatch depending on the branch.
 *
 * Settled against the shop's workbook: all three names are the SAME data —
 * the buyback price column of the price board, keyed by the printed weight
 * (Produets column B: 15, 7.5, 3.75, 1.87, 1.12, 0.75, 0.37). What differs
 * between them is only the match mode:
 *
 *   PriceByMatch      (ຄຳດີ)   exact weight, else nothing
 *   PriceMatchExact   (ຄຳຫຍຸບ) smallest tier AT OR ABOVE the weight
 *   PriceMatch        (ຄຳແທ່ງ) exact weight in the bar table
 *
 * Note the key is the printed 1.87, not the 1.875 that keys the ຄ່າປ່ຽນ table.
 */
export interface PriceTableEntry {
    tierCode: string;
    /** ນ້ຳໜັກປ່ຽນເປັນເງິນ — the exact weight, e.g. 1.875 not 1.87. */
    weightG: Decimal;
    buybackPrice: Decimal;
}
export interface BuybackPriceSource {
    /**
     * ລາຄາຊື້ຄືນ 1 ບາດ for this kind of gold.
     *
     * The TOR writes only "Price1Baht"; the workbook resolves it to the BUYBACK
     * 1-baht price, which is what the shop pays out — the jewellery one for
     * ຄຳດີ / ຄຳຫຍຸບ / ຄຳຕົ້ມ, the bar one for ຄຳແທ່ງ.
     */
    price1BahtFor(kind: BuybackGoldKind): Decimal;
    /** Exact weight match in the relevant price table; null when absent. */
    lookup(kind: BuybackGoldKind, weightG: Decimal): Decimal | null;
}
export interface BuybackInput {
    kind: BuybackGoldKind;
    weightG: Numeric;
    quantity: Numeric;
    /** %ຄຳ in percent units (96 means 96%). ຄຳຕົ້ມ only. */
    goldPercent?: Numeric;
    /**
     * ຄ່າອ່ອນ per 0.1 g shortfall step (from Module ຄ່າອ່ອນ, e.g. 400,000 LAK).
     * Applied automatically when `kind === 'HUMP'`.
     */
    softGoldFeePerUnit?: Numeric;
    /** @deprecated Deduction is now auto-computed for HUMP and 0 for GOOD/BAR. */
    deduction?: Numeric;
}
export interface BuybackResult {
    /** ລາຄາຊື້ຄືນໜ້າຮ້ານ — the price for ONE piece. */
    shopBuybackPrice: Decimal;
    /** ຄ່າຫັກ/ຄ່າອ່ອນ applied per piece. */
    deduction: Decimal;
    /** ລາຄາທີ່ຕ້ອງຈ່າຍ — the total across `quantity`. */
    payableAmount: Decimal;
    /**
     * Which branch of §5.1 produced the number. Surfaced in the UI and the
     * audit log so a disputed price can be traced without re-deriving it.
     */
    branch: string;
}
/**
 * Build a lookup table from a price board's buyback column.
 * `weightG` must be the tier's exchange weight (1.875), not its display
 * weight (1.87), or exact matches will silently miss.
 */
export declare function makePriceTable(entries: PriceTableEntry[]): PriceTableEntry[];
/** Exact-weight lookup used by all three of the TOR's named tables. */
export declare function lookupExact(table: PriceTableEntry[], weightG: Decimal): Decimal | null;
/**
 * PriceMatchExact — the smallest tier weight at or above `weightG`.
 *
 * This is Excel's `MATCH(w, tiers, -1)` against a descending list, and it is
 * what makes a slightly-light piece priceable at all: 14.99 g of ຄຳຫຍຸບ is
 * quoted at the 15 g price, and the shortfall comes off separately as ຄ່າອ່ອນ.
 * An exact match here would find nothing and pay the customer zero.
 */
export declare function lookupAtLeast(table: PriceTableEntry[], weightG: Decimal): PriceTableEntry | null;
/**
 * ລາຄາຊື້ຄືນໜ້າຮ້ານ — ກໍລະນີ 1, ຄຳຮ້ານ KPV (TOR §5.1).
 *
 * The TOR is explicit that any error or missing weight yields 0 rather than
 * throwing, so a mistyped weight can never quietly become a large payout.
 */
export declare function shopBuybackPriceKpv(kind: Exclude<BuybackGoldKind, 'BOILED'>, weightG: Numeric, source: BuybackPriceSource, table: PriceTableEntry[]): {
    price: Decimal;
    branch: string;
};
/**
 * How many 0.1 g steps a shortfall is billed at for KPV ຄຳຫຍຸບ buyback.
 * Any non-zero shortfall (even 0.003 g) rounds UP to a 0.1 g step so the shop
 * never waives real weight loss.
 */
export declare function softGoldStepsBuyback(shortfallG: Numeric): Decimal;
/**
 * Automatic ຫັກຄ່າຄຳອ່ອນ/ຊິ້ນ for KPV ຄຳຫຍຸບ:
 * - Finds the full standard weight at or above `weightG` (display tiers <= 15 g
 *   or CEILING to 15 g multiples when > 15 g).
 * - Subtracts the entered weight to get the shortfall.
 * - Rounds any shortfall UP to 0.1 g steps (0.003 -> 0.1 -> 1 step) and
 *   multiplies by `softGoldFeePerUnit` (from Module ຄ່າອ່ອນ, e.g. 400,000).
 */
export declare function computeHumpSoftGoldDeduction(weightG: Numeric, softGoldFeePerUnit: Numeric, table: PriceTableEntry[]): {
    fullWeightG: Decimal;
    shortfallG: Decimal;
    deduction: Decimal;
};
/**
 * ລາຄາຊື້ຄືນໜ້າຮ້ານ — ກໍລະນີ 2, ຄຳຮ້ານອື່ນ / ຄຳຕົ້ມ:
 * uses ລາຄາຊື້ຄືນ ຮູບປະພັນ-1ບາດ directly for all weights.
 */
export declare function shopBuybackPriceBoiled(weightG: Numeric, source: BuybackPriceSource, _table?: PriceTableEntry[]): {
    price: Decimal;
    branch: string;
};
/**
 * ລາຄາທີ່ຕ້ອງຈ່າຍ for ຄຳຕົ້ມ (ກໍລະນີ 2, ຄຳຮ້ານອື່ນ):
 *
 *   (ນ້ຳໜັກ(g) × %ຄຳ / 15 × ລາຄາຊື້ຄືນ ຮູບປະພັນ-1ບາດ)
 *     -> ROUNDDOWN(..., -3) -> × ຈຳນວນຊິ້ນ
 */
export declare function payableBoiled(weightG: Numeric, price1Baht: Numeric, goldPercent: Numeric, quantity: Numeric): Decimal;
/**
 * The whole §5.1 calculation for one buyback line.
 *
 * - BOILED (ຄຳຮ້ານອື່ນ): `ນ້ຳໜັກ × %ຄຳ ÷ 15 × ລາຄາ 1 ບາດ`, rounded down to 1,000 LAK per piece.
 * - HUMP (ຄຳຫຍຸບ): auto-deducts ຫັກຄ່າຄຳອ່ອນ/ຊິ້ນ from `softGoldFeePerUnit`.
 * - GOOD / BAR (ຄຳດີ / ຄຳແທ່ງ): no deduction (`0`).
 *
 * A negative result is clamped to zero — the shop never charges a customer
 * to take gold off them.
 */
export declare function calculateBuyback(input: BuybackInput, source: BuybackPriceSource, table: PriceTableEntry[]): BuybackResult;
//# sourceMappingURL=buyback.d.ts.map