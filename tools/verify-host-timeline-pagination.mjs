import {
  mapThreadToTimelineEvents,
  mapThreadToTimelinePage
} from '../bridge/host-bridge/timeline-mapper.mjs';

const thread = {
  id: 'thread-pagination-001',
  createdAt: 1,
  updatedAt: 4,
  preview: 'Pagination test',
  turns: [
    {
      id: 'turn-1',
      startedAt: 1,
      completedAt: 2,
      durationMs: 1000,
      status: { type: 'completed' },
      items: [
        {
          id: 'item-1',
          type: 'userMessage',
          content: [{ type: 'text', text: 'first prompt' }]
        },
        {
          id: 'item-2',
          type: 'agentMessage',
          text: 'first answer',
          phase: 'final'
        }
      ]
    },
    {
      id: 'turn-2',
      startedAt: 3,
      completedAt: 4,
      durationMs: 1000,
      status: { type: 'completed' },
      items: [
        {
          id: 'item-3',
          type: 'userMessage',
          content: [{ type: 'text', text: 'second prompt' }]
        },
        {
          id: 'item-4',
          type: 'agentMessage',
          text: 'second answer',
          phase: 'final'
        }
      ]
    }
  ]
};

const allEvents = mapThreadToTimelineEvents(thread);
assertEqual(allEvents.length, 8, 'full thread event count');
assertEqual(allEvents[0].cursor, '1', 'first stable cursor');
assertEqual(allEvents.at(-1).cursor, '8', 'last stable cursor');

const latest = mapThreadToTimelineEvents(thread, { limit: 2 });
assertEqual(latest.map((event) => event.cursor).join(','), '7,8', 'default latest page');

const older = mapThreadToTimelinePage(thread, { beforeCursor: '7', limit: 2 });
assertEqual(older.events.map((event) => event.cursor).join(','), '5,6', 'before cursor page');
assertEqual(older.has_more_before, true, 'middle page has older history');
assertEqual(older.has_more_after, true, 'middle page has newer history');

const first = mapThreadToTimelinePage(thread, { beforeCursor: '3', limit: 2 });
assertEqual(first.events.map((event) => event.cursor).join(','), '1,2', 'oldest page');
assertEqual(first.has_more_before, false, 'oldest page has no older history');

console.log('[verify] Host timeline cursor pagination verified.');

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}
