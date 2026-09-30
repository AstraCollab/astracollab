import type { PageFetcher } from "../types.js";

/**
 * Async iterator over a cursor-based list endpoint. Stops when the fetcher
 * returns no `nextCursor`. Use with `for await (const item of paginateAll(...))`.
 */
export async function* paginateAll<T>(
  fetcher: PageFetcher<T>,
): AsyncGenerator<T, void, undefined> {
  let cursor: string | undefined = undefined;
  while (true) {
    const page = await fetcher(cursor);
    for (const item of page.items) {
      yield item;
    }
    if (!page.nextCursor) {
      return;
    }
    cursor = page.nextCursor;
  }
}
