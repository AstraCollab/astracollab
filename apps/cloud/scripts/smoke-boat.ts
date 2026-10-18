#!/usr/bin/env tsx
import "dotenv/config"

import { createBoatProvider } from "@/server/sandbox/provider"

const token = process.env.BOAT_API_TOKEN
if (!token) {
  console.error("BOAT_API_TOKEN missing")
  process.exit(1)
}

async function main() {
  const provider = createBoatProvider()
  const sandbox = await provider.provision({ ttlSeconds: 60, organizationId: "test", agentId: "test", cpu: 2, memoryMb: 4096, env: {} })
  console.log("created", sandbox.providerSandboxId)
  await provider.putFile(sandbox.providerSandboxId, "/tmp/hello.txt", "hi")
  const started = await provider.startCommand(sandbox.providerSandboxId, {
    command: "echo hello"
  })
  console.log("started", started.processId)
  await provider.destroy(sandbox.providerSandboxId)
  console.log("done")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
