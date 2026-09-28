import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { ResourceHandler } from '../../lib/core/resource/ResourceHandler.js';

test('nested forward downloads use the preserved outer peer context', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qce-nested-peer-'));
    const localPath = path.join(tempDir, 'images', 'nested.jpg');
    const calls: unknown[][] = [];

    try {
        const handler = Object.create(ResourceHandler.prototype) as any;
        handler.core = {
            apis: {
                FileApi: {
                    async downloadMedia(...args: unknown[]) {
                        calls.push(args);
                        const target = String(args[5]);
                        fs.mkdirSync(path.dirname(target), { recursive: true });
                        fs.writeFileSync(target, Buffer.from('nested-image'));
                        return target;
                    },
                },
            },
        };
        handler.config = { downloadTimeout: 1_000 };

        const result = await handler.downloadResource(
            {
                msgId: 'deep-message-id',
                chatType: 0,
                peerUid: '',
                __qceForwardPeer: { chatType: 2, peerUid: 'real-group-peer', guildId: '0' },
                __qceForwardRootMsgId: 'root-forward-id',
            },
            {
                elementId: 'deep-element-id',
                picElement: { fileName: 'nested.jpg', sourcePath: '', originImageUrl: '' },
            },
            { type: 'image', localPath, fileName: 'nested.jpg', originalUrl: '' },
        );

        assert.equal(result, localPath);
        assert.equal(fs.readFileSync(localPath, 'utf8'), 'nested-image');
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0]!.slice(0, 4), [
            'deep-message-id', 2, 'real-group-peer', 'deep-element-id',
        ]);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('deep images fall back to a fresh NapCat image URL when downloadMedia cannot locate them', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qce-nested-image-url-'));
    const payload = Buffer.from('deep-image-from-signed-url');
    const server = http.createServer((_req, res) => {
        res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': payload.length,
        });
        res.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const previousBridge = (globalThis as any).__NAPCAT_BRIDGE__;
    try {
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const signedUrl = `http://127.0.0.1:${address.port}/signed-image.png`;
        let getImageUrlCalls = 0;
        let downloadMediaCalls = 0;
        (globalThis as any).__NAPCAT_BRIDGE__ = {
            core: {
                apis: {
                    FileApi: {
                        async getImageUrl(picElement: any) {
                            getImageUrlCalls++;
                            assert.match(picElement.originImageUrl, /^\/download\?/);
                            return signedUrl;
                        },
                    },
                },
            },
        };

        const handler = Object.create(ResourceHandler.prototype) as any;
        handler.core = {
            apis: { FileApi: { async downloadMedia() { downloadMediaCalls++; return ''; } } },
        };
        handler.config = { downloadTimeout: 1_000 };

        const localPath = path.join(tempDir, 'images', 'deep.png');
        const result = await handler.downloadResource(
            {
                msgId: 'deep-message-id',
                chatType: 0,
                peerUid: '',
                __qceForwardPeer: { chatType: 2, peerUid: 'real-group-peer', guildId: '0' },
            },
            {
                elementId: 'deep-image-element',
                picElement: {
                    fileName: 'deep.png',
                    sourcePath: 'E:\\missing-qq-cache\\deep.png',
                    originImageUrl: '/download?appid=1407&fileid=deep-file-id',
                },
            },
            { type: 'image', localPath, fileName: 'deep.png', originalUrl: '' },
        );

        assert.equal(result, localPath);
        assert.deepEqual(fs.readFileSync(localPath), payload);
        assert.equal(getImageUrlCalls, 1);
        assert.equal(downloadMediaCalls, 0, '转发图片不应先等待 downloadMedia 超时');
    } finally {
        if (previousBridge === undefined) {
            delete (globalThis as any).__NAPCAT_BRIDGE__;
        } else {
            (globalThis as any).__NAPCAT_BRIDGE__ = previousBridge;
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('download queue distinguishes forward layers that reuse msgId and elementId', async () => {
    const handler = Object.create(ResourceHandler.prototype) as any;
    handler.downloadQueue = [];
    handler.isProcessing = true;
    handler.calculatePriority = () => 100;

    const element = { elementId: 'shared-element-id', picElement: { fileName: 'same.jpg' } };
    const resource = (suffix: string) => ({
        type: 'image',
        md5: `md5-${suffix}`,
        fileName: 'same.jpg',
        localPath: `C:\\cache\\${suffix}.jpg`,
    });

    await handler.enqueueDownload(
        { msgId: 'shared-message-id', __qceResourceKey: 'outer/shared-message-id' },
        element,
        resource('outer'),
    );
    await handler.enqueueDownload(
        { msgId: 'shared-message-id', __qceResourceKey: 'outer/middle/shared-message-id' },
        element,
        resource('deep'),
    );

    assert.equal(handler.downloadQueue.length, 2);
    assert.notEqual(handler.downloadQueue[0].id, handler.downloadQueue[1].id);
});
