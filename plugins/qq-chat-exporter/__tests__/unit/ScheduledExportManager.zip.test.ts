import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ScheduledExportManager, type ScheduledExportConfig } from '../../lib/core/scheduler/ScheduledExportManager.js';
import { BatchMessageFetcher } from '../../lib/core/fetcher/BatchMessageFetcher.js';
import { ModernHtmlExporter } from '../../lib/core/exporter/ModernHtmlExporter.js';

function listCentralDirectoryEntries(zipPath: string): string[] {
    const data = fs.readFileSync(zipPath);
    const entries: string[] = [];
    for (let offset = 0; offset + 46 <= data.length;) {
        if (data.readUInt32LE(offset) !== 0x02014b50) {
            offset++;
            continue;
        }
        const nameLength = data.readUInt16LE(offset + 28);
        const extraLength = data.readUInt16LE(offset + 30);
        const commentLength = data.readUInt16LE(offset + 32);
        entries.push(data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

test('HTML scheduled export creates an isolated ZIP and removes its staging directory', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qce-scheduled-zip-'));
    const originalFetch = BatchMessageFetcher.prototype.fetchAllMessagesInTimeRange;
    const originalExport = ModernHtmlExporter.prototype.exportFromIterable;

    try {
        BatchMessageFetcher.prototype.fetchAllMessagesInTimeRange = async function* () {
            yield [{ msgTime: '1700000000', msgId: 'message-1', elements: [] }] as any;
        };

        ModernHtmlExporter.prototype.exportFromIterable = async function () {
            const outputPath = (this as any).options.outputPath as string;
            const imagePath = path.join(path.dirname(outputPath), 'resources', 'images', 'test.png');
            fs.mkdirSync(path.dirname(imagePath), { recursive: true });
            fs.writeFileSync(outputPath, '<html><img src="resources/images/test.png"></html>');
            fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
            // 同一个媒体被两条消息引用时，导出器可能返回重复路径。
            return ['resources/images/test.png', 'resources/images/test.png'];
        };

        const dbManager = {
            saveScheduledExport: async () => undefined,
            saveExecutionHistory: async () => undefined,
        };
        const resourceHandler = {
            setSkipDownloadTypes: () => undefined,
            processMessageResources: async () => new Map(),
            getLastBatchSummary: () => ({ attempted: 0, downloaded: 0, alreadyAvailable: 0, failed: 0 }),
        };
        const manager = new ScheduledExportManager(
            { selfInfo: { uid: 'self', uin: '10000', nick: 'tester' } } as any,
            dbManager as any,
            resourceHandler as any,
        );
        const now = new Date();
        const task: ScheduledExportConfig = {
            id: 'scheduled-zip-test',
            name: '测试会话',
            peer: { chatType: 2, peerUid: '123', guildId: '' },
            scheduleType: 'daily',
            executeTime: '02:00',
            timeRangeType: 'yesterday',
            format: 'HTML',
            options: { includeResourceLinks: true, exportAsZip: true },
            outputDir: tempDir,
            enabled: true,
            createdAt: now,
            updatedAt: now,
        };

        const history = await (manager as any).executeExportTask(task);

        assert.equal(history.status, 'success');
        assert.match(history.filePath, /\.zip$/i);
        assert.ok(fs.existsSync(history.filePath));
        assert.ok(fs.statSync(history.filePath).size > 0);
        const entries = listCentralDirectoryEntries(history.filePath);
        assert.equal(entries.filter((entry) => entry === 'resources/images/test.png').length, 1);
        assert.ok(entries.includes('resources/images/'));
        assert.ok(entries.includes('resources/videos/'));
        assert.ok(entries.includes('resources/audios/'));
        assert.ok(entries.includes('resources/files/'));
        assert.equal(fs.existsSync(path.join(tempDir, '.qce-scheduled-staging')), false);
        assert.equal(fs.readdirSync(tempDir).filter((name) => name.endsWith('.html')).length, 0);
    } finally {
        BatchMessageFetcher.prototype.fetchAllMessagesInTimeRange = originalFetch;
        ModernHtmlExporter.prototype.exportFromIterable = originalExport;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
