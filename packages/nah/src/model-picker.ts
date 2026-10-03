import { filterModelOptions, type ModelOption } from "./model-catalog.js";
import { c } from "./render.js";
import { pickFromList } from "./list-picker.js";

/**
 * The `/model` picker. A thin wrapper over the shared list picker so `/session`
 * navigates and filters exactly the way this one does.
 */
export const pickModel = (options: ModelOption[]): Promise<string | undefined> => {
  const rows = options.map((option) => ({
    ...option,
    value: `${option.provider}:${option.id}`,
  }));
  const rowFor = (option: ModelOption): (typeof rows)[number] =>
    rows.find((row) => row.value === `${option.provider}:${option.id}`)!;

  return pickFromList({
    title: "Select a model",
    hint: "Type to search · ↑/↓ move · Enter select · Esc cancel",
    items: rows,
    // Reuses the catalog's own matcher, mapping its results back onto the rows
    // so filtering stays identical to what it has always been.
    filter: (items, query) =>
      filterModelOptions([...items] as ModelOption[], query).map(rowFor),
    format: (option) => `${option.value}  ${c.dim(`— ${option.name}`)}`,
    searchText: (option) => `${option.provider} ${option.id} ${option.name}`,
    searchPlaceholder: "provider, model name, or ID…",
    emptyText: "No matching models",
  });
};