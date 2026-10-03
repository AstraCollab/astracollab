import { clientMutators } from "./mutators/client";
import { serverMutators } from "./mutators/server";
import { createFilesResource } from "./resources/files";
import { builder, schema } from "./schema";
import type {
	ClientSyncEngine,
	ServerSyncEngine,
	SyncEngine,
	SyncEngineConfig,
} from "./types";

const logDebug = (config: SyncEngineConfig | undefined, message: string) => {
	if (!config?.debug) return;
	console.log("[Astracollab Sync Engine]", message);
};

export const createSyncEngine = (config: SyncEngineConfig = {}): SyncEngine => {
	logDebug(config, `createSyncEngine(mode=${config.mode ?? "client"})`);

	return {
		schema,
		builder,
		files: createFilesResource(),
	};
};

export const createClientSyncEngine = (
	config: Omit<SyncEngineConfig, "mode"> = {},
): ClientSyncEngine => ({
	...createSyncEngine({ ...config, mode: "client" }),
	mode: "client",
	mutators: clientMutators,
});

export const createServerSyncEngine = (
	config: Omit<SyncEngineConfig, "mode"> = {},
): ServerSyncEngine => ({
	...createSyncEngine({ ...config, mode: "server" }),
	mode: "server",
	mutators: serverMutators,
});

export class AstracollabSyncEngine {
	public readonly schema = schema;
	public readonly builder = builder;
	public readonly files = createFilesResource();

	constructor(private readonly config: SyncEngineConfig = {}) {
		logDebug(
			this.config,
			`new AstracollabSyncEngine(mode=${this.config.mode ?? "client"})`,
		);
	}
}
