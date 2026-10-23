import { describe, expect, test } from 'bun:test';
import { APP_COMMAND_TOOL_NAME, type AppCommandResult } from '@hsw-editor/commands';
import { HSW_TOOL_NAMES, parseClientMessage, parseServerMessage, type ViewportCall } from './ws.ts';

const rpc = (command: object) => parseClientMessage(JSON.stringify({ t: 'rpc', command }));

describe('parseClientMessage', () => {
  test('accepts the commands the panel needs', () => {
    expect(rpc({ id: '1', type: 'prompt', message: 'hi' }).ok).toBe(true);
    expect(rpc({ id: '2', type: 'prompt', message: 'hi', streamingBehavior: 'steer' }).ok).toBe(
      true,
    );
    expect(rpc({ id: '3', type: 'set_model', provider: 'anthropic', modelId: 'x' }).ok).toBe(true);
    expect(rpc({ id: '4', type: 'abort' }).ok).toBe(true);
  });

  test('blocks shell, credential and host-registration commands', () => {
    const blocked = [
      'bash',
      'login',
      'logout',
      'export_html',
      'open_session',
      'set_host_tools',
      'set_host_uri_schemes',
      'set_event_filter',
      'live_start',
      'set_todos',
    ];
    for (const type of blocked) {
      const result = rpc({
        id: '1',
        type,
        command: 'rm -rf ~',
        message: 'x',
        sessionDir: '/etc',
        tools: [],
      });
      expect(result.ok).toBe(false);
    }
  });

  test('rejects missing ids, unknown commands and malformed payloads', () => {
    expect(rpc({ type: 'abort' }).ok).toBe(false);
    expect(rpc({ id: '1', type: 'definitely_not_a_command' }).ok).toBe(false);
    expect(rpc({ id: '1', type: 'prompt' }).ok).toBe(false);
    const badImage = { type: 'image', data: 'AA', mimeType: 'text/html' };
    expect(rpc({ id: '1', type: 'prompt', message: 'x', images: [badImage] }).ok).toBe(false);
    expect(rpc({ id: '1', type: 'set_thinking_level', level: 'ludicrous' }).ok).toBe(false);
    expect(parseClientMessage('not json').ok).toBe(false);
  });

  test('ui responses carry exactly one answer shape', () => {
    const response = (extra: object) =>
      parseClientMessage(
        JSON.stringify({
          t: 'ui_response',
          response: { type: 'extension_ui_response', id: 'u1', ...extra },
        }),
      );
    expect(response({ value: 'Approve' }).ok).toBe(true);
    expect(response({ value: 'Approve', confirmed: true }).ok).toBe(false);
    expect(response({ answers: [{ id: 'q', selectedOptions: [1] }] }).ok).toBe(false);
    expect(response({ answers: [{ id: 'q', selectedOptions: ['a'] }] }).ok).toBe(true);
  });

  test('prompt responses are validated', () => {
    const answer = (value: object) =>
      parseClientMessage(JSON.stringify({ t: 'prompt_response', id: 'p', answer: value }));
    expect(answer({ approved: true }).ok).toBe(true);
    expect(answer({ cancelled: true }).ok).toBe(true);
    expect(answer({ approved: 'yes' }).ok).toBe(false);
    expect(answer({}).ok).toBe(false);
  });
});

describe('app_command on the wire', () => {
  test('a ui_call and its ui_result round trip as JSON', () => {
    const call: ViewportCall = {
      method: 'app_command',
      params: { op: 'run', id: 'wall.rename', args: { name: 'Garage' } },
    };
    const server = parseServerMessage(JSON.stringify({ t: 'ui_call', id: 'vp-1', call }));
    expect(server).toEqual({ t: 'ui_call', id: 'vp-1', call });

    const result: AppCommandResult = { ok: true, op: 'run', id: 'wall.rename', value: null };
    const client = parseClientMessage(
      JSON.stringify({ t: 'ui_result', id: 'vp-1', ok: true, result }),
    );
    expect(client).toEqual({ ok: true, message: { t: 'ui_result', id: 'vp-1', ok: true, result } });
  });

  test('a page error answers the call without a result', () => {
    const parsed = parseClientMessage(
      JSON.stringify({ t: 'ui_result', id: 'vp-1', ok: false, error: 'palette not mounted' }),
    );
    expect(parsed).toEqual({
      ok: true,
      message: { t: 'ui_result', id: 'vp-1', ok: false, error: 'palette not mounted' },
    });
  });

  test('ui_cancel reaches the page as a server message', () => {
    expect(parseServerMessage(JSON.stringify({ t: 'ui_cancel', id: 'vp-1' }))).toEqual({
      t: 'ui_cancel',
      id: 'vp-1',
    });
  });

  test('omp\u2019s own allow prompt for the tool is auto-approved like the wall tools', () => {
    expect(HSW_TOOL_NAMES).toContain(APP_COMMAND_TOOL_NAME);
  });
});
