import { Module } from "@nestjs/common";
import { PrintersController } from "./printers.controller";
import { PrintersService } from "./printers.service";

@Module({
  providers: [PrintersService],
  controllers: [PrintersController],
  exports: [PrintersService],
})
export class PrintersModule {}
