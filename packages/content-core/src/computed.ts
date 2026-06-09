interface ContentEntry {
  content: string;
}

export function wordCount(entry: ContentEntry): number {
  return entry.content.split(/\s+/).filter(Boolean).length;
}

export function readingTime(entry: ContentEntry, wordsPerMinute = 200): number {
  const words = entry.content.split(/\s+/).filter(Boolean).length;
  return Math.ceil(words / wordsPerMinute);
}

export function excerpt(entry: ContentEntry, length = 160): string {
  const text = entry.content.replace(/#+\s/g, "").trim();
  if (text.length <= length) return text;
  const lastSpace = text.lastIndexOf(" ", length);
  // If no space found before length, truncate at length limit
  const endIndex = lastSpace > 0 ? lastSpace : length;
  return text.slice(0, endIndex) + "...";
}
