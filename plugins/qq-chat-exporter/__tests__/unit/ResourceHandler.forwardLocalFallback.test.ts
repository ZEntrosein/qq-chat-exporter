import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ResourceHandler } from '../../lib/core/resource/ResourceHandler.js';

test('mergeWithCachedResource preserves an existing QQ local source over a temporary URL', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qce-forward-cache-'));
    const sourcePath = path.join(tempDir, 'qq-source.jpg');
    fs.writeFileSync(sourcePath, Buffer.from('cached-image'));

    try {
        const handler = Object.create(ResourceHandler.prototype) as any;
        handler.dbManager = {
            async getResourceByMd5() {
                return {
                    type: 'image',
                    md5: 'forward-md5',
                    originalUrl: sourcePath,
                    localPath: path.join(tempDir, 'missing-qce-cache.jpg'),
                    fileName: 'old.jpg',
                    fileSize: 12,
                    accessible: false,
                    status: 'failed',
                    checkedAt: new Date(),
                    downloadAttempts: 2,
                };
            },
        };

        const merged = await handler.mergeWithCachedResource({
            type: 'image',
            md5: 'forward-md5',
            originalUrl: 'https://multimedia.nt.qq.com.cn/temporary',
            fileName: 'forward.jpg',
            fileSize: 12,
            accessible: false,
            status: 'pending',
            checkedAt: new Date(),
            downloadAttempts: 0,
        });

        assert.equal(merged.originalUrl, sourcePath);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('downloadResource copies an existing QQ local source before calling downloadMedia', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qce-forward-local-'));
    const sourcePath = path.join(tempDir, 'qq-source.jpg');
    const localPath = path.join(tempDir, 'images', 'forward.jpg');
    const payload = Buffer.from('forward-image-payload');
    fs.writeFileSync(sourcePath, payload);
    let downloadMediaCalls = 0;

    try {
        const handler = Object.create(ResourceHandler.prototype) as any;
        handler.core = {
            apis: {
                FileApi: {
                    async downloadMedia() {
                        downloadMediaCalls++;
                        throw new Error('should not be called');
                    },
                },
            },
        };
        handler.config = { downloadTimeout: 1_000 };

        const resourceInfo = {
            type: 'image',
            originalUrl: sourcePath,
            localPath,
            fileName: 'forward.jpg',
        };
        const result = await handler.downloadResource(
            { msgId: 'shared-forward-id', chatType: 2, peerUid: 'group-id' },
            { elementId: '', picElement: { sourcePath: 'https://example.invalid/temporary' } },
            resourceInfo,
        );

        assert.equal(result, localPath);
        assert.deepEqual(fs.readFileSync(localPath), payload);
        assert.equal(downloadMediaCalls, 0);
        assert.equal(resourceInfo.originalUrl, sourcePath);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('downloadResource asks QQNT for an existing cache path when the element only has a URL', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qce-forward-qq-cache-'));
    const sourcePath = path.join(tempDir, 'qq-derived-cache.jpg');
    const localPath = path.join(tempDir, 'images', 'derived.jpg');
    fs.writeFileSync(sourcePath, Buffer.from('derived-qq-cache'));
    const previousBridge = (globalThis as any).__NAPCAT_BRIDGE__;
    let cachePathRequests = 0;
    let downloadMediaCalls = 0;

    (globalThis as any).__NAPCAT_BRIDGE__ = {
        core: {
            context: {
                session: {
                    getMsgService() {
                        return {
                            getRichMediaFilePathForGuild(payload: any) {
                                cachePathRequests++;
                                assert.equal(payload.md5HexStr, 'forward-md5');
                                assert.equal(payload.needCreate, false);
                                return sourcePath;
                            },
                        };
                    },
                },
            },
        },
    };

    try {
        const handler = Object.create(ResourceHandler.prototype) as any;
        handler.core = {
            apis: {
                FileApi: {
                    async downloadMedia() {
                        downloadMediaCalls++;
                        return '';
                    },
                },
            },
        };
        handler.config = { downloadTimeout: 1_000 };

        const result = await handler.downloadResource(
            { msgId: 'shared-forward-id', chatType: 2, peerUid: 'group-id' },
            {
                elementType: 2,
                elementId: '',
                picElement: {
                    md5HexStr: 'forward-md5',
                    fileName: 'forward.jpg',
                    sourcePath: 'https://multimedia.nt.qq.com.cn/temporary',
                },
            },
            {
                type: 'image',
                originalUrl: 'https://multimedia.nt.qq.com.cn/temporary',
                localPath,
                fileName: 'forward.jpg',
            },
        );

        assert.equal(result, localPath);
        assert.equal(cachePathRequests, 1);
        assert.equal(downloadMediaCalls, 0);
        assert.equal(fs.readFileSync(localPath, 'utf8'), 'derived-qq-cache');
    } finally {
        if (previousBridge === undefined) {
            delete (globalThis as any).__NAPCAT_BRIDGE__;
        } else {
            (globalThis as any).__NAPCAT_BRIDGE__ = previousBridge;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
