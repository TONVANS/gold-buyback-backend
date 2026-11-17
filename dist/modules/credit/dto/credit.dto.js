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
exports.ReceiveCreditDto = exports.ReviewCreditDto = exports.CancelCreditDto = exports.UpdateCreditDto = exports.CreateCreditDto = exports.ListCreditDto = exports.ReceiptLinesDto = exports.CreditReceiptDto = void 0;
const openapi = require("@nestjs/swagger");
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
const history_range_dto_1 = require("../../../common/dto/history-range.dto");
const decimal_string_validator_1 = require("../../../common/dto/decimal-string.validator");
class CreditReceiptDto {
    method;
    bankAccountId;
    currency;
    amount;
    static _OPENAPI_METADATA_FACTORY() {
        return { method: { required: true, enum: ["CASH", "BANK"], enum: ['CASH', 'BANK'] }, bankAccountId: { required: false, type: () => String }, currency: { required: true, enum: ["LAK", "THB", "USD"], enum: ['LAK', 'THB', 'USD'] }, amount: { required: true, type: () => String } };
    }
}
exports.CreditReceiptDto = CreditReceiptDto;
__decorate([
    (0, class_validator_1.IsIn)(['CASH', 'BANK']),
    __metadata("design:type", String)
], CreditReceiptDto.prototype, "method", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreditReceiptDto.prototype, "bankAccountId", void 0);
__decorate([
    (0, class_validator_1.IsIn)(['LAK', 'THB', 'USD']),
    __metadata("design:type", String)
], CreditReceiptDto.prototype, "currency", void 0);
__decorate([
    (0, decimal_string_validator_1.IsDecimalString)({ labelLo: 'ຈຳນວນເງິນ' }),
    __metadata("design:type", String)
], CreditReceiptDto.prototype, "amount", void 0);
/**
 * One payment leg. A single transaction may mix ສົດ and ໂອນ across several
 * currencies, so these arrive as a list and the shop's money moves once per
 * leg rather than once per transaction.
 */
class ReceiptLinesDto {
    receipts;
    static _OPENAPI_METADATA_FACTORY() {
        return { receipts: { required: true, type: () => [require("./credit.dto").CreditReceiptDto], minItems: 1 } };
    }
}
exports.ReceiptLinesDto = ReceiptLinesDto;
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ArrayMinSize)(1, { message: 'ຕ້ອງມີລາຍການຮັບເງິນຢ່າງໜ້ອຍ 1 ລາຍການ' }),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => CreditReceiptDto),
    __metadata("design:type", Array)
], ReceiptLinesDto.prototype, "receipts", void 0);
/**
 * ຕົວກອງຂອງລາຍການປະຫວັດ.
 *
 * ຕ້ອງສືບທອດ `TimeSearchHistoryRangeDto` ເພາະ ValidationPipe ຕັ້ງ `forbidNonWhitelisted`:
 * query ໃດທີ່ບໍ່ມີໃນ DTO ຈະຖືກປະຕິເສດ 400 ເຖິງແມ່ນ handler ຈະອ່ານມັນດ້ວຍ
 * `@Query('...')` ກໍຕາມ.
 */
class ListCreditDto extends history_range_dto_1.TimeSearchHistoryRangeDto {
    status;
    static _OPENAPI_METADATA_FACTORY() {
        return { status: { required: false, enum: ["PENDING", "APPROVED", "REJECTED", "COMPLETED", "CANCELLED"], enum: ['PENDING', 'APPROVED', 'REJECTED', 'COMPLETED', 'CANCELLED'] } };
    }
}
exports.ListCreditDto = ListCreditDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsIn)(['PENDING', 'APPROVED', 'REJECTED', 'COMPLETED', 'CANCELLED']),
    __metadata("design:type", String)
], ListCreditDto.prototype, "status", void 0);
class CreateCreditDto {
    phone;
    goldItemId;
    cabinetId;
    weightG;
    quantity;
    sellPrice;
    downPayment;
    /** Superseded by `receipts`; accepted so an older client still works. */
    receipt;
    receipts;
    static _OPENAPI_METADATA_FACTORY() {
        return { phone: { required: true, type: () => String, pattern: "^\\d{8}$" }, goldItemId: { required: true, type: () => String }, cabinetId: { required: false, type: () => String }, weightG: { required: true, type: () => String }, quantity: { required: true, type: () => Number, minimum: 1 }, sellPrice: { required: true, type: () => String }, downPayment: { required: true, type: () => String }, receipt: { required: false, type: () => require("./credit.dto").CreditReceiptDto, description: "Superseded by `receipts`; accepted so an older client still works." }, receipts: { required: false, type: () => [require("./credit.dto").CreditReceiptDto] } };
    }
}
exports.CreateCreditDto = CreateCreditDto;
__decorate([
    (0, class_validator_1.Matches)(/^\d{8}$/, { message: 'ເບີໂທຕ້ອງເປັນຕົວເລກ 8 ໂຕ' }),
    __metadata("design:type", String)
], CreateCreditDto.prototype, "phone", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateCreditDto.prototype, "goldItemId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateCreditDto.prototype, "cabinetId", void 0);
__decorate([
    (0, decimal_string_validator_1.IsDecimalString)({ labelLo: 'ນ້ຳໜັກ' }),
    __metadata("design:type", String)
], CreateCreditDto.prototype, "weightG", void 0);
__decorate([
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1, { message: 'ຈຳນວນຕ້ອງຢ່າງໜ້ອຍ 1' }),
    __metadata("design:type", Number)
], CreateCreditDto.prototype, "quantity", void 0);
__decorate([
    (0, decimal_string_validator_1.IsDecimalString)({ labelLo: 'ລາຄາຂາຍ' }),
    __metadata("design:type", String)
], CreateCreditDto.prototype, "sellPrice", void 0);
__decorate([
    (0, decimal_string_validator_1.IsDecimalString)({ labelLo: 'ເງິນວາງດາວ' }),
    __metadata("design:type", String)
], CreateCreditDto.prototype, "downPayment", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.ValidateNested)(),
    (0, class_transformer_1.Type)(() => CreditReceiptDto),
    __metadata("design:type", CreditReceiptDto)
], CreateCreditDto.prototype, "receipt", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => CreditReceiptDto),
    __metadata("design:type", Array)
], CreateCreditDto.prototype, "receipts", void 0);
class UpdateCreditDto {
    phone;
    goldItemId;
    cabinetId;
    weightG;
    quantity;
    sellPrice;
    downPayment;
    receipts;
    static _OPENAPI_METADATA_FACTORY() {
        return { phone: { required: false, type: () => String, pattern: "^\\d{8}$" }, goldItemId: { required: false, type: () => String }, cabinetId: { required: false, type: () => String }, weightG: { required: false, type: () => String }, quantity: { required: false, type: () => Number, minimum: 1 }, sellPrice: { required: false, type: () => String }, downPayment: { required: false, type: () => String }, receipts: { required: false, type: () => [require("./credit.dto").CreditReceiptDto] } };
    }
}
exports.UpdateCreditDto = UpdateCreditDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.Matches)(/^\d{8}$/, { message: 'ເບີໂທຕ້ອງເປັນຕົວເລກ 8 ໂຕ' }),
    __metadata("design:type", String)
], UpdateCreditDto.prototype, "phone", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateCreditDto.prototype, "goldItemId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateCreditDto.prototype, "cabinetId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, decimal_string_validator_1.IsDecimalString)({ labelLo: 'ນ້ຳໜັກ' }),
    __metadata("design:type", String)
], UpdateCreditDto.prototype, "weightG", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1, { message: 'ຈຳນວນຕ້ອງຢ່າງໜ້ອຍ 1' }),
    __metadata("design:type", Number)
], UpdateCreditDto.prototype, "quantity", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, decimal_string_validator_1.IsDecimalString)({ labelLo: 'ລາຄາຂາຍ' }),
    __metadata("design:type", String)
], UpdateCreditDto.prototype, "sellPrice", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, decimal_string_validator_1.IsDecimalString)({ labelLo: 'ເງິນວາງດາວ' }),
    __metadata("design:type", String)
], UpdateCreditDto.prototype, "downPayment", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => CreditReceiptDto),
    __metadata("design:type", Array)
], UpdateCreditDto.prototype, "receipts", void 0);
class CancelCreditDto {
    reason;
    static _OPENAPI_METADATA_FACTORY() {
        return { reason: { required: false, type: () => String, maxLength: 300 } };
    }
}
exports.CancelCreditDto = CancelCreditDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(300, { message: 'ເຫດຜົນຍາວເກີນ 300 ຕົວ' }),
    __metadata("design:type", String)
], CancelCreditDto.prototype, "reason", void 0);
class ReviewCreditDto {
    decision;
    reason;
    static _OPENAPI_METADATA_FACTORY() {
        return { decision: { required: true, enum: ["APPROVED", "REJECTED"], enum: ['APPROVED', 'REJECTED'] }, reason: { required: false, type: () => String, maxLength: 300 } };
    }
}
exports.ReviewCreditDto = ReviewCreditDto;
__decorate([
    (0, class_validator_1.IsIn)(['APPROVED', 'REJECTED']),
    __metadata("design:type", String)
], ReviewCreditDto.prototype, "decision", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(300, { message: 'ເຫດຜົນຍາວເກີນ 300 ຕົວ' }),
    __metadata("design:type", String)
], ReviewCreditDto.prototype, "reason", void 0);
class ReceiveCreditDto {
    /** Single-leg form, kept so an older client still works. */
    method;
    bankAccountId;
    currency;
    amount;
    /** Multi-leg form: ສົດ and ໂອນ, several currencies, one receipt. */
    receipts;
    static _OPENAPI_METADATA_FACTORY() {
        return { method: { required: false, description: "Single-leg form, kept so an older client still works.", enum: ["CASH", "BANK"], enum: ['CASH', 'BANK'] }, bankAccountId: { required: false, type: () => String }, currency: { required: false, enum: ["LAK", "THB", "USD"], enum: ['LAK', 'THB', 'USD'] }, amount: { required: false, type: () => String }, receipts: { required: false, type: () => [require("./credit.dto").CreditReceiptDto], description: "Multi-leg form: \u0EAA\u0EBB\u0E94 and \u0EC2\u0EAD\u0E99, several currencies, one receipt." } };
    }
}
exports.ReceiveCreditDto = ReceiveCreditDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsIn)(['CASH', 'BANK']),
    __metadata("design:type", String)
], ReceiveCreditDto.prototype, "method", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], ReceiveCreditDto.prototype, "bankAccountId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsIn)(['LAK', 'THB', 'USD']),
    __metadata("design:type", String)
], ReceiveCreditDto.prototype, "currency", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, decimal_string_validator_1.IsDecimalString)({ labelLo: 'ຈຳນວນເງິນ' }),
    __metadata("design:type", String)
], ReceiveCreditDto.prototype, "amount", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => CreditReceiptDto),
    __metadata("design:type", Array)
], ReceiveCreditDto.prototype, "receipts", void 0);
//# sourceMappingURL=credit.dto.js.map