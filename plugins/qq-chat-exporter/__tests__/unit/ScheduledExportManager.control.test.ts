import test from 'node:test';
import assert from 'node:assert/strict';

import { ScheduledExportManager, type ScheduledExportConfig } from '../../lib/core/scheduler/ScheduledExportManager.js';
import { BatchMessageFetcher } from '../../lib/core/fetcher/BatchMessageFetcher.js';

function makeTask(id: string): ScheduledExportConfig {
    const now = new Date();
    return {
        id,
        name: `任务-${id}`,
        peer: { chatType: 2, peerUid: id, guildId: '' },
        scheduleType: 'daily',
        executeTime: '08:00',
        timeRangeType: 'yesterday',
        format: 'JSON',
        options: {},
        enabled: true,
        createdAt: now,
        updatedAt: now
    } as ScheduledExportConfig;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('等待条件超时');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

function setupControlledFetch(id: string) {
    const originalFetch = BatchMessageFetcher.prototype.fetchAllMessagesInTimeRange;
    let releaseSecondBatch!: () => void;
    const secondBatchGate = new Promise<void>((resolve) => { releaseSecondBatch = resolve; });
    let waitingForSecondBatch = false;

    BatchMessageFetcher.prototype.fetchAllMessagesInTimeRange = async function* () {
        yield [];
        waitingForSecondBatch = true;
        await secondBatchGate;
        yield [];
    };

    const histories: any[] = [];
    const dbManager = {
        saveScheduledExport: async () => undefined,
        saveExecutionHistory: async (history: any) => { histories.push(history); }
    };
    const manager = new ScheduledExportManager({} as any, dbManager as any, {} as any);
    const task = makeTask(id);
    (manager as any).scheduledTasks = new Map([[id, task]]);

    return {
        manager,
        task,
        histories,
        releaseSecondBatch,
        isWaitingForSecondBatch: () => waitingForSecondBatch,
        restore: () => { BatchMessageFetcher.prototype.fetchAllMessagesInTimeRange = originalFetch; }
    };
}

test('scheduled execution can pause and resume without starting a duplicate run', async () => {
    const controlled = setupControlledFetch('pause-resume');
    try {
        const triggered = controlled.manager.triggerScheduledExport(controlled.task.id);
        assert.equal(triggered?.started, true);
        await waitUntil(controlled.isWaitingForSecondBatch);

        const paused = controlled.manager.pauseScheduledExport(controlled.task.id);
        assert.equal(paused?.changed, true);
        assert.equal(paused?.progress.status, 'paused');

        controlled.releaseSecondBatch();
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(controlled.manager.getExecutionProgress(controlled.task.id)?.status, 'paused');
        assert.equal(controlled.histories.length, 0, 'paused execution must not finish in the background');

        const duplicate = controlled.manager.triggerScheduledExport(controlled.task.id);
        assert.equal(duplicate?.started, false);
        assert.equal(duplicate?.progress.status, 'paused');

        const resumed = controlled.manager.resumeScheduledExport(controlled.task.id);
        assert.equal(resumed?.changed, true);
        await waitUntil(() => controlled.manager.getExecutionProgress(controlled.task.id)?.status === 'success');
        assert.equal(controlled.histories.length, 1);
        assert.equal(controlled.histories[0].status, 'success');
    } finally {
        controlled.restore();
    }
});

test('stopping a paused run records stopped and keeps future scheduling enabled', async () => {
    const controlled = setupControlledFetch('stop');
    try {
        controlled.manager.triggerScheduledExport(controlled.task.id);
        await waitUntil(controlled.isWaitingForSecondBatch);
        controlled.manager.pauseScheduledExport(controlled.task.id);

        const stopped = controlled.manager.stopScheduledExportExecution(controlled.task.id);
        assert.equal(stopped?.changed, true);
        assert.equal(stopped?.progress.status, 'stopping');
        controlled.releaseSecondBatch();

        await waitUntil(() => controlled.manager.getExecutionProgress(controlled.task.id)?.status === 'stopped');
        assert.equal(controlled.histories.length, 1);
        assert.equal(controlled.histories[0].status, 'stopped');
        assert.equal(controlled.task.enabled, true, 'stop must not disable future cron executions');
    } finally {
        controlled.restore();
    }
});

