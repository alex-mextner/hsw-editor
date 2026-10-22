/**
 * Public surface of the vendored omp renderer (generated tree: ./omp-render, see VENDORED.md).
 * Hand-written and stable: consumers import from here, never from ./omp-render directly.
 * Render inside `<div className="omp-scope">` and import `../omp-render.css` once.
 */
export { Transcript, type TranscriptProps } from './omp-render/components/transcript/Transcript';
export { Markdown, StreamingMarkdown } from './omp-render/components/transcript/Markdown';
export { ToolCard, type ToolCardProps } from './omp-render/components/transcript/ToolCard';
export { ToolView, type ToolViewProps } from './omp-render/tool-render/ToolView';
export { resolveToolRenderer } from './omp-render/tool-render/registry';
export type {
  ToolRenderHost,
  ToolRenderProps,
  ToolRenderer,
  ToolResultBlock,
  ToolResultImage,
  ToolResultLike,
  ToolResultText,
} from './omp-render/tool-render/types';
export {
  escapeHtml,
  fmtCost,
  fmtDuration,
  fmtPercent,
  fmtTokens,
  messageText,
  relTime,
  shortenPath,
} from './omp-render/lib/format';
