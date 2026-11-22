-- AlterTable
ALTER TABLE "gold_credits" ADD COLUMN "patternFee" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "credit_lines" ADD COLUMN "patternFee" DECIMAL(18,4) NOT NULL DEFAULT 0;
