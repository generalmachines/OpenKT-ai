import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

// Public health surface. The /v1/internal/health/* namespace stays for
// operator/synthetic monitoring; /v1/health is the documented public
// contract that ALB target health checks and uptime probes can hit.
@Controller("health")
@ApiTags("Health")
export class HealthController {
  constructor(private readonly configService: ConfigService) {}

  @Get()
  @ApiOperation({ summary: "Liveness probe (public)" })
  live(): Record<string, unknown> {
    return {
      status: "ok",
      service: "openkt-server",
      mode: this.configService.get<string>("NODE_ENV", "development"),
    };
  }

  @Get("ready")
  @ApiOperation({ summary: "Readiness probe (public)" })
  ready(): Record<string, unknown> {
    return {
      status: "ok",
      service: "openkt-server",
      checks: {
        config: true,
        http: true,
      },
    };
  }
}
