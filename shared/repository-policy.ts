/** Unknown fork status is not eligible. All discovery and scan boundaries agree. */
export function isNonForkRepository<T extends { isFork: boolean }>(repository: T | null | undefined): repository is T {
  return repository?.isFork === false;
}
