import assert from 'node:assert/strict';
import { AppServerCodexAdapter } from '../bridge/host-bridge/codex-adapter.mjs';

class FakeAppServerAdapter extends AppServerCodexAdapter {
  constructor() {
    const events = [];
    super('fake-host', {
      codexCli: 'codex',
      onTimelineEvent: (event) => events.push(event)
    });
    this.events = events;
    this.calls = [];
  }

  async ensureThreadLoaded() {}

  async requestWithThreadLoadedRetry(sessionId, method, params) {
    this.calls.push({ sessionId, method, params });
    if (method === 'turn/start') {
      return {
        turn: {
          id: `turn-${this.calls.filter((call) => call.method === 'turn/start').length}`,
          status: { type: 'running' }
        }
      };
    }
    throw new Error(`Unexpected method: ${method}`);
  }
}

const adapter = new FakeAppServerAdapter();
const sessionId = 'queue-session';
adapter.activeTurnsByThread.set(sessionId, 'active-turn');

for (let index = 1; index <= 5; index += 1) {
  const response = await adapter.queuePrompt(sessionId, {
    session_id: sessionId,
    text: `queued prompt ${index}`
  });
  assert.equal(response.payload.event.type, 'prompt_queued');
  assert.equal(response.payload.event.payload.queue_depth, index);
}

const full = await adapter.queuePrompt(sessionId, {
  session_id: sessionId,
  text: 'overflow prompt'
});
assert.equal(full.payload.event.type, 'error');
assert.equal(full.payload.event.title, 'Prompt queue full');

adapter.updateActiveTurnState({
  method: 'turn/completed',
  params: {
    threadId: sessionId,
    turn: { id: 'active-turn' }
  }
});

await waitFor(() => adapter.calls.some((call) => call.method === 'turn/start'), 5000);
assert.equal(adapter.calls[0].params.input[0].text, 'queued prompt 1');
assert.equal(adapter.events[0].type, 'prompt_queue_started');
assert.equal(adapter.events[1].type, 'turn_start_requested');
assert.equal(adapter.promptQueuesByThread.get(sessionId).length, 4);

console.log('[verify] Prompt queue adapter enqueue, max length, and drain verified.');

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition.');
}
