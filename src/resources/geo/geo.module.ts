import { Module } from '@nestjs/common';
import { GoogleModule } from '../../providers/google/google.module';
import { GeoController } from './geo.controller';

@Module({
  imports: [GoogleModule],
  controllers: [GeoController],
})
export class GeoModule {}
