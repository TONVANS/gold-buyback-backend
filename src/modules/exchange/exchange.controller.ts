import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { ApprovalStatus } from '@prisma/client';
import { ExchangeService } from './exchange.service';
import {
  CancelExchangeDto,
  CreateExchangeDto,
  ListExchangeDto,
  PreviewExchangeDto,
  ReviewExchangeDto,
  SettleExchangePaymentDto,
  UpdateExchangeDto,
} from './dto/exchange.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequiresOpenShift } from '../../common/decorators/requires-shift.decorator';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('exchange')
@ApiBearerAuth('bearer')
@Controller('exchange')
export class ExchangeController {
  constructor(private readonly exchange: ExchangeService) {}

  @Get()
  list(@Query() query: ListExchangeDto, @CurrentUser() user: AuthenticatedUser) {
    return this.exchange.list(query.status as ApprovalStatus | undefined, query, user);
  }

  @Get(':id')
  getOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.exchange.getOne(id, user);
  }

  /**
   * Live totals plus the §5.2 balance check — the form calls this on every
   * change so the Save button reflects the same rule the API enforces.
   */
  @Roles('VALUER', 'ADMIN', 'MANAGER')
  @Post('preview')
  preview(@Body() dto: PreviewExchangeDto) {
    return this.exchange.preview(dto);
  }

  @Roles('VALUER', 'ADMIN', 'MANAGER')
  @RequiresOpenShift()
  @Post()
  create(@Body() dto: CreateExchangeDto, @CurrentUser() user: AuthenticatedUser, @Req() req: any) {
    const shiftId = req.shift?.id as string | undefined;
    if (!shiftId) throw new BadRequestException('ຕ້ອງເປີດກະກ່ອນສ້າງລາຍການ');
    return this.exchange.create(dto, user, shiftId);
  }

  @Roles('VALUER', 'ADMIN', 'MANAGER')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateExchangeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.exchange.update(id, dto, user);
  }

  @Roles('PAYMENT', 'ADMIN', 'MANAGER')
  @RequiresOpenShift()
  @Post(':id/review')
  review(
    @Param('id') id: string,
    @Body() dto: ReviewExchangeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: any,
  ) {
    const shiftId = req.shift?.id as string | undefined;
    return this.exchange.review(id, dto, user, shiftId);
  }

  @Roles('VALUER', 'PAYMENT', 'ADMIN', 'MANAGER')
  @Post(':id/cancel')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelExchangeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.exchange.cancel(id, dto, user);
  }

  @Roles('VALUER', 'PAYMENT', 'ADMIN', 'MANAGER')
  @RequiresOpenShift()
  @Post(':id/payments')
  addPayment(
    @Param('id') id: string,
    @Body() dto: SettleExchangePaymentDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: any,
  ) {
    const shiftId = req.shift?.id as string | undefined;
    return this.exchange.addPayment(id, dto, user, shiftId);
  }

  @Roles('VALUER', 'ADMIN', 'MANAGER')
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.exchange.remove(id, user);
  }
}
