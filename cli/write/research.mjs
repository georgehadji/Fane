// Vane sometimes finds no sources for a query that worked a minute ago: ask once more.
// `research(query)` is the function the Vane patch hands to the hooks (Vane's own research on the chat's model
// and mode). -> retrieve(query), or undefined when the hook was given no research.
export const retryEmpty = (research, tries = 2) => research ? async (query) => {
  for (let attempt = 0; attempt < tries; attempt++) {
    const found = await research(query);
    if (found.length) return found;
  }
  return [];
} : undefined;
