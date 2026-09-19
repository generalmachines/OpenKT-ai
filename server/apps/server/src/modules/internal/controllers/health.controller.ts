import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

@Controller("internal/health")
@ApiTags("Internal Health")
export class HealthController {
  constructor(private readonly configService: ConfigService) {}

  @Get("live")
  @ApiOperation({ summary: "Liveness probe" })
  live(): Record<string, unknown> {
    return {
      status: "ok",
      service: "server",
      mode: this.configService.get<string>("NODE_ENV", "development"),
    };
  }

  @Get("ready")
  @ApiOperation({ summary: "Readiness probe" })
  ready(): Record<string, unknown> {
    return {
      status: "ok",
      service: "server",
      checks: {
        config: true,
        http: true,
      },
    };
  }
}
