import { QueueClient } from '@vercel/queue';
import { processReminderMessage } from '../../lib/reminders.js';

const queue = new QueueClient();

export default queue.handleNodeCallback(
  async (message) => {
    await processReminderMessage(message);
  },
  {
    visibilityTimeoutSeconds: 60,
    retry: (_error, metadata) => ({ afterSeconds: Math.min(300, 30 * Math.max(1, metadata.deliveryCount)) })
  }
);
