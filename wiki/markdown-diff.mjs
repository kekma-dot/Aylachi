const MAX_BYTES = 1_000_000;

function lines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

// One-block diff: disjoint edits are intentionally coalesced from first to last change.
export function diffMarkdown(before, after) {
  if (typeof before !== "string" || typeof after !== "string") {
    throw Object.assign(new TypeError("Markdown inputs must be strings"), { code: "INVALID_CONTENT" });
  }
  if (Buffer.byteLength(before, "utf8") > MAX_BYTES || Buffer.byteLength(after, "utf8") > MAX_BYTES) {
    throw Object.assign(new RangeError("Markdown input exceeds 1,000,000 UTF-8 bytes"), { code: "INVALID_CONTENT" });
  }
  const oldLines = lines(before), newLines = lines(after);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  if (start === oldLines.length && start === newLines.length) return [];
  let oldEnd = oldLines.length, newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--; newEnd--;
  }
  return [{ start, remove: oldLines.slice(start, oldEnd), insert: newLines.slice(start, newEnd) }];
}
