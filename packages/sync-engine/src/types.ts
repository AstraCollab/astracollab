import type { clientMutators } from "./mutators/client";
import type { serverMutators } from "./mutators/server";
import type { FilesResource } from "./resources/files";
import type { builder, schema } from "./schema";

export type SyncEngineMode = "client" | "server";

export type SyncEngineConfig = {
	mode?: SyncEngineMode;
	debug?: boolean;
};

export type SyncEngine = {
	readonly schema: typeof schema;
	readonly builder: typeof builder;
	readonly files: FilesResource;
};

export type ClientSyncEngine = SyncEngine & {
	readonly mode: "client";
	readonly mutators: typeof clientMutators;
};

export type ServerSyncEngine = SyncEngine & {
	readonly mode: "server";
	readonly mutators: typeof serverMutators;
};
