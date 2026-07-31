import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { AuthUser } from '../auth/jwt.strategy';
import { PartiesService, PartyRole, UploadedCsv } from './parties.service';
import { CreatePartyDto, UpdatePartyDto } from './dto';

@Controller('parties')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PartiesController {
  constructor(private readonly parties: PartiesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('search') search?: string) {
    return this.parties.list(user.tenantId, search);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.parties.get(user.tenantId, id);
  }

  @Post()
  @Roles('ACCOUNTANT', 'SALES')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePartyDto) {
    return this.parties.create(user.tenantId, dto);
  }

  @Post('import')
  @Roles('ACCOUNTANT', 'SALES')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  import(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: UploadedCsv,
    @Body('role') role?: string,
  ) {
    if (role !== 'supplier' && role !== 'client') {
      throw new BadRequestException("Parametrul 'role' trebuie să fie 'supplier' sau 'client'");
    }
    return this.parties.import(user.tenantId, role as PartyRole, file);
  }

  @Patch(':id')
  @Roles('ACCOUNTANT', 'SALES')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdatePartyDto) {
    return this.parties.update(user.tenantId, id, dto);
  }
}
