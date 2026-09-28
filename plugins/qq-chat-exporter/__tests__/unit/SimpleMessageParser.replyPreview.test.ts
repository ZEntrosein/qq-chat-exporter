/**
 * issue #128 子项：reply 元素的 previewElements 字段。
 *
 * 这里只覆盖 backfillReplyPreviewLocalPaths 的行为：在所有消息的资源
 * 路径已经被写好之后，回头把 reply 元素引用到的图片也补上 localPath。
 *
 * extractReplyContent 自身需要 NapCat overlay 的 messageMap 上下文，跨进程
 * mock 比较重，所以这里直接构造 CleanMessage 列表 + 手工填好 elements 来
 * 校验 backfill 的匹配规则（md5 优先、其次顺序、缺失留空）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SimpleMessageParser, type CleanMessage } from '../../lib/core/parser/SimpleMessageParser.js';

function makeImageMessage(id: string, images: Array<{ md5: string; localPath: string }>): CleanMessage {
    return {
        id,
        seq: id,
        timestamp: 1700000000,
        time: '2023-11-14T22:13:20Z',
        sender: { uid: 'u_1', name: 'A' },
        type: 'normal',
        content: {
            text: '',
            html: '',
            elements: images.map((img) => ({
                type: 'image',
                data: { filename: 'pic', md5: img.md5, localPath: img.localPath, url: `resources/${img.localPath}` },
            })),
            resources: [],
            mentions: [],
        },
        recalled: false,
        system: false,
    };
}

function makeReplyMessage(
    id: string,
    referencedMessageId: string,
    previewElements: any[],
): CleanMessage {
    return {
        id,
        seq: id,
        timestamp: 1700000001,
        time: '2023-11-14T22:13:21Z',
        sender: { uid: 'u_2', name: 'B' },
        type: 'normal',
        content: {
            text: '[图片]',
            html: '',
            elements: [
                {
                    type: 'reply',
                    data: {
                        messageId: id,
                        referencedMessageId,
                        senderName: 'A',
                        content: '[图片]',
                        timestamp: 1700000000,
                        previewElements,
                    },
                },
            ],
            resources: [],
            mentions: [],
        },
        recalled: false,
        system: false,
    };
}

test('backfillReplyPreviewLocalPaths: md5 命中时把 localPath 拉过来', () => {
    const parser = new SimpleMessageParser();
    const original = makeImageMessage('100', [
        { md5: 'aaa', localPath: 'images/aaa.jpg' },
    ]);
    const reply = makeReplyMessage('101', '100', [
        { type: 'image', text: '[图片]', md5: 'aaa', originUrl: 'http://q.qq/aaa', fileName: 'a.jpg' },
    ]);
    parser.backfillReplyPreviewLocalPaths([original, reply]);
    const previewElements = (reply.content.elements[0]!.data as any).previewElements;
    assert.equal(previewElements[0].localPath, 'images/aaa.jpg');
});

test('backfillReplyPreviewLocalPaths: md5 缺失时按顺序匹配', () => {
    const parser = new SimpleMessageParser();
    const original = makeImageMessage('100', [
        { md5: 'aaa', localPath: 'images/aaa.jpg' },
        { md5: 'bbb', localPath: 'images/bbb.jpg' },
    ]);
    const reply = makeReplyMessage('101', '100', [
        { type: 'text', text: 'hi' },
        { type: 'image', text: '[图片]' },
        { type: 'image', text: '[图片]' },
    ]);
    parser.backfillReplyPreviewLocalPaths([original, reply]);
    const previewElements = (reply.content.elements[0]!.data as any).previewElements;
    // text 不动
    assert.equal(previewElements[0].localPath, undefined);
    // 第一个 image 拿 fallbackIdx=0 的 localPath
    assert.equal(previewElements[1].localPath, 'images/aaa.jpg');
    // 第二个 image 拿 fallbackIdx=1 的 localPath（注意 fallbackIdx 在每个 image 后都自增）
    assert.equal(previewElements[2].localPath, 'images/bbb.jpg');
});

test('backfillReplyPreviewLocalPaths: 引用消息不在导出范围内时不写 localPath', () => {
    const parser = new SimpleMessageParser();
    const reply = makeReplyMessage('101', '999', [
        { type: 'image', text: '[图片]', md5: 'xxx', originUrl: 'http://q.qq/xxx' },
    ]);
    parser.backfillReplyPreviewLocalPaths([reply]);
    const previewElements = (reply.content.elements[0]!.data as any).previewElements;
    assert.equal(previewElements[0].localPath, undefined);
    // originUrl 仍然保留，让 HTML 端走 onerror 兜底
    assert.equal(previewElements[0].originUrl, 'http://q.qq/xxx');
});

test('backfillReplyPreviewLocalPaths: previewElements 缺失或非数组时不爆', () => {
    const parser = new SimpleMessageParser();
    const reply: CleanMessage = makeReplyMessage('101', '100', []);
    (reply.content.elements[0]!.data as any).previewElements = null;
    const original = makeImageMessage('100', [{ md5: 'aaa', localPath: 'images/aaa.jpg' }]);
    parser.backfillReplyPreviewLocalPaths([original, reply]);
    // 不抛异常即可
    assert.equal((reply.content.elements[0]!.data as any).previewElements, null);
});

test('backfillReplyPreviewLocalPaths: 空 messages 列表直接 no-op', () => {
    const parser = new SimpleMessageParser();
    parser.backfillReplyPreviewLocalPaths([]);
    // 不抛异常即可
    assert.ok(true);
});

test('backfillReplyPreviewLocalPaths: 原消息没图片资源时不动 reply', () => {
    const parser = new SimpleMessageParser();
    const original: CleanMessage = makeImageMessage('100', []);
    // 故意把 elements 都搞掉，确保不会 build 出 imagesByMsgId
    original.content.elements = [{ type: 'text', data: { content: 'hi' } }];
    const reply = makeReplyMessage('101', '100', [
        { type: 'image', text: '[图片]', md5: 'aaa' },
    ]);
    parser.backfillReplyPreviewLocalPaths([original, reply]);
    const previewElements = (reply.content.elements[0]!.data as any).previewElements;
    assert.equal(previewElements[0].localPath, undefined);
});

function rawMessage(overrides: Record<string, unknown>): any {
    return {
        msgId: '1',
        msgSeq: '1',
        clientSeq: '1',
        msgTime: '1700000000',
        msgType: 2,
        chatType: 2,
        peerUid: 'group',
        senderUid: 'u_1',
        senderUin: '10001',
        sendNickName: '测试用户',
        recallTime: '0',
        elements: [],
        records: [],
        ...overrides,
    };
}

test('parseMessagesStream: 用 replayMsgSeq 定位真正的顶层消息并回填本地缩略图', async () => {
    const parser = new SimpleMessageParser({ html: 'none' });
    const source = rawMessage({
        msgId: 'source-id',
        msgSeq: '5238907',
        elements: [{ picElement: { md5HexStr: 'image-md5', fileName: 'source.jpg' } }],
    });
    const record = rawMessage({
        msgId: 'record-id',
        msgSeq: '5238907',
        elements: [{ picElement: { md5HexStr: 'image-md5', fileName: 'source.jpg' } }],
    });
    const reply = rawMessage({
        msgId: 'reply-id',
        msgSeq: '5238910',
        records: [record],
        elements: [{
            replyElement: {
                replayMsgId: '0',
                replayMsgSeq: '5238907',
                sourceMsgIdInRecords: 'record-id',
                senderUin: '10001',
            },
        }],
    });
    const resourceMap = new Map([
        ['source-id', [{ type: 'image', md5: 'image-md5', localPath: process.execPath, accessible: true }]],
    ]);

    const parsed: CleanMessage[] = [];
    for await (const message of parser.parseMessagesStream([source, reply], resourceMap)) parsed.push(message);
    const replyData = parsed[1]!.content.elements.find(element => element.type === 'reply')!.data;

    assert.equal(replyData.referencedMessageId, 'source-id');
    assert.equal(replyData.sourceAvailable, true);
    assert.equal(replyData.previewResourceMessageId, 'source-id');
    assert.equal(replyData.previewElements[0].localPath, `images/${process.platform === 'win32' ? 'node.exe' : 'node'}`);
});

test('parseMessagesStream: 范围外引用使用 record 媒体，但不生成无效跳转目标', async () => {
    const parser = new SimpleMessageParser({ html: 'none' });
    const record = rawMessage({
        msgId: 'record-id',
        msgSeq: '5238800',
        elements: [{ picElement: { md5HexStr: 'record-md5', fileName: 'record.jpg' } }],
    });
    const reply = rawMessage({
        msgId: 'reply-id',
        msgSeq: '5238910',
        records: [record],
        elements: [{
            replyElement: {
                replayMsgId: '0',
                replayMsgSeq: '5238800',
                sourceMsgIdInRecords: 'record-id',
                senderUin: '10001',
            },
        }],
    });
    const resourceMap = new Map([
        ['record-id', [{ type: 'image', md5: 'record-md5', localPath: process.execPath, accessible: true }]],
    ]);

    const parsed: CleanMessage[] = [];
    for await (const message of parser.parseMessagesStream([reply], resourceMap)) parsed.push(message);
    const replyData = parsed[0]!.content.elements.find(element => element.type === 'reply')!.data;

    assert.equal(replyData.referencedMessageId, undefined);
    assert.equal(replyData.sourceAvailable, false);
    assert.equal(replyData.previewResourceMessageId, 'record-id');
    assert.equal(replyData.previewElements[0].localPath, `images/${process.platform === 'win32' ? 'node.exe' : 'node'}`);
});

test('backfillReplyPreviewLocalPathsFromResourceMap: 下载失败的计划路径不写入 HTML 数据', () => {
    const parser = new SimpleMessageParser({ html: 'none' });
    const reply = makeReplyMessage('101', '100', [
        { type: 'image', text: '[图片]', md5: 'failed-md5', originUrl: 'http://q.qq/fallback' },
    ]);
    (reply.content.elements[0]!.data as any).previewResourceMessageId = 'record-id';
    parser.backfillReplyPreviewLocalPathsFromResourceMap(reply, new Map([
        ['record-id', [{
            type: 'image',
            md5: 'failed-md5',
            localPath: 'C:\\cache\\missing.jpg',
            accessible: false,
        }]],
    ]));

    const preview = (reply.content.elements[0]!.data as any).previewElements[0];
    assert.equal(preview.localPath, undefined);
    assert.equal(preview.originUrl, 'http://q.qq/fallback');
});

test('parseMessagesStream: 合并转发子消息媒体从 resourceMap 回填离线路径', async () => {
    const parser = new SimpleMessageParser({ html: 'none' });
    const child = rawMessage({
        msgId: 'forward-child',
        msgSeq: '8801',
        elements: [{ picElement: { md5HexStr: 'forward-md5', fileName: 'inside.jpg' } }],
    });
    const top = rawMessage({
        msgId: 'forward-top',
        msgSeq: '8802',
        records: [child],
        elements: [{
            multiForwardMsgElement: {
                resId: 'forward-res-id',
                xmlContent: '<msg><summary>1条转发消息</summary></msg>',
            },
        }],
    });
    const resourceMap = new Map([
        ['forward-child', [{
            type: 'image',
            md5: 'forward-md5',
            localPath: process.execPath,
            accessible: true,
        }]],
    ]);

    const parsed: CleanMessage[] = [];
    for await (const message of parser.parseMessagesStream([top], resourceMap)) parsed.push(message);
    const forward = parsed[0]!.content.elements.find(element => element.type === 'forward')!.data;
    const image = forward.messages[0].content.elements.find((element: any) => element.type === 'image');

    assert.equal(image.data.localPath, `images/${process.platform === 'win32' ? 'node.exe' : 'node'}`);
    assert.equal(image.data.url, `resources/images/${process.platform === 'win32' ? 'node.exe' : 'node'}`);
});

test('hydrateForwardRecords: 在资源扫描前把 get_forward_msg 子消息转换为原始 records', async () => {
    const previousBridge = (globalThis as any).__NAPCAT_BRIDGE__;
    const calls: string[] = [];
    (globalThis as any).__NAPCAT_BRIDGE__ = {
        core: { apis: {} },
        actions: {
            get(name: string) {
                if (name !== 'get_forward_msg') return undefined;
                return {
                    async handle(payload: any) {
                        calls.push(String(payload.message_id));
                        return {
                            data: {
                                messages: [{
                                    message_id: 'forward-child-action',
                                    message_seq: 8810,
                                    time: 1700000100,
                                    user_id: 10002,
                                    sender: { nickname: '转发用户', card: '群名片' },
                                    message: [{
                                        type: 'image',
                                        data: {
                                            file: '0123456789abcdef0123456789abcdef.image',
                                            url: 'https://multimedia.nt.qq.com.cn/download?appid=1407',
                                            file_size: 1234,
                                            width: 640,
                                            height: 480,
                                        },
                                    }],
                                }],
                            },
                        };
                    },
                };
            },
        },
    };

    try {
        const parser = new SimpleMessageParser({ html: 'none' });
        const top = rawMessage({
            msgId: 'forward-top-action',
            records: [],
            elements: [{
                multiForwardMsgElement: {
                    resId: 'forward-res-action',
                    xmlContent: '<msg><summary>1条转发消息</summary></msg>',
                },
            }],
        });

        const hydrated = await parser.hydrateForwardRecords([top]);
        assert.equal(hydrated, 1);
        assert.deepEqual(calls, ['forward-top-action']);
        assert.equal(top.records.length, 1);
        assert.equal(top.records[0].msgId, 'forward-child-action');
        assert.equal(top.records[0].sendMemberName, '群名片');
        const picture = top.records[0].elements[0].picElement;
        assert.equal(picture.md5HexStr, '0123456789abcdef0123456789abcdef');
        assert.equal(picture.originImageUrl, 'https://multimedia.nt.qq.com.cn/download?appid=1407');
        assert.equal(picture.sourcePath, 'https://multimedia.nt.qq.com.cn/download?appid=1407');
    } finally {
        if (previousBridge === undefined) {
            delete (globalThis as any).__NAPCAT_BRIDGE__;
        } else {
            (globalThis as any).__NAPCAT_BRIDGE__ = previousBridge;
        }
    }
});

test('hydrateForwardRecords: 相同的转发节点 msgId 使用序号生成独立资源键', async () => {
    const previousBridge = (globalThis as any).__NAPCAT_BRIDGE__;
    (globalThis as any).__NAPCAT_BRIDGE__ = {
        core: {
            apis: {
                MsgApi: {
                    async getMultiMsg() {
                        return {
                            msgList: [
                                rawMessage({ msgId: 'shared-id', msgSeq: 'same', clientSeq: '53767' }),
                                rawMessage({ msgId: 'shared-id', msgSeq: 'same', clientSeq: '53768' }),
                                rawMessage({ msgId: 'shared-id', msgSeq: 'same', clientSeq: '53769' }),
                            ],
                        };
                    },
                },
            },
        },
        actions: { get() { return undefined; } },
    };

    try {
        const parser = new SimpleMessageParser({ html: 'none' });
        const top = rawMessage({
            msgId: 'forward-top-duplicate-id',
            records: [],
            elements: [{ multiForwardMsgElement: { resId: 'duplicate-res-id', xmlContent: '' } }],
        });

        await parser.hydrateForwardRecords([top]);
        assert.deepEqual(top.records.map((record: any) => record.msgId), [
            'shared-id', 'shared-id', 'shared-id',
        ]);
        assert.deepEqual(top.records.map((record: any) => record.__qceResourceKey), [
            'shared-id-53767', 'shared-id-53768', 'shared-id-53769',
        ]);
    } finally {
        if (previousBridge === undefined) {
            delete (globalThis as any).__NAPCAT_BRIDGE__;
        } else {
            (globalThis as any).__NAPCAT_BRIDGE__ = previousBridge;
        }
    }
});
