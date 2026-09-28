import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { ResourceHandler } from '../../lib/core/resource/ResourceHandler.js';

test('video falls back to NapCat getVideoUrl when downloadMedia returns an empty path', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qce-video-fallback-'));
    const payload = Buffer.from('mock-video-data');
    const server = http.createServer((_req, res) => {
        res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Length': payload.length,
        });
        res.end(payload);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const previousBridge = (globalThis as any).__NAPCAT_BRIDGE__;

    try {
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const videoUrl = `http://127.0.0.1:${address.port}/video.mp4`;
        const calls: Array<{ msgId: string; elementId: string }> = [];
        const core = {
            apis: {
                FileApi: {
                    downloadMedia: async () => '',
                },
            },
        };
        // 真实 Overlay 的公开 FileApi 只有 downloadMedia；完整 getVideoUrl
        // 位于 NapCat bridge 的原始 core 上。
        (globalThis as any).__NAPCAT_BRIDGE__ = {
            core: {
                apis: {
                    FileApi: {
                        getVideoUrl: async (_peer: unknown, msgId: string, elementId: string) => {
                            calls.push({ msgId, elementId });
                            return [{ url: videoUrl }];
                        },
                    },
                },
            },
        };
        const handler = Object.create(ResourceHandler.prototype) as any;
        handler.core = core;
        handler.config = {
            storageRoot: tempDir,
            downloadTimeout: 1_000,
        };

        const localPath = path.join(tempDir, 'videos', 'video-id_video.mp4');
        const message = {
            msgId: 'message-id',
            chatType: 2,
            peerUid: 'group-id',
        };
        const element = {
            elementId: 'element-id',
            videoElement: {
                fileName: 'video.mp4',
                filePath: '',
                fileUuid: 'video-uuid',
            },
        };
        const resourceInfo = {
            type: 'video',
            originalUrl: '',
            localPath,
            fileName: 'video.mp4',
        };

        const result = await handler.downloadResource(message, element, resourceInfo);

        assert.equal(result, localPath);
        assert.deepEqual(fs.readFileSync(localPath), payload);
        assert.equal(resourceInfo.originalUrl, videoUrl);
        assert.deepEqual(calls, [{ msgId: 'message-id', elementId: 'element-id' }]);
        assert.equal(fs.existsSync(`${localPath}.part`), false);
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
