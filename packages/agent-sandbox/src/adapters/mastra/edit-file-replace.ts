const countOccurrences = (content: string, search: string): number => {
  if (search.length === 0) {
    return 0;
  }
  let count = 0;
  let index = 0;
  while (true) {
    const next = content.indexOf(search, index);
    if (next === -1) {
      break;
    }
    count += 1;
    index = next + search.length;
  }
  return count;
};

export type EditFileReplaceResult = {
  content: string;
  replacements: number;
};

/**
 * Pi/Mastra-style exact-string edit. Mirrors @mastra/core workspace line-utils without
 * importing non-exported symbols from `@mastra/core/workspace`.
 */
export const replaceFileEditStrings = (
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): EditFileReplaceResult => {
  const count = countOccurrences(content, oldString);
  if (count === 0) {
    throw new Error(
      "The specified text was not found. Make sure you use the exact text from the file.",
    );
  }
  if (!replaceAll && count > 1) {
    throw new Error(
      `The specified text appears ${count} times. Provide more surrounding context to make the match unique, or use replace_all to replace all occurrences.`,
    );
  }
  const escapedNewString = newString.replace(/\$/g, "$$$$");
  if (replaceAll) {
    return { content: content.split(oldString).join(newString), replacements: count };
  }
  return { content: content.replace(oldString, escapedNewString), replacements: 1 };
};
