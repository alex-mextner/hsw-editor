interface HighlightedTextProps {
  readonly text: string;
  /** Indexes of matched characters in `text` (from the palette ranking). */
  readonly positions: readonly number[];
}

interface Segment {
  readonly text: string;
  readonly match: boolean;
}

/** Splits `text` into runs of matched and unmatched characters. */
export function highlightRuns(text: string, positions: readonly number[]): readonly Segment[] {
  const marked = new Set(positions);
  const runs: Segment[] = [];
  let current = '';
  let currentMatch = false;
  for (let index = 0; index < text.length; index += 1) {
    const match = marked.has(index);
    if (index > 0 && match !== currentMatch) {
      runs.push({ text: current, match: currentMatch });
      current = '';
    }
    current += text.charAt(index);
    currentMatch = match;
  }
  if (current !== '') runs.push({ text: current, match: currentMatch });
  return runs;
}

export function HighlightedText({ text, positions }: HighlightedTextProps) {
  if (positions.length === 0) return <>{text}</>;
  return (
    <>
      {highlightRuns(text, positions).map((run, index) =>
        run.match ? (
          // Runs are derived from `text` and never reorder, so the position is a stable key.
          // oxlint-disable-next-line react/no-array-index-key
          <mark key={index} className="bg-transparent font-semibold text-primary">
            {run.text}
          </mark>
        ) : (
          // oxlint-disable-next-line react/no-array-index-key
          <span key={index}>{run.text}</span>
        ),
      )}
    </>
  );
}
