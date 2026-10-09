import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  ValidationPipe,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { MemberAuthService, MEMBER_COOKIE } from './member-auth.service.js';
import { MemberOrdersService } from './member-orders.service.js';
import {
  MemberLoginDto,
  MemberVerifyDto,
  MemberOrdersDto,
  MemberOrderIdDto,
} from './members.dto.js';

const validate = (
  expectedType:
    | typeof MemberLoginDto
    | typeof MemberVerifyDto
    | typeof MemberOrdersDto
    | typeof MemberOrderIdDto,
) =>
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });

@Controller('members')
export class MembersController {
  constructor(
    private readonly auth: MemberAuthService,
    private readonly orders: MemberOrdersService,
  ) {}

  @Post('login')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  login(
    @Body(validate(MemberLoginDto)) dto: MemberLoginDto,
    @Req() req: Request,
  ) {
    this.auth.assertOrigin(req.headers.origin);
    return this.auth.requestLink(dto.email, req.ip ?? 'unknown');
  }

  @Post('verify')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  async verify(
    @Body(validate(MemberVerifyDto)) dto: MemberVerifyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.auth.assertOrigin(req.headers.origin);
    const session = await this.auth.verify(dto.token, req.ip ?? 'unknown');
    res.cookie(MEMBER_COOKIE, session.token, this.auth.cookieOptions());
    return session.profile;
  }

  @Header('Cache-Control', 'no-store')
  @Get('me')
  me(@Req() req: Request) {
    return this.auth.authorize(req);
  }

  @Header('Cache-Control', 'no-store')
  @Get('orders')
  async list(
    @Query(validate(MemberOrdersDto)) dto: MemberOrdersDto,
    @Req() req: Request,
  ) {
    const member = await this.auth.authorize(req);
    return this.orders.list(member.email, dto.page);
  }

  @Post('orders/:id/resume')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  async resume(
    @Param(validate(MemberOrderIdDto)) { id }: MemberOrderIdDto,
    @Req() req: Request,
  ) {
    this.auth.assertOrigin(req.headers.origin);
    const member = await this.auth.authorize(req);
    return this.orders.resume(member.email, id, req.ip ?? 'unknown');
  }

  @Post('orders/:id/cancel')
  @Header('Cache-Control', 'no-store')
  @HttpCode(204)
  async cancel(
    @Param(validate(MemberOrderIdDto)) { id }: MemberOrderIdDto,
    @Req() req: Request,
  ) {
    this.auth.assertOrigin(req.headers.origin);
    const member = await this.auth.authorize(req);
    await this.orders.cancel(member.email, id);
  }

  @Post('logout')
  @Header('Cache-Control', 'no-store')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.auth.assertOrigin(req.headers.origin);
    await this.auth.logout(req);
    const { maxAge: _maxAge, ...options } = this.auth.cookieOptions();
    res.clearCookie(MEMBER_COOKIE, options);
  }
}
