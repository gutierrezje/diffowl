import { paginate, type Page } from "./pagination.js";

export interface FeedEntry {
  id: string;
  title: string;
}

export interface FeedResponse {
  entries: FeedEntry[];
  cursor: string | null;
}

const FEED_PAGE_SIZE = 20;

export function buildFeedResponse(entries: readonly FeedEntry[], offset: number): FeedResponse {
  const page: Page<FeedEntry> = paginate(entries, offset, FEED_PAGE_SIZE);
  return {
    entries: page.items,
    cursor: page.nextOffset === null ? null : String(page.nextOffset),
  };
}
