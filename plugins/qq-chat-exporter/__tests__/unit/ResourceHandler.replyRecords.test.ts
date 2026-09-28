import test from 'node:test';
import assert from 'node:assert/strict';

import { ResourceHandler } from '../../lib/core/resource/ResourceHandler.js';

test('processMessageResources also scans media in reply records', async () => {
    const processedMessageIds: string[] = [];
    const handler = Object.create(ResourceHandler.prototype) as any;
    handler.progressCallback = null;
    handler.skipDownloadTypes = new Set();
    handler.processElement = async (message: any) => {
        processedMessageIds.push(message.msgId);
        return {
            id: `${message.msgId}-image`,
            type: 'image',
            fileName: `${message.msgId}.jpg`,
            localPath: `C:\\cache\\${message.msgId}.jpg`,
            md5: `${message.msgId}-md5`,
            accessible: true,
            status: 'downloaded',
        };
    };

    const record = {
        msgId: 'record-id',
        elements: [{ picElement: { fileName: 'quoted.jpg' } }],
        records: [],
    };
    const topLevel = {
        msgId: 'reply-id',
        elements: [{ replyElement: { sourceMsgIdInRecords: 'record-id' } }],
        records: [record],
    };

    const resourceMap = await handler.processMessageResources([topLevel]);

    assert.deepEqual(processedMessageIds, ['record-id']);
    assert.equal(resourceMap.has('record-id'), true);
    assert.equal(resourceMap.get('record-id')![0].localPath, 'C:\\cache\\record-id.jpg');
});
