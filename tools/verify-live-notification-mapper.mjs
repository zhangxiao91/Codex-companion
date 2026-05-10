import { strict as assert } from 'node:assert';
import { mapAppServerNotificationToTimelineEvents } from '../bridge/host-bridge/timeline-mapper.mjs';

const samples = [
  {
    message: {
      method: 'thread/status/changed',
      params: {
        threadId: 'thread-1',
        status: { type: 'active', activeFlags: [] }
      }
    },
    expectedType: 'thread_status_changed'
  },
  {
    message: {
      method: 'turn/plan/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        explanation: 'Working plan',
        plan: [{ step: 'Read files', status: 'completed' }]
      }
    },
    expectedType: 'plan_update'
  },
  {
    message: {
      method: 'turn/diff/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        diff: 'diff --git a/file b/file'
      }
    },
    expectedType: 'diff_update'
  },
  {
    message: {
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        delta: 'partial assistant text'
      }
    },
    expectedType: 'assistant_delta'
  },
  {
    message: {
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-1',
        delta: 'test output'
      }
    },
    expectedType: 'command_output_delta'
  },
  {
    message: {
      method: 'item/fileChange/patchUpdated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'file-1',
        changes: []
      }
    },
    expectedType: 'file_changed'
  }
];

for (const sample of samples) {
  const events = mapAppServerNotificationToTimelineEvents(sample.message);
  assert.equal(events.length, 1, `${sample.message.method} should map to one event`);
  assert.equal(events[0].session_id, 'thread-1');
  assert.equal(events[0].type, sample.expectedType);
  assert.ok(events[0].title);
}

assert.deepEqual(
  mapAppServerNotificationToTimelineEvents({ method: 'unknown/event', params: {} }),
  []
);

console.log('[verify] Live notification mapper verified.');

