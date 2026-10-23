import { describe, expect, test } from 'bun:test';
import { HSW_TOOL_NAMES } from '@hsw-editor/omp-protocol';
import { WALL_AGENT_GUIDE } from './prompt.ts';

describe('WALL_AGENT_GUIDE', () => {
  test('names every registered host tool, including the tool library ones', () => {
    expect<readonly string[]>(HSW_TOOL_NAMES).toContain('wall_tools_search');
    expect<readonly string[]>(HSW_TOOL_NAMES).toContain('wall_add_tool');
    for (const name of HSW_TOOL_NAMES) expect(WALL_AGENT_GUIDE).toContain(name);
  });
});
