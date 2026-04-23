import { useMemo } from "react";
import Fuse, { type IFuseOptions, type FuseOptionKey } from "fuse.js";

export interface UseFuseFilterOptions<T> {
  threshold?: number;
  ignoreLocation?: boolean;
  includeMatches?: boolean;
  extra?: Partial<IFuseOptions<T>>;
}

/**
 * Shared fuzzy-filter primitive used by Find (L0 + L1) and project notes (L2).
 *
 * When `query` is empty, returns `items` unchanged. Otherwise returns the
 * fuse-ranked subset. Keys can carry weights; caller controls the field list
 * so each view tunes what it considers searchable.
 *
 * Defaults (`threshold: 0.35`, `ignoreLocation: true`) match the tuning we
 * settled on for the project-notes list. Override via `opts` if a view needs
 * something stricter or looser.
 */
export function useFuseFilter<T>(
  items: T[],
  keys: FuseOptionKey<T>[],
  query: string,
  opts: UseFuseFilterOptions<T> = {},
): T[] {
  const fuse = useMemo(() => {
    return new Fuse(items, {
      keys,
      threshold: opts.threshold ?? 0.35,
      ignoreLocation: opts.ignoreLocation ?? true,
      includeMatches: opts.includeMatches,
      ...opts.extra,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, keys, opts.threshold, opts.ignoreLocation, opts.includeMatches]);

  return useMemo(() => {
    const q = query.trim();
    if (!q) return items;
    return fuse.search(q).map((r) => r.item);
  }, [fuse, items, query]);
}
