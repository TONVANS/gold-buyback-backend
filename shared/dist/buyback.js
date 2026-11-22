import { Decimal, dec } from './decimal.js';
import { ceilingTo, isMultipleOf, roundDown } from './rounding.js';
import { GRAMS_PER_BAHT } from './constants.js';
/**
 * Build a lookup table from a price board's buyback column.
 * `weightG` must be the tier's exchange weight (1.875), not its display
 * weight (1.87), or exact matches will silently miss.
 */
export function makePriceTable(entries) {
    return [...entries].sort((a, b) => b.weightG.comparedTo(a.weightG));
}
/** Exact-weight lookup used by all three of the TOR's named tables. */
export function lookupExact(table, weightG) {
    const hit = table.find((entry) => entry.weightG.eq(weightG));
    return hit ? hit.buybackPrice : null;
}
/**
 * PriceMatchExact — the smallest tier weight at or above `weightG`.
 *
 * This is Excel's `MATCH(w, tiers, -1)` against a descending list, and it is
 * what makes a slightly-light piece priceable at all: 14.99 g of ຄຳຫຍຸບ is
 * quoted at the 15 g price, and the shortfall comes off separately as ຄ່າອ່ອນ.
 * An exact match here would find nothing and pay the customer zero.
 */
export function lookupAtLeast(table, weightG) {
    let best = null;
    for (const entry of table) {
        if (entry.weightG.gte(weightG) && (best === null || entry.weightG.lt(best.weightG))) {
            best = entry;
        }
    }
    return best;
}
/**
 * ລາຄາຊື້ຄືນໜ້າຮ້ານ — ກໍລະນີ 1, ຄຳຮ້ານ KPV (TOR §5.1).
 *
 * The TOR is explicit that any error or missing weight yields 0 rather than
 * throwing, so a mistyped weight can never quietly become a large payout.
 */
export function shopBuybackPriceKpv(kind, weightG, source, table) {
    const w = dec(weightG);
    if (!w.isFinite() || w.lte(0))
        return { price: dec(0), branch: 'ນ້ຳໜັກເປັນ 0' };
    const price1Baht = source.price1BahtFor(kind);
    switch (kind) {
        // 2.1 ຄໍາດີ
        case 'GOOD': {
            if (isMultipleOf(w, GRAMS_PER_BAHT)) {
                return {
                    price: w.div(GRAMS_PER_BAHT).mul(price1Baht),
                    branch: 'ຄຳດີ — ຫານ 15 ລົງໂຕ',
                };
            }
            // PriceByMatch: an exact tier weight, or nothing. The workbook does not
            // decompose a part-baht piece into whole baht plus a remainder — a
            // weight that is neither a multiple of 15 nor a listed tier is refused
            // (its IFERROR yields 0) rather than priced by a rule nobody agreed to.
            const exact = source.lookup(kind, w);
            return exact === null
                ? { price: dec(0), branch: 'ຄຳດີ — ບໍ່ຕົງຕາຕະລາງ ແລະ ຫານ 15 ບໍ່ລົງໂຕ' }
                : { price: exact, branch: 'ຄຳດີ — PriceByMatch (ຕົງກັບຕາຕະລາງ)' };
        }
        // 2.2 ຄໍາຫຍຸບ
        case 'HUMP': {
            if (w.gt(GRAMS_PER_BAHT)) {
                // ປັດເສດຂຶ້ນໃຫ້ເປັນຈຳນວນເຕັມ 15 ບາດ ແລ້ວຄູນ Price1Baht
                const wholeBaht = ceilingTo(w, GRAMS_PER_BAHT).div(GRAMS_PER_BAHT);
                return { price: wholeBaht.mul(price1Baht), branch: 'ຄຳຫຍຸບ — CEILING ເປັນບາດເຕັມ' };
            }
            const tier = lookupAtLeast(table, w);
            return tier === null
                ? { price: dec(0), branch: 'ຄຳຫຍຸບ — ບໍ່ພົບໃນ PriceMatchExact' }
                : { price: tier.buybackPrice, branch: 'ຄຳຫຍຸບ — PriceMatchExact (ຂັ້ນທີ່ ≥ ນ້ຳໜັກ)' };
        }
        // 2.3 ຄໍາແທ່ງ
        case 'BAR': {
            if (w.gte(GRAMS_PER_BAHT)) {
                // A bar that is not a whole number of baht cannot be priced at all.
                if (!isMultipleOf(w, GRAMS_PER_BAHT)) {
                    return { price: dec(0), branch: 'ຄຳແທ່ງ — ຫານ 15 ບໍ່ລົງໂຕ' };
                }
                return {
                    price: w.div(GRAMS_PER_BAHT).mul(price1Baht),
                    branch: 'ຄຳແທ່ງ — ຫານ 15 ລົງໂຕ',
                };
            }
            const exact = source.lookup(kind, w);
            return exact === null
                ? { price: dec(0), branch: 'ຄຳແທ່ງ — ບໍ່ພົບໃນ PriceMatch' }
                : { price: exact, branch: 'ຄຳແທ່ງ — PriceMatch' };
        }
    }
}
/**
 * How many 0.1 g steps a shortfall is billed at for KPV ຄຳຫຍຸບ buyback.
 * Any non-zero shortfall (even 0.003 g) rounds UP to a 0.1 g step so the shop
 * never waives real weight loss.
 */
export function softGoldStepsBuyback(shortfallG) {
    const s = dec(shortfallG);
    if (!s.isFinite() || s.lte(0))
        return dec(0);
    return s.div('0.1').toDecimalPlaces(0, Decimal.ROUND_UP);
}
/**
 * Automatic ຫັກຄ່າຄຳອ່ອນ/ຊິ້ນ for KPV ຄຳຫຍຸບ:
 * - Finds the full standard weight at or above `weightG` (display tiers <= 15 g
 *   or CEILING to 15 g multiples when > 15 g).
 * - Subtracts the entered weight to get the shortfall.
 * - Rounds any shortfall UP to 0.1 g steps (0.003 -> 0.1 -> 1 step) and
 *   multiplies by `softGoldFeePerUnit` (from Module ຄ່າອ່ອນ, e.g. 400,000).
 */
export function computeHumpSoftGoldDeduction(weightG, softGoldFeePerUnit, table) {
    const w = dec(weightG);
    const fee = dec(softGoldFeePerUnit);
    if (!w.isFinite() || w.lte(0) || !fee.isFinite() || fee.lte(0)) {
        return { fullWeightG: dec(0), shortfallG: dec(0), deduction: dec(0) };
    }
    let fullWeightG;
    if (w.gt(GRAMS_PER_BAHT)) {
        fullWeightG = ceilingTo(w, GRAMS_PER_BAHT);
    }
    else {
        const tier = lookupAtLeast(table, w);
        if (!tier)
            return { fullWeightG: dec(0), shortfallG: dec(0), deduction: dec(0) };
        fullWeightG = tier.weightG;
    }
    const shortfallG = fullWeightG.minus(w);
    if (shortfallG.lte(0)) {
        return { fullWeightG, shortfallG: dec(0), deduction: dec(0) };
    }
    const deduction = softGoldStepsBuyback(shortfallG).mul(fee);
    return { fullWeightG, shortfallG, deduction };
}
/**
 * ລາຄາຊື້ຄືນໜ້າຮ້ານ — ກໍລະນີ 2, ຄຳຮ້ານອື່ນ / ຄຳຕົ້ມ:
 * uses ລາຄາຊື້ຄືນ ຮູບປະພັນ-1ບາດ directly for all weights.
 */
export function shopBuybackPriceBoiled(weightG, source, _table) {
    const w = dec(weightG);
    if (!w.isFinite() || w.lte(0))
        return { price: dec(0), branch: 'ນ້ຳໜັກເປັນ 0' };
    const price1Baht = source.price1BahtFor('BOILED');
    return {
        price: price1Baht,
        branch: 'ຄຳຕົ້ມ — ນ້ຳໜັກ × %ຄຳ ÷ 15 × ລາຄາ 1 ບາດ',
    };
}
/**
 * ລາຄາທີ່ຕ້ອງຈ່າຍ for ຄຳຕົ້ມ (ກໍລະນີ 2, ຄຳຮ້ານອື່ນ):
 *
 *   (ນ້ຳໜັກ(g) × %ຄຳ / 15 × ລາຄາຊື້ຄືນ ຮູບປະພັນ-1ບາດ)
 *     -> ROUNDDOWN(..., -3) -> × ຈຳນວນຊິ້ນ
 */
export function payableBoiled(weightG, price1Baht, goldPercent, quantity) {
    const w = dec(weightG);
    if (!w.isFinite() || w.lte(0))
        return dec(0);
    const perPiece = w
        .mul(dec(goldPercent).div(100))
        .div(GRAMS_PER_BAHT)
        .mul(dec(price1Baht));
    return roundDown(perPiece, -3).mul(dec(quantity));
}
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
export function calculateBuyback(input, source, table) {
    const quantity = dec(input.quantity);
    if (input.kind === 'BOILED') {
        const { price, branch } = shopBuybackPriceBoiled(input.weightG, source, table);
        const payable = payableBoiled(input.weightG, price, input.goldPercent ?? 0, quantity);
        return {
            shopBuybackPrice: price,
            deduction: dec(0),
            payableAmount: payable.isNegative() ? dec(0) : payable,
            branch,
        };
    }
    const { price, branch } = shopBuybackPriceKpv(input.kind, input.weightG, source, table);
    const deduction = input.kind === 'HUMP' && price.gt(0)
        ? computeHumpSoftGoldDeduction(input.weightG, input.softGoldFeePerUnit ?? 0, table).deduction
        : dec(0);
    const perPiece = price.minus(deduction);
    const payable = perPiece.isNegative() ? dec(0) : perPiece.mul(quantity);
    return { shopBuybackPrice: price, deduction, payableAmount: payable, branch };
}
//# sourceMappingURL=buyback.js.map