import { Module } from "@nestjs/common";
import { PropresenterController } from "./propresenter.controller";
import { PropresenterService } from "./propresenter.service";

@Module({
  controllers: [PropresenterController],
  providers: [PropresenterService],
})
export class PropresenterModule {}
