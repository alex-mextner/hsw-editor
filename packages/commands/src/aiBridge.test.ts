import { describe, expect, test } from 'bun:test';
import type { PlannedAction } from './appCommand.ts';
import { IDLE_AI_ANSWER, reduceAiAnswer } from './aiBridge.ts';

describe('answer state', () => {
  test('streams text, then completes', () => {
    let state = reduceAiAnswer(IDLE_AI_ANSWER, { t: 'ask', runId: 1 });
    expect(state.status).toBe('streaming');
    state = reduceAiAnswer(state, { t: 'event', runId: 1, event: { t: 'delta', text: 'Hel' } });
    state = reduceAiAnswer(state, { t: 'event', runId: 1, event: { t: 'delta', text: 'lo' } });
    expect(state.text).toBe('Hello');
    state = reduceAiAnswer(state, { t: 'event', runId: 1, event: { t: 'done' } });
    expect(state.status).toBe('done');
  });

  test('errors stick and a new ask resets everything', () => {
    let state = reduceAiAnswer(IDLE_AI_ANSWER, { t: 'ask', runId: 1 });
    state = reduceAiAnswer(state, {
      t: 'event',
      runId: 1,
      event: { t: 'error', message: 'offline' },
    });
    state = reduceAiAnswer(state, { t: 'event', runId: 1, event: { t: 'done' } });
    expect(state).toMatchObject({ status: 'error', error: 'offline' });
    state = reduceAiAnswer(state, { t: 'ask', runId: 1 });
    expect(state).toEqual({ ...IDLE_AI_ANSWER, runId: 1, status: 'streaming' });
    expect(reduceAiAnswer(state, { t: 'reset' })).toEqual(IDLE_AI_ANSWER);
  });

  test('plan entries follow planned, running, done', () => {
    const plan: PlannedAction = {
      id: 'plan-1',
      commandId: 'edit.undo',
      title: { en: 'Undo', ru: 'Отменить' },
      args: null,
      mutates: true,
    };
    let state = reduceAiAnswer(IDLE_AI_ANSWER, { t: 'ask', runId: 1 });
    state = reduceAiAnswer(state, { t: 'plan', runId: 1, plan, status: 'planned' });
    state = reduceAiAnswer(state, { t: 'plan', runId: 1, plan, status: 'running' });
    state = reduceAiAnswer(state, { t: 'plan', runId: 1, plan, status: 'done' });
    expect(state.plans.map((p) => p.status)).toEqual(['done']);
    const second: PlannedAction = { ...plan, id: 'plan-2', args: { name: 'B' } };
    state = reduceAiAnswer(state, { t: 'plan', runId: 1, plan: second, status: 'planned' });
    state = reduceAiAnswer(state, { t: 'plan', runId: 1, plan, status: 'failed' });
    expect(state.plans.map((p) => [p.plan.id, p.status])).toEqual([
      ['plan-1', 'failed'],
      ['plan-2', 'planned'],
    ]);
  });
});

describe('answer state after an error', () => {
  test('later deltas and done do not resurrect the pane', () => {
    let state = reduceAiAnswer(IDLE_AI_ANSWER, { t: 'ask', runId: 1 });
    state = reduceAiAnswer(state, {
      t: 'event',
      runId: 1,
      event: { t: 'error', message: 'offline' },
    });
    state = reduceAiAnswer(state, { t: 'event', runId: 1, event: { t: 'delta', text: 'late' } });
    state = reduceAiAnswer(state, { t: 'event', runId: 1, event: { t: 'done' } });
    expect(state).toMatchObject({ status: 'error', error: 'offline', text: '' });
  });
});

describe('answer state across runs', () => {
  test('late events of a replaced question are ignored', () => {
    let state = reduceAiAnswer(IDLE_AI_ANSWER, { t: 'ask', runId: 1 });
    state = reduceAiAnswer(state, { t: 'ask', runId: 2 });
    state = reduceAiAnswer(state, { t: 'event', runId: 1, event: { t: 'delta', text: 'old' } });
    state = reduceAiAnswer(state, { t: 'event', runId: 1, event: { t: 'done' } });
    expect(state).toMatchObject({ runId: 2, status: 'streaming', text: '' });
    state = reduceAiAnswer(state, { t: 'event', runId: 2, event: { t: 'delta', text: 'new' } });
    expect(state.text).toBe('new');
  });
});
