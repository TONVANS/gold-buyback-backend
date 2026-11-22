import DecimalJs from 'decimal.js';
import { Decimal, dec } from './decimal.js';
/**
 * Excel-compatible rounding primitives.
 *
 * The TOR specifies prices in terms of the spreadsheet functions the shop
 * already uses (ROUND, ROUNDUP, ROUNDDOWN, CEILING). These helpers reproduce
 * those exactly, including the sign handling, so a formula can be transcribed
 * from the TOR without reinterpretation.
 *
 * `digits` follows the Excel convention:
 *   digits =  2  -> nearest 0.01
 *   digits =  0  -> nearest whole number
 *   digits = -3  -> nearest 1,000   (ຫຼັກພັນ)
 *   digits = -4  -> nearest 10,000  (ຫຼັກໝື່ນ)
 */
function scale(digits) {
    return Decimal.pow(10, digits);
}
function applyAt(value, digits, mode) {
    const factor = scale(digits);
    return dec(value).mul(factor).toDecimalPlaces(0, mode).div(factor);
}
/**
 * Excel ROUND — nearest, ties away from zero.
 * `round(11_462_500, -4)` -> 11_460_000
 */
export function round(value, digits = 0) {
    return applyAt(value, digits, DecimalJs.ROUND_HALF_UP);
}
/**
 * Excel ROUNDUP — always away from zero.
 * `roundUp(3_170_000, -3)` -> 3_170_000 ; `roundUp(3_170_001, -3)` -> 3_171_000
 */
export function roundUp(value, digits = 0) {
    return applyAt(value, digits, DecimalJs.ROUND_UP);
}
/**
 * Excel ROUNDDOWN — always toward zero (truncate at `digits`).
 * `roundDown(3_014_666.67, -3)` -> 3_014_000
 */
export function roundDown(value, digits = 0) {
    return applyAt(value, digits, DecimalJs.ROUND_DOWN);
}
/**
 * Excel CEILING(number, significance) — away from zero to the nearest
 * multiple of `significance`.
 *
 * Used by TOR §5.1 to bill part-baht weights as whole 15 g units:
 * `ceilingTo(20, 15)` -> 30 ; `ceilingTo(1.33, 1)` -> 2
 *
 * `significance` of zero returns zero, matching Excel.
 */
export function ceilingTo(value, significance) {
    const sig = dec(significance);
    if (sig.isZero())
        return dec(0);
    return dec(value).div(sig).toDecimalPlaces(0, DecimalJs.ROUND_UP).mul(sig);
}
/**
 * Excel FLOOR(number, significance) — toward zero to the nearest multiple.
 */
export function floorTo(value, significance) {
    const sig = dec(significance);
    if (sig.isZero())
        return dec(0);
    return dec(value).div(sig).toDecimalPlaces(0, DecimalJs.ROUND_DOWN).mul(sig);
}
/**
 * True when `value` divides evenly by `divisor` — TOR §5.1 "ຫານ 15 ລົງໂຕ".
 */
export function isMultipleOf(value, divisor) {
    const d = dec(divisor);
    if (d.isZero())
        return false;
    return dec(value).mod(d).isZero();
}
/**
 * Truncate toward zero at `dp` decimal places without any rounding —
 * TOR §7.2 "ຕັດເສດຫຼັງຈຸດ" when deriving ລາຄາ/g from a gold-type cost.
 */
export function truncate(value, dp = 0) {
    return dec(value).toDecimalPlaces(dp, DecimalJs.ROUND_DOWN);
}
/**
 * Smallest physical LAK cash denomination accepted/paid out by the shop (500 LAK):
 *   0 .. 499   ->   0   (e.g. 128,300 -> 128,000)
 *   500 .. 999 -> 500   (e.g. 128,900 -> 128,500)
 */
export const LAK_CASH_STEP = dec(500);
/** Round a LAK cash amount DOWN to the nearest 500 LAK note. */
export function roundDownCashLak(amount) {
    const a = dec(amount);
    if (!a.isFinite() || a.lte(0))
        return dec(0);
    return floorTo(a, LAK_CASH_STEP);
}
/**
 * Resolve LAK cash settlement for Exchange / Buyback / Credit:
 * - Physical LAK cash change (`totalLak > owedLak`) is rounded DOWN to 500 LAK.
 * - When a transaction includes a `CASH` + `LAK` leg and the remaining shortfall
 *   is strictly below 500 LAK (`0 < owedLak - totalLak < 500`), that unpayable
 *   fraction is waived so the bill settles cleanly (`remainingLak = 0`).
 */
export function resolveCashLakSettlement(owedLak, totalLak, hasCashLakLeg) {
    const owed = dec(owedLak);
    const total = dec(totalLak);
    const rawChange = total.gt(owed) ? total.minus(owed) : dec(0);
    const changeLak = roundDownCashLak(rawChange);
    const rawRemaining = owed.gt(total) ? owed.minus(total) : dec(0);
    const cashRounded = hasCashLakLeg && rawRemaining.gt(0) && rawRemaining.lt(LAK_CASH_STEP);
    const remainingLak = cashRounded ? dec(0) : rawRemaining;
    const appliedLak = cashRounded
        ? owed
        : total.gt(owed)
            ? owed
            : total;
    return { changeLak, cashRounded, remainingLak, appliedLak };
}
/**
 * Resolve LAK settlement for Buyback across ALL currencies (LAK, THB, USD)
 * and ALL methods (CASH, BANK):
 * - Total paid (LAK equivalent) must be <= `owedLak` (enforced by caller).
 * - Any remaining shortfall is rounded DOWN to 500 LAK steps:
 *     0 .. 499   ->   0   (waived completely)
 *     500 .. 999 -> 500   (e.g. 501..999 adjusted down to 500)
 *     1,001..1,499 -> 1,000, etc.
 */
export function resolveBuybackLakSettlement(owedLak, totalLak) {
    const owed = dec(owedLak);
    const total = dec(totalLak);
    const rawChange = total.gt(owed) ? total.minus(owed) : dec(0);
    const changeLak = roundDownCashLak(rawChange);
    const rawRemaining = owed.gt(total) ? owed.minus(total) : dec(0);
    const remainingLak = roundDownCashLak(rawRemaining);
    const cashRounded = rawRemaining.gt(remainingLak);
    const appliedLak = total.gt(owed) ? owed : owed.minus(remainingLak);
    return { changeLak, cashRounded, remainingLak, appliedLak };
}
//# sourceMappingURL=rounding.js.map