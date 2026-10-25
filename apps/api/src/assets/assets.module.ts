import { Global, Module } from "@nestjs/common";
import { AssetsController } from "./assets.controller";
import { AssetsService } from "./assets.service";
import { LocationsController } from "./locations.controller";
import { LocationsService } from "./locations.service";

/** Rooms and the asset inventory (docs/assets.md). Global so the services that take a room can check it with LocationsService. */
@Global()
@Module({ controllers: [LocationsController, AssetsController], providers: [LocationsService, AssetsService], exports: [LocationsService] })
export class AssetsModule {}
