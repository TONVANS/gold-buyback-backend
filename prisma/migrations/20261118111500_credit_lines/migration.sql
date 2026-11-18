-- CreateTable
CREATE TABLE "credit_lines" (
    "id" TEXT NOT NULL,
    "creditId" TEXT NOT NULL,
    "goldItemId" TEXT NOT NULL,
    "cabinetId" TEXT,
    "weightG" DECIMAL(18,4) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "sellPrice" DECIMAL(18,4) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "credit_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "credit_lines_creditId_idx" ON "credit_lines"("creditId");

-- AddForeignKey
ALTER TABLE "credit_lines" ADD CONSTRAINT "credit_lines_creditId_fkey" FOREIGN KEY ("creditId") REFERENCES "gold_credits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_lines" ADD CONSTRAINT "credit_lines_goldItemId_fkey" FOREIGN KEY ("goldItemId") REFERENCES "gold_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_lines" ADD CONSTRAINT "credit_lines_cabinetId_fkey" FOREIGN KEY ("cabinetId") REFERENCES "cabinets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ຍ້າຍບິນເກົ່າ (ແຖວດຽວ) ເຂົ້າເປັນແຖວລາຍການ ເພື່ອໃຫ້ທຸກບິນອ່ານຜ່ານ lines ໄດ້ຄືກັນ.
INSERT INTO "credit_lines" ("id", "creditId", "goldItemId", "cabinetId", "weightG", "quantity", "sellPrice", "sortOrder")
SELECT
  md5(random()::text || clock_timestamp()::text)::uuid::text,
  c.id, c."goldItemId", c."cabinetId", c."weightG", c.quantity, c."sellPrice", 0
FROM "gold_credits" c;
