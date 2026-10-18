import { ingestTelemetry } from "@/server/telemetry/ingest"

export async function POST(request: Request): Promise<Response> {
  return ingestTelemetry(request)
}
