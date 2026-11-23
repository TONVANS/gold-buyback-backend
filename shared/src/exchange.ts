import { Decimal, dec, trimTrailingZeros, type Numeric } from './decimal.js';
import { ceilingTo, isMultipleOf } from './rounding.js';
import { GRAMS_PER_BAHT } from './constants.js';
import type { BuybackGoldKind, BuybackPriceSource } from './buyback.js';

/* ------------------------------------------------------------------ *
 * TOR §5.2 — ລາຍການປ່ຽນເປັນເງິນ (Gold Exchange & Trade-in)
 * ------------------------------------------------------------------ */

export type ExchangeTxnType = 'EXCHANGE_TO_CASH' | 'FREE_EXCHANGE';
export type ShapeCondition = 'GOOD' | 'DAMAGED';

/** ປະເພດຄຳ of an old line — only ຄຳຫຍຸບ is ever charged ຄ່າອ່ອນ. */
export type ExchangeGoldKind = 'GOOD' | 'HUMP' | 'BAR' | 'BOILED';

/** ລາຍການຄຳເກົ່າ the customer brings in. */
export interface ExchangeOldLine {
  weightG: Numeric;
  quantity: Numeric;
  /** ເກນນ້ຳໜັກ standard for this item — the weight it left the shop at. */
  standardWeightG: Numeric;
  /**
   * Optional display-weight standard used by `ປ່ຽນເປັນເງິນ!F9` (e.g. 1.87 for 5H).
   * Falls back to `standardWeightG` when omitted.
   */
  softGoldStandardG?: Numeric;
  /**
   * ປະເພດຄຳ. Omitted lines are treated as ຄຳຫຍຸບ, which is the only kind the
   * shop charges ຄ່າອ່ອນ on and the only kind this fee was ever written for.
   */
  goldKind?: ExchangeGoldKind;
  /** ລາຄາຊື້ຄືນໜ້າຮ້ານ for this line. */
  shopBuybackPrice?: Numeric;
}

/** ລາຍການຄຳໃໝ່ the customer takes away. */
export interface ExchangeNewLine {
  weightG: Numeric;
  quantity: Numeric;
  /** ຄ່າຫຍຸບ — from the ຄ່າປ່ຽນ table, zero on a free exchange. */
  humpFee?: Numeric;
  /** ຄ່າປ່ຽນຄຳແທ່ງ */
  barConvertFee?: Numeric;
  /** ຄ່າລາຍ */
  patternFee?: Numeric;
}

/** ຄຳເກົ່າຄົງເຫຼືອ — old gold left over, paid out in cash. */
export interface ExchangeRemainingLine {
  weightG: Numeric;
  quantity: Numeric;
  shopBuybackPrice?: Numeric;
}

export interface ExchangeInput {
  txnType: ExchangeTxnType;
  shapeCondition: ShapeCondition;
  oldLines: ExchangeOldLine[];
  newLines: ExchangeNewLine[];
  remainingLines: ExchangeRemainingLine[];
  /** ຄ່າອ່ອນ ປັດຈຸບັນ (TOR §3.4), currently 400,000 LAK per gram short. */
  softGoldFeePerGram: Numeric;
}

export interface ExchangeTotals {
  /** Sum of ເກນນ້ຳໜັກ standard across the old lines. */
  standardOldWeightG: Decimal;
  /** Sum of the actual weight the customer handed over. */
  actualOldWeightG: Decimal;
  totalNewWeightG: Decimal;
  totalRemainingWeightG: Decimal;
  /** ຄ່າອ່ອນ across all old lines. */
  softGoldFee: Decimal;
  humpFee: Decimal;
  barConvertFee: Decimal;
  patternFee: Decimal;
  shopBuybackPrice: Decimal;
  /** ລວມເງິນຕ້ອງຈ່າຍ — may be negative when the customer owes the shop. */
  totalPayable: Decimal;
}

export interface ExchangeValidation {
  /** True only when the balance is zero AND totalNewWeightG <= actualOldWeightG. */
  isBalanced: boolean;
  /**
   * (ເກນນ້ຳໜັກຄຳເກົ່າ standard) − (ລວມນ້ຳໜັກຄຳໃໝ່ + ລວມນ້ຳໜັກເກົ່າຄົງເຫຼືອ)
   * Positive: gold unaccounted for. Negative: more taken than brought in.
   */
  difference: Decimal;
  /** True when totalNewWeightG exceeds actualOldWeightG. */
  newExceedsActualOld: boolean;
  /** Lao message to show beside the Save button; null when balanced. */
  messageLo: string | null;
}

const sum = (values: Decimal[]): Decimal =>
  values.reduce((total, value) => total.plus(value), dec(0));

/**
 * ຄ່າອ່ອນ (TOR §5.2) — the fee for gold that comes back lighter than it left.
 *
 * Taken from the shop's own workbook (`ປ່ຽນເປັນເງິນ!F9`), which settles what
 * the TOR left as a bare cell reference:
 *
 *   CEILING(ROUNDDOWN(ROUND(standard − actual, 3), 2), 0.1) / 0.1 × C7 × ຈຳນວນ
 *
 * Two things that are easy to get wrong and that the workbook is explicit
 * about:
 *
 *   1. The shortfall is billed in whole 0.1 g steps, rounded UP. A piece
 *      0.01 g light is charged a full step, the same as one 0.1 g light. A
 *      plain per-gram rate — the obvious reading of the TOR — undercharges
 *      every case by up to one whole step.
 *   2. Only ຄຳຫຍຸບ pays it. ຄຳດີ and ຄຳແທ່ງ are charged nothing; instead they
 *      must arrive at an exact tier weight, which §5.2's balance rule checks.
 *
 * `C7` is the ຄ່າອ່ອນ cell on the workbook's ຄ່າອ່ອນ sheet — the current value,
 * 400,000 — so the parameter keeps that meaning.
 */
/**
 * Exchange weight tiers (Produets column C / B) ordered descending.
 *
 * Jewellery tiers carry both the printed display weight (`1.87`, `1.12`, `0.37` —
 * Produets column B, used by `ປ່ຽນເປັນເງິນ!F9` for `ຄ່າອ່ອນ`) and the exact
 * exchange weight (`1.875`, `1.125`, `0.375` — Produets column C, used by
 * `ປ່ຽນເປັນເງິນ!B46` for the weight balance).
 */
export const JEWELRY_EXCHANGE_TIERS: readonly {
  displayG: Decimal;
  exchangeG: Decimal;
}[] = [
  { displayG: dec('15'), exchangeG: dec('15') },
  { displayG: dec('7.5'), exchangeG: dec('7.5') },
  { displayG: dec('3.75'), exchangeG: dec('3.75') },
  { displayG: dec('1.87'), exchangeG: dec('1.875') },
  { displayG: dec('1.12'), exchangeG: dec('1.125') },
  { displayG: dec('0.75'), exchangeG: dec('0.75') },
  { displayG: dec('0.37'), exchangeG: dec('0.375') },
];

export const BAR_EXCHANGE_WEIGHTS: readonly Decimal[] = [
  dec('15'),
  dec('7.5'),
  dec('3.75'),
  dec('1'),
];

const DISPLAY_TO_EXCHANGE: Record<string, string> = {
  '1.87': '1.875',
  '1.12': '1.125',
  '0.37': '0.375',
};

export interface OldStandardDerivation {
  valid: boolean;
  /** Standard weight used for the §5.2 zero-balance check (`ປ່ຽນເປັນເງິນ!B46`). */
  standardWeightG: Decimal;
  /** Standard weight used for `ຄ່າອ່ອນ` (`ປ່ຽນເປັນເງິນ!F9`). */
  softGoldStandardG: Decimal;
  errorLo?: string;
}

/**
 * Derive and validate the standard weight of an old gold line directly from
 * its `goldKind` and actual `weightG`, matching `ປ່ຽນເປັນເງິນ!F9` and `B46`.
 *
 * - `GOOD` (ຄຳດີ): must match a jewellery tier (or a multiple of 15 g); no ຄ່າອ່ອນ.
 * - `BAR`  (ຄຳແທ່ງ): must match 1 / 3.75 / 7.5 g or a multiple of 15 g; no ຄ່າອ່ອນ.
 * - `HUMP` (ຄຳຫຍຸບ): rounds up to `CEILING(w, 15)` when > 15 g, or the smallest
 *   jewellery tier >= w when <= 15 g.
 */
export function deriveOldStandardWeight(
  kind: Exclude<ExchangeGoldKind, 'BOILED'>,
  weightG: Numeric,
): OldStandardDerivation {
  const w = dec(weightG);
  if (!w.isFinite() || w.lte(0)) {
    return {
      valid: false,
      standardWeightG: dec(0),
      softGoldStandardG: dec(0),
      errorLo: 'ນ້ຳໜັກຄຳເກົ່າຕ້ອງໃຫຍ່ກວ່າ 0',
    };
  }

  if (kind === 'GOOD') {
    if (w.gt(GRAMS_PER_BAHT)) {
      if (!isMultipleOf(w, GRAMS_PER_BAHT)) {
        return {
          valid: false,
          standardWeightG: dec(0),
          softGoldStandardG: dec(0),
          errorLo: 'ບໍ່ຕົງຕາມເງືອນໄຂ — ນ້ຳໜັກຄຳດີເກີນ 15g ຕ້ອງຫານ 15 ລົງໂຕ',
        };
      }
      return { valid: true, standardWeightG: w, softGoldStandardG: w };
    }
    const hit = JEWELRY_EXCHANGE_TIERS.find(
      (t) => t.exchangeG.eq(w) || t.displayG.eq(w),
    );
    if (!hit) {
      return {
        valid: false,
        standardWeightG: dec(0),
        softGoldStandardG: dec(0),
        errorLo: 'ບໍ່ຕົງຕາມເງືອນໄຂ — ນ້ຳໜັກຄຳດີຕ້ອງຕົງຕາມເກນ (15, 7.5, 3.75, 1.875, 1.125, 0.75, 0.375)',
      };
    }
    return { valid: true, standardWeightG: hit.exchangeG, softGoldStandardG: hit.exchangeG };
  }

  if (kind === 'BAR') {
    if (w.gte(GRAMS_PER_BAHT)) {
      if (!isMultipleOf(w, GRAMS_PER_BAHT)) {
        return {
          valid: false,
          standardWeightG: dec(0),
          softGoldStandardG: dec(0),
          errorLo: 'ບໍ່ຕົງຕາມເງືອນໄຂ — ນ້ຳໜັກຄຳແທ່ງ ≥ 15g ຕ້ອງຫານ 15 ລົງໂຕ',
        };
      }
      return { valid: true, standardWeightG: w, softGoldStandardG: w };
    }
    const hit = BAR_EXCHANGE_WEIGHTS.find((bw) => bw.eq(w));
    if (!hit) {
      return {
        valid: false,
        standardWeightG: dec(0),
        softGoldStandardG: dec(0),
        errorLo: 'ບໍ່ຕົງຕາມເງືອນໄຂ — ນ້ຳໜັກຄຳແທ່ງຕ້ອງເປັນ 1g, 3.75g, 7.5g ຫຼື ຫານ 15 ລົງໂຕ',
      };
    }
    return { valid: true, standardWeightG: hit, softGoldStandardG: hit };
  }

  // HUMP (ຄຳຫຍຸບ)
  if (w.gt(GRAMS_PER_BAHT)) {
    const std = ceilingTo(w, GRAMS_PER_BAHT);
    return { valid: true, standardWeightG: std, softGoldStandardG: std };
  }

  // Smallest tier with exchangeG >= w. Note that for display weights like 1.80g,
  // Excel F9 compares against displayG (1.87), whereas if someone enters exact
  // exchange weight (e.g. 1.875) no soft-gold penalty is owed.
  let matched = JEWELRY_EXCHANGE_TIERS[0]!;
  for (let i = JEWELRY_EXCHANGE_TIERS.length - 1; i >= 0; i--) {
    const tier = JEWELRY_EXCHANGE_TIERS[i]!;
    if (tier.exchangeG.gte(w)) {
      matched = tier;
      break;
    }
  }
  const softStd = w.lte(matched.displayG) ? matched.displayG : matched.exchangeG;
  return { valid: true, standardWeightG: matched.exchangeG, softGoldStandardG: softStd };
}

/**
 * ລາຄາຊື້ຄືນໜ້າຮ້ານ for `ຄຳເກົ່າຄົງເຫຼືອ` (`ປ່ຽນເປັນເງິນ!D32:D41`).
 *
 * Unlike counter buyback (§5.1), `ຄຳເກົ່າຄົງເຫຼືອ` in §5.2 NEVER rounds up a
 * non-tier weight via CEILING / lookupAtLeast: every remaining piece must match
 * an exact tier (or a multiple of 15 g), otherwise it returns `null` (`0` in Excel).
 */
export function exchangeRemainingBuybackPrice(
  kind: Exclude<BuybackGoldKind, 'BOILED'>,
  weightG: Numeric,
  source: BuybackPriceSource,
): Decimal | null {
  const w = dec(weightG);
  if (!w.isFinite() || w.lte(0)) return null;

  if (kind === 'BAR') {
    if (w.gte(GRAMS_PER_BAHT)) {
      if (!isMultipleOf(w, GRAMS_PER_BAHT)) return null;
      return w.div(GRAMS_PER_BAHT).mul(source.price1BahtFor('BAR'));
    }
    return source.lookup('BAR', w);
  }

  // GOOD and HUMP share the exact-match rule in ປ່ຽນເປັນເງິນ!D32:D41.
  if (w.gt(GRAMS_PER_BAHT)) {
    if (!isMultipleOf(w, GRAMS_PER_BAHT)) return null;
    return w.div(GRAMS_PER_BAHT).mul(source.price1BahtFor(kind));
  }
  const hit = JEWELRY_EXCHANGE_TIERS.find(
    (t) => t.exchangeG.eq(w) || t.displayG.eq(w),
  );
  if (!hit) return null;
  return source.lookup(kind, hit.displayG) ?? source.lookup(kind, hit.exchangeG);
}

/**
 * Split a remaining weight difference (e.g. `5.625 g`) into exact standard tiers
 * from largest to smallest (e.g. `[3.75, 1.875]`), so each remaining line can
 * be priced cleanly via `exchangeRemainingBuybackPrice`.
 */
export function splitWeightIntoExchangeTiers(
  weightG: Numeric,
  kind: Exclude<ExchangeGoldKind, 'BOILED'> = 'HUMP',
): { tiers: Decimal[]; remainder: Decimal } {
  let rem = dec(weightG).toDecimalPlaces(4);
  if (!rem.isFinite() || rem.lte(0)) return { tiers: [], remainder: dec(0) };

  const palette =
    kind === 'BAR'
      ? BAR_EXCHANGE_WEIGHTS
      : JEWELRY_EXCHANGE_TIERS.map((t) => t.exchangeG);

  const tiers: Decimal[] = [];
  for (const tierWeight of palette) {
    while (rem.gte(tierWeight)) {
      tiers.push(tierWeight);
      rem = rem.minus(tierWeight).toDecimalPlaces(4);
    }
  }
  return { tiers, remainder: rem };
}

/**
 * Normalise a printed display weight (`1.87`, `1.12`, `0.37`) to its exact
 * exchange key (`1.875`, `1.125`, `0.375`) for conversion fee lookups.
 */
export function normalizeExchangeWeightKey(weightG: Numeric): string {
  const raw = dec(weightG).toFixed();
  return DISPLAY_TO_EXCHANGE[raw] ?? raw;
}

/**
 * Resolve a conversion fee (`ຄ່າຫຍຸບ` or `ຄ່າປ່ຽນຄຳແທ່ງ`) for a single new-gold
 * line, matching `ປ່ຽນເປັນເງິນ!E16` / `F16`:
 * - Weights > 15 g must be a multiple of 15 g and scale linearly from the 15 g fee.
 * - Weights <= 15 g look up the exact weight key.
 */
export function resolveConversionFeeForWeight(
  weightG: Numeric,
  feeAtWeight: (key: string) => Decimal | undefined,
): { valid: boolean; fee: Decimal } {
  const w = dec(weightG);
  if (!w.isFinite() || w.lte(0)) return { valid: false, fee: dec(0) };

  if (w.gt(GRAMS_PER_BAHT)) {
    if (!isMultipleOf(w, GRAMS_PER_BAHT)) {
      return { valid: false, fee: dec(0) };
    }
    const baseFee = feeAtWeight('15');
    return {
      valid: true,
      fee: baseFee ? baseFee.mul(w.div(GRAMS_PER_BAHT)) : dec(0),
    };
  }

  const fee = feeAtWeight(normalizeExchangeWeightKey(w));
  return { valid: true, fee: fee ?? dec(0) };
}

export function softGoldFeeForLine(line: ExchangeOldLine, softGoldFee: Numeric): Decimal {
  const kind = line.goldKind ?? 'HUMP';
  if (kind !== 'HUMP') return dec(0);

  const standard = dec(line.softGoldStandardG ?? line.standardWeightG);
  const actual = dec(line.weightG);
  const shortfall = standard.minus(actual);
  if (shortfall.lte(0)) return dec(0);

  return softGoldSteps(shortfall).mul(dec(softGoldFee)).mul(dec(line.quantity));
}

/**
 * How many 0.1 g steps a shortfall is billed at.
 *
 * ROUND to 3 then ROUNDDOWN to 2 before the CEILING is the workbook's own
 * order: it clears the floating-point dust that 30 − 29.89 leaves behind
 * before deciding which step the shortfall falls into.
 */
export function softGoldSteps(shortfallG: Numeric): Decimal {
  const s = dec(shortfallG);
  if (s.lte(0)) return dec(0);
  const settled = s.toDecimalPlaces(3).toDecimalPlaces(2, Decimal.ROUND_DOWN);
  return settled.div('0.1').ceil();
}

/** Total weight of a set of lines: Σ weight × quantity. */
function totalWeight(
  lines: Array<{ weightG: Numeric; quantity: Numeric }>,
): Decimal {
  return sum(lines.map((l) => dec(l.weightG).mul(dec(l.quantity))));
}

/**
 * All §5.2 totals for one exchange.
 *
 * ລວມເງິນຕ້ອງຈ່າຍ = ລາຄາຊື້ຄືນໜ້າຮ້ານ − ຄ່າອ່ອນ − ຄ່າຫຍຸບ − ຄ່າປ່ຽນຄຳແທ່ງ − ຄ່າລາຍ
 *
 * On a ປ່ຽນຟຣີ the conversion fees are forced to zero regardless of what the
 * ຄ່າປ່ຽນ table says, so a free exchange cannot accidentally bill the customer.
 */
export function calculateExchange(input: ExchangeInput): ExchangeTotals {
  const isFree = input.txnType === 'FREE_EXCHANGE';

  const standardOldWeightG = sum(
    input.oldLines.map((l) => dec(l.standardWeightG).mul(dec(l.quantity))),
  );
  const actualOldWeightG = totalWeight(input.oldLines);
  const totalNewWeightG = totalWeight(input.newLines);
  const totalRemainingWeightG = totalWeight(input.remainingLines);

  const softGoldFee = sum(
    input.oldLines.map((l) => softGoldFeeForLine(l, input.softGoldFeePerGram)),
  );

  const humpFee = isFree
    ? dec(0)
    : sum(input.newLines.map((l) => dec(l.humpFee ?? 0).mul(dec(l.quantity))));

  const barConvertFee = isFree
    ? dec(0)
    : sum(input.newLines.map((l) => dec(l.barConvertFee ?? 0).mul(dec(l.quantity))));

  const patternFee = isFree
    ? dec(0)
    : sum(input.newLines.map((l) => dec(l.patternFee ?? 0).mul(dec(l.quantity))));

  const shopBuybackPrice = sum([
    ...input.oldLines.map((l) => dec(l.shopBuybackPrice ?? 0)),
    ...input.remainingLines.map((l) => dec(l.shopBuybackPrice ?? 0)),
  ]);

  const totalPayable = shopBuybackPrice
    .minus(softGoldFee)
    .minus(humpFee)
    .minus(barConvertFee)
    .minus(patternFee);

  return {
    standardOldWeightG,
    actualOldWeightG,
    totalNewWeightG,
    totalRemainingWeightG,
    softGoldFee,
    humpFee,
    barConvertFee,
    patternFee,
    shopBuybackPrice,
    totalPayable,
  };
}

/**
 * ⚠ CRITICAL Validation Rule (TOR §5.2).
 *
 *   (ເກນນ້ຳໜັກຄຳເກົ່າ standard) − (ລວມນ້ຳໜັກຄຳໃໝ່ + ລວມນ້ຳໜັກເກົ່າຄົງເຫຼືອ) === 0
 *
 * This is the single rule that keeps gold from leaking out of the shop during
 * an exchange: every gram brought in must leave as either new gold or
 * remaining old gold. It is checked here in the domain layer so the browser
 * and the API enforce exactly the same condition, and the API refuses the
 * write even if the UI is bypassed.
 */
export function validateExchangeBalance(totals: ExchangeTotals): ExchangeValidation {
  const accountedFor = totals.totalNewWeightG.plus(totals.totalRemainingWeightG);
  const difference = totals.standardOldWeightG.minus(accountedFor);
  const newExceedsActualOld = totals.totalNewWeightG.gt(totals.actualOldWeightG);

  if (newExceedsActualOld) {
    const newG = trimTrailingZeros(totals.totalNewWeightG.toDecimalPlaces(4).toFixed());
    const actualOldG = trimTrailingZeros(totals.actualOldWeightG.toDecimalPlaces(4).toFixed());
    return {
      isBalanced: false,
      difference,
      newExceedsActualOld: true,
      messageLo: `ນ້ຳໜັກລວມຄຳໃໝ່ (${newG} g) ເກີນນ້ຳໜັກລວມຄຳເກົ່າ (${actualOldG} g) — ນ້ຳໜັກຄຳໃໝ່ຕ້ອງບໍ່ເກີນຄຳເກົ່າ`,
    };
  }

  if (difference.isZero()) {
    return { isBalanced: true, difference, newExceedsActualOld: false, messageLo: null };
  }

  const amount = trimTrailingZeros(difference.abs().toDecimalPlaces(4).toFixed());
  const messageLo = difference.isPositive()
    ? `ນ້ຳໜັກຍັງບໍ່ຄົບ ${amount} g — ລວມນ້ຳໜັກຄຳໃໝ່ + ຄຳເກົ່າຄົງເຫຼືອ ຕ້ອງເທົ່າກັບເກນນ້ຳໜັກຄຳເກົ່າ`
    : `ນ້ຳໜັກເກີນ ${amount} g — ລວມນ້ຳໜັກຄຳໃໝ່ + ຄຳເກົ່າຄົງເຫຼືອ ຫຼາຍກວ່າເກນນ້ຳໜັກຄຳເກົ່າ`;

  return { isBalanced: false, difference, newExceedsActualOld: false, messageLo };
}
