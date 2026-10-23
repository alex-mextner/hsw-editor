/**
 * The `app_command` host tool: lets the embedded agent list, search and run the editor's registered commands
 * (the same actions as the command palette and the keyboard shortcuts). The commands live in the page, so the
 * tool only validates the request, forwards it over the page's `ui_call` channel and checks the answer.
 * Approval of changing actions is the page's job (the palette shows the plan and waits for the user).
 */
import {
  APP_COMMAND_TOOL,
  appCommandResultSchema,
  parseAppCommandArgs,
} from '@hsw-editor/commands';
import { failure, jsonResult, jsonSchemaOf } from './tool-helpers.ts';
import type { HostTool, ToolEnv, ToolFactory } from './tool-types.ts';

/** A changing command waits for the user's approval, so the call may stay open far longer than a viewport call. */
export const APP_COMMAND_TIMEOUT_MS = 5 * 60_000;

export interface AppCommandToolOptions {
  readonly timeoutMs?: number;
}

export function createAppCommandToolFactory(options: AppCommandToolOptions = {}): ToolFactory {
  const timeoutMs = options.timeoutMs ?? APP_COMMAND_TIMEOUT_MS;
  return (env: ToolEnv) => {
    const appCommand: HostTool = {
      definition: {
        name: APP_COMMAND_TOOL.name,
        label: 'Editor: command',
        description: APP_COMMAND_TOOL.description,
        parameters: jsonSchemaOf(APP_COMMAND_TOOL.inputSchema),
      },
      async execute(args, { signal }) {
        const checked = parseAppCommandArgs(args);
        // Refuse a bad request here instead of bothering the page.
        if (!checked.ok) return failure(`Invalid app_command arguments: ${checked.message}`);
        const reply = await env.viewport.call(
          { method: 'app_command', params: checked.args },
          signal,
          timeoutMs,
        );
        const result = appCommandResultSchema.safeParse(reply);
        if (!result.success)
          return failure('The editor answered app_command with an unexpected reply.');
        const outcome = result.data;
        if (!outcome.ok) {
          return jsonResult(outcome, { isError: true, details: { code: outcome.code } });
        }
        return jsonResult(outcome, {
          details: outcome.op === 'run' ? { op: outcome.op, id: outcome.id } : { op: outcome.op },
        });
      },
    };
    return [appCommand];
  };
}
