import { createBuilder } from "@rocicorp/zero";
import { schema as generatedSchema } from "./generated/zero/schema";

export const schema = {
	...generatedSchema,
	enableLegacyMutators: false,
	enableLegacyQueries: false,
};

export const builder = createBuilder(schema);

export type { Schema } from "./generated/zero/schema";
