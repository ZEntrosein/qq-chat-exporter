import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ModernHtmlExporter } from '../../lib/core/exporter/ModernHtmlExporter.js';
import { createTempDir } from '../helpers/tempDir.js';

function message(id: string, elements: any[]): any {
    return {
        id,
        seq: id,
        timestamp: 1700000000000,
        time: '2023-11-14T22:13:20Z',
        sender: { uid: `u_${id}`, name: id },
        type: 'normal',
        content: { text: '', html: '', elements, resources: [], mentions: [] },
        recalled: false,
        system: false,
    };
}

test('reply preview renders local thumbnail and only valid sources are clickable', async () => {
    const tmp = createTempDir();
    try {
        const outputPath = path.join(tmp.path, 'chat.html');
        const exporter = new ModernHtmlExporter({
            outputPath,
            includeResourceLinks: false,
            includeSystemMessages: true,
        });
        const validReply = message('reply-valid', [{
            type: 'reply',
            data: {
                referencedMessageId: 'source-id',
                sourceAvailable: true,
                senderName: '源用户',
                content: '[图片]',
                previewElements: [{ type: 'image', text: '[图片]', localPath: 'images/quoted.jpg' }],
            },
        }]);
        const missingReply = message('reply-missing', [{
            type: 'reply',
            data: {
                messageId: 'record-id',
                sourceAvailable: false,
                senderName: '范围外用户',
                content: '[图片]',
                previewElements: [{ type: 'image', text: '[图片]', localPath: 'images/outside.jpg' }],
            },
        }]);

        await exporter.export([
            message('source-id', [{ type: 'text', data: { content: '源消息' } }]),
            validReply,
            missingReply,
        ], { name: '测试', type: 'group' });
        const html = fs.readFileSync(outputPath, 'utf8');

        assert.ok(html.includes('src="./resources/images/quoted.jpg"'));
        assert.ok(html.includes('data-reply-to="msg-source-id"'));
        assert.ok(html.includes("scrollToMessage('msg-source-id')"));
        assert.equal(html.includes('data-reply-to="msg-record-id"'), false);
        assert.equal(html.includes("scrollToMessage('msg-record-id')"), false);
        assert.ok(html.includes('reply-content-clickable'));
        assert.ok(html.includes('virtualScroller.scrollToIndex(targetIndex)'));
    } finally {
        tmp.cleanup();
    }
});
