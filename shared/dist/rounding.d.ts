import DecimalJs from 'decimal.js';
import { Decimal, type Numeric } from './decimal.js';
/**
 * Excel ROUND — nearest, ties away from zero.
 * `round(11_462_500, -4)` -> 11_460_000
 */
export declare function round(value: Numeric, digits?: number): Decimal;
/**
 * Excel ROUNDUP — always away from zero.
 * `roundUp(3_170_000, -3)` -> 3_170_000 ; `roundUp(3_170_001, -3)` -> 3_171_000
 */
export declare function roundUp(value: Numeric, digits?: number): Decimal;
/**
 * Excel ROUNDDOWN — always toward zero (truncate at `digits`).
 * `roundDown(3_014_666.67, -3)` -> 3_014_000
 */
export declare function roundDown(value: Numeric, digits?: number): Decimal;
/**
 * Excel CEILING(number, significance) — away from zero to the nearest
 * multiple of `significance`.
 *
 * Used by TOR §5.1 to bill part-baht weights as whole 15 g units:
 * `ceilingTo(20, 15)` -> 30 ; `ceilingTo(1.33, 1)` -> 2
 *
 * `significance` of zero returns zero, matching Excel.
 */
export declare function ceilingTo(value: Numeric, significance: Numeric): Decimal;
/**
 * Excel FLOOR(number, significance) — toward zero to the nearest multiple.
 */
export declare function floorTo(value: Numeric, significance: Numeric): Decimal;
/**
 * True when `value` divides evenly by `divisor` — TOR §5.1 "ຫານ 15 ລົງໂຕ".
 */
export declare function isMultipleOf(value: Numeric, divisor: Numeric): boolean;
/**
 * Truncate toward zero at `dp` decimal places without any rounding —
 * TOR §7.2 "ຕັດເສດຫຼັງຈຸດ" when deriving ລາຄາ/g from a gold-type cost.
 */
export declare function truncate(value: Numeric, dp?: number): Decimal;
/**
 * Smallest physical LAK cash denomination accepted/paid out by the shop (500 LAK):
 *   0 .. 499   ->   0   (e.g. 128,300 -> 128,000)
 *   500 .. 999 -> 500   (e.g. 128,900 -> 128,500)
 */
export declare const LAK_CASH_STEP: DecimalJs;
/** Round a LAK cash amount DOWN to the nearest 500 LAK note. */
export declare function roundDownCashLak(amount: Numeric): Decimal;
export interface CashLakSettlement {
    /** Change in physical LAK cash, rounded down to the nearest 500 LAK. */
    changeLak: Decimal;
    /** True when a shortfall < 500 LAK was absorbed by cash rounding. */
    cashRounded: boolean;
    /** Remaining unpaid balance after cash rounding (`0` when `cashRounded`). */
    remainingLak: Decimal;
    /** Amount applied against `owedLak` (`owedLak` when `cashRounded` or overpaid). */
    appliedLak: Decimal;
}
/**
 * Resolve LAK cash settlement for Exchange / Buyback / Credit:
 * - Physical LAK cash change (`totalLak > owedLak`) is rounded DOWN to 500 LAK.
 * - When a transaction includes a `CASH` + `LAK` leg and the remaining shortfall
 *   is strictly below 500 LAK (`0 < owedLak - totalLak < 500`), that unpayable
 *   fraction is waived so the bill settles cleanly (`remainingLak = 0`).
 */
export declare function resolveCashLakSettlement(owedLak: Numeric, totalLak: Numeric, hasCashLakLeg: boolean): CashLakSettlement;
/**
 * Resolve LAK settlement for Buyback across ALL currencies (LAK, THB, USD)
 * and ALL methods (CASH, BANK):
 * - Total paid (LAK equivalent) must be <= `owedLak` (enforced by caller).
 * - Any remaining shortfall is rounded DOWN to 500 LAK steps:
 *     0 .. 499   ->   0   (waived completely)
 *     500 .. 999 -> 500   (e.g. 501..999 adjusted down to 500)
 *     1,001..1,499 -> 1,000, etc.
 */
export declare function resolveBuybackLakSettlement(owedLak: Numeric, totalLak: Numeric): CashLakSettlement;
//# sourceMappingURL=rounding.d.ts.map