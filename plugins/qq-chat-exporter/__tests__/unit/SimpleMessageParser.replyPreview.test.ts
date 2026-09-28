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

test('hydrateReplyRecords: 按 replayMsgSeq 回溯空回复的原始图片消息', async () => {
    const previousBridge = (globalThis as any).__NAPCAT_BRIDGE__;
    const calls: any[] = [];
    (globalThis as any).__NAPCAT_BRIDGE__ = {
        core: {
            apis: {
                MsgApi: {
                    async getMsgsBySeqAndCount(peer: any, seq: string, count: number, forward: boolean, backward: boolean) {
                        calls.push({ peer, seq, count, forward, backward });
                        return {
                            msgList: [rawMessage({
                                msgId: 'native-source-id',
                                msgSeq: '5238700',
                                clientSeq: '5238700',
                                peerUid: '',
                                elements: [{
                                    elementId: 'native-image-element',
                                    picElement: {
                                        md5HexStr: 'native-image-md5',
                                        fileName: 'quoted-native.jpg',
                                    },
                                }],
                            })],
                        };
                    },
                },
            },
        },
    };

    try {
        const parser = new SimpleMessageParser({ html: 'none' });
        const reply = rawMessage({
            msgId: 'empty-reply-id',
            msgSeq: '5238800',
            peerUid: 'real-group',
            records: [],
            elements: [{
                replyElement: {
                    replayMsgId: '0',
                    replayMsgSeq: '5238700',
                    sourceMsgIdInRecords: 'snapshot-source-id',
                    senderUin: '10002',
                },
            }],
        });

        const hydrated = await parser.hydrateReplyRecords([reply]);
        assert.equal(hydrated, 1);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], {
            peer: { chatType: 2, peerUid: 'real-group', guildId: '' },
            seq: '5238700',
            count: 1,
            forward: true,
            backward: true,
        });
        assert.equal(reply.records.length, 1);
        assert.equal(reply.records[0].msgId, 'native-source-id');
        assert.equal(reply.records[0].elements[0].picElement.md5HexStr, 'native-image-md5');
        assert.equal((reply.records[0] as any).__qceReplyRecord, true);
        assert.equal((reply.records[0] as any).__qceResourceKey, 'empty-reply-id/reply-snapshot-source-id');
        assert.equal((reply.records[0] as any).__qceForwardPeer.peerUid, 'real-group');

        const [parsed] = await parser.parseMessages([reply]);
        const replyData = parsed.content.elements.find(element => element.type === 'reply')!.data;
        assert.equal(replyData.content, '[图片]');
        assert.equal(replyData.previewElements[0].md5, 'native-image-md5');
        assert.equal(replyData.previewResourceMessageId, 'empty-reply-id/reply-snapshot-source-id');
        assert.equal(replyData.sourceAvailable, false);
    } finally {
        if (previousBridge === undefined) delete (globalThis as any).__NAPCAT_BRIDGE__;
        else (globalThis as any).__NAPCAT_BRIDGE__ = previousBridge;
    }
});

test('hydrateReplyRecords: 原生查询不可用时从 sourceMsgTextElems 还原图片和视频', async () => {
    const previousBridge = (globalThis as any).__NAPCAT_BRIDGE__;
    (globalThis as any).__NAPCAT_BRIDGE__ = { core: { apis: {} } };

    try {
        const parser = new SimpleMessageParser({ html: 'none' });
        const reply = rawMessage({
            msgId: 'snapshot-reply-id',
            records: [{
                ...rawMessage({ msgId: 'snapshot-id', msgSeq: '7000' }),
                elements: [{ textElement: { content: '[图片]' } }],
            }],
            elements: [{
                replyElement: {
                    replayMsgSeq: '7000',
                    sourceMsgIdInRecords: 'snapshot-id',
                    sourceMsgTextElems: [
                        { picElem: { md5HexStr: 'snapshot-pic-md5', fileName: 'snapshot.jpg' } },
                        { videoElem: { fileName: 'snapshot.mp4', fileUuid: 'video-uuid' } },
                    ],
                },
            }],
        });

        const hydrated = await parser.hydrateReplyRecords([reply]);
        assert.equal(hydrated, 1);
        assert.equal(reply.records.length, 1, '原占位快照应被替换，不应重复追加');
        assert.equal(reply.records[0].elements[0].picElement.md5HexStr, 'snapshot-pic-md5');
        assert.equal(reply.records[0].elements[1].videoElement.fileUuid, 'video-uuid');

        const [parsed] = await parser.parseMessages([reply]);
        const replyData = parsed.content.elements.find(element => element.type === 'reply')!.data;
        assert.deepEqual(replyData.previewElements.map((element: any) => element.type), ['image', 'video']);
        assert.equal(replyData.content, '[图片][视频:snapshot.mp4]');
    } finally {
        if (previousBridge === undefined) delete (globalThis as any).__NAPCAT_BRIDGE__;
        else (globalThis as any).__NAPCAT_BRIDGE__ = previousBridge;
    }
});

test('hydrateReplyRecords: 普通纯文字回复不额外调用原生历史接口', async () => {
    const previousBridge = (globalThis as any).__NAPCAT_BRIDGE__;
    let queryCount = 0;
    (globalThis as any).__NAPCAT_BRIDGE__ = {
        core: {
            apis: {
                MsgApi: {
                    async getMsgsBySeqAndCount() {
                        queryCount++;
                        return { msgList: [] };
                    },
                },
            },
        },
    };

    try {
        const parser = new SimpleMessageParser({ html: 'none' });
        const reply = rawMessage({
            msgId: 'plain-text-reply',
            records: [],
            elements: [{
                replyElement: {
                    replayMsgSeq: '8000',
                    sourceMsgIdInRecords: 'plain-text-source',
                    sourceMsgText: '这是一条普通文字消息',
                },
            }],
        });

        const hydrated = await parser.hydrateReplyRecords([reply]);
        assert.equal(hydrated, 0);
        assert.equal(queryCount, 0);
        assert.equal(reply.records.length, 0);
    } finally {
        if (previousBridge === undefined) delete (globalThis as any).__NAPCAT_BRIDGE__;
        else (globalThis as any).__NAPCAT_BRIDGE__ = previousBridge;
    }
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

test('backfillReplyPreviewLocalPathsFromResourceMap: 回填引用视频的离线路径', () => {
    const parser = new SimpleMessageParser({ html: 'none' });
    const reply = makeReplyMessage('101', '', [
        { type: 'video', text: '[视频:quoted.mp4]', fileName: 'quoted.mp4' },
    ]);
    (reply.content.elements[0]!.data as any).previewResourceMessageId = 'reply-resource-key';
    parser.backfillReplyPreviewLocalPathsFromResourceMap(reply, new Map([
        ['reply-resource-key', [{
            type: 'video',
            localPath: process.execPath,
            accessible: true,
        }]],
    ]));

    const preview = (reply.content.elements[0]!.data as any).previewElements[0];
    assert.equal(preview.localPath, `videos/${process.platform === 'win32' ? 'node.exe' : 'node'}`);
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

test('forward sender avatar: 使用 senderUid 转换真实 QQ 号，不采信外层继承的 senderUin', async () => {
    const previousBridge = (globalThis as any).__NAPCAT_BRIDGE__;
    let conversionCount = 0;
    (globalThis as any).__NAPCAT_BRIDGE__ = {
        core: {
            apis: {
                UserApi: {
                    async getUinByUidV2(uid: string) {
                        conversionCount++;
                        assert.equal(uid, 'u_real_member');
                        return '22334455';
                    },
                },
            },
        },
    };

    try {
        const parser = new SimpleMessageParser({ html: 'none' });
        const children = [1, 2].map(index => rawMessage({
            msgId: `forward-avatar-child-${index}`,
            msgSeq: String(8900 + index),
            senderUid: 'u_real_member',
            senderUin: '1094950020', // 模拟 NapCat 错误继承的外层发送者
            sendNickName: '真实成员',
            elements: [{ textElement: { content: `消息${index}` } }],
        }));
        const top = rawMessage({
            msgId: 'forward-avatar-top',
            records: children,
            elements: [{ multiForwardMsgElement: { resId: 'avatar-res', xmlContent: '' } }],
        });

        const [parsed] = await parser.parseMessages([top]);
        const messages = parsed.content.elements.find(element => element.type === 'forward')!.data.messages;
        assert.equal(messages[0].sender.uin, '22334455');
        assert.equal(messages[0].sender.avatarUrl, 'https://q1.qlogo.cn/g?b=qq&nk=22334455&s=100');
        assert.equal(messages[1].sender.avatarUrl, 'https://q1.qlogo.cn/g?b=qq&nk=22334455&s=100');
        assert.equal(conversionCount, 1, '同一 UID 在同次导出中应只转换一次');
    } finally {
        if (previousBridge === undefined) delete (globalThis as any).__NAPCAT_BRIDGE__;
        else (globalThis as any).__NAPCAT_BRIDGE__ = previousBridge;
    }
});

test('forward sender avatar: UID 无法转换时不使用可疑的外层 senderUin', async () => {
    const previousBridge = (globalThis as any).__NAPCAT_BRIDGE__;
    (globalThis as any).__NAPCAT_BRIDGE__ = { core: { apis: {} } };
    try {
        const parser = new SimpleMessageParser({ html: 'none' });
        const child = rawMessage({
            msgId: 'forward-avatar-safe-child',
            senderUid: 'u_unknown_member',
            senderUin: '1094950020',
            sendNickName: '无法转换成员',
            elements: [{ textElement: { content: '消息' } }],
        });
        const top = rawMessage({
            msgId: 'forward-avatar-safe-top',
            records: [child],
            elements: [{ multiForwardMsgElement: { resId: 'safe-avatar-res', xmlContent: '' } }],
        });

        const [parsed] = await parser.parseMessages([top]);
        const sender = parsed.content.elements.find(element => element.type === 'forward')!.data.messages[0].sender;
        assert.equal(sender.uin, undefined);
        assert.equal(sender.avatarUrl, undefined);
        assert.equal(sender.name, '无法转换成员');
    } finally {
        if (previousBridge === undefined) delete (globalThis as any).__NAPCAT_BRIDGE__;
        else (globalThis as any).__NAPCAT_BRIDGE__ = previousBridge;
    }
});

test('forward sender avatar: 使用原始 MultiMsg 节点自带的签名头像 URL', async () => {
    const previousBridge = (globalThis as any).__NAPCAT_BRIDGE__;
    (globalThis as any).__NAPCAT_BRIDGE__ = {
        core: {
            apis: {
                MsgApi: {
                    async getMultiMsg() {
                        return {
                            msgList: [
                                rawMessage({
                                    msgId: 'shared-forward-id',
                                    msgSeq: 'same-seq',
                                    clientSeq: '71001',
                                    senderUid: '',
                                    senderUin: '1094950020',
                                    sendNickName: '错误名字',
                                    elements: [{ textElement: { content: '第一条' } }],
                                }),
                                rawMessage({
                                    msgId: 'shared-forward-id',
                                    msgSeq: 'same-seq',
                                    clientSeq: '71002',
                                    senderUid: '',
                                    senderUin: '1094950020',
                                    sendNickName: '错误名字',
                                    elements: [{ textElement: { content: '第二条' } }],
                                }),
                            ],
                        };
                    },
                },
                PacketApi: {
                    pkt: {
                        operation: {
                            async FetchForwardMsgRaw(resId: string) {
                                assert.equal(resId, 'identity-res-id');
                                return [{
                                    actionCommand: 'MultiMsg',
                                    actionData: {
                                        msgBody: [
                                            {
                                                contentHead: {
                                                    newId: 'shared-forward-id',
                                                    sequence: 71001,
                                                    forward: { unknownBase64: 'http://qh.qlogo.cn/g?b=oidb&ek=avatar-a&s=0' },
                                                },
                                                responseHead: {
                                                    fromUin: 1094950020,
                                                    fromUid: 'u_anonymous_forward_owner',
                                                    grp: { memberName: '成员甲' },
                                                },
                                            },
                                            {
                                                contentHead: {
                                                    newId: 'shared-forward-id',
                                                    sequence: 71002,
                                                    forward: { unknownBase64: 'http://qh.qlogo.cn/g?b=oidb&ek=avatar-b&s=0' },
                                                },
                                                responseHead: {
                                                    fromUin: 1094950020,
                                                    fromUid: 'u_anonymous_forward_owner',
                                                    grp: { memberName: '成员乙' },
                                                },
                                            },
                                        ],
                                    },
                                }];
                            },
                        },
                    },
                },
            },
        },
        actions: { get() { return undefined; } },
    };

    try {
        const parser = new SimpleMessageParser({ html: 'none' });
        const top = rawMessage({
            msgId: 'identity-forward-top',
            records: [],
            elements: [{
                multiForwardMsgElement: {
                    resId: 'identity-res-id',
                    xmlContent: '<msg><summary>2条转发消息</summary></msg>',
                },
            }],
        });

        await parser.hydrateForwardRecords([top]);
        assert.deepEqual(top.records.map((record: any) => ({
            uid: record.senderUid,
            uin: record.senderUin,
            name: record.sendNickName,
            avatarUrl: record.avatarUrl,
            protocolAvatar: record.__qceForwardProtocolAvatar,
        })), [
            {
                uid: '',
                uin: '1094950020',
                name: '成员甲',
                avatarUrl: 'http://qh.qlogo.cn/g?b=oidb&ek=avatar-a&s=0',
                protocolAvatar: true,
            },
            {
                uid: '',
                uin: '1094950020',
                name: '成员乙',
                avatarUrl: 'http://qh.qlogo.cn/g?b=oidb&ek=avatar-b&s=0',
                protocolAvatar: true,
            },
        ]);

        const [parsed] = await parser.parseMessages([top]);
        const messages = parsed.content.elements.find(element => element.type === 'forward')!.data.messages;
        assert.equal(messages[0].sender.name, '成员甲');
        assert.equal(messages[0].sender.uid, undefined);
        assert.equal(messages[0].sender.uin, undefined);
        assert.equal(messages[0].sender.avatarUrl, 'http://qh.qlogo.cn/g?b=oidb&ek=avatar-a&s=0');
        assert.equal(messages[1].sender.name, '成员乙');
        assert.equal(messages[1].sender.uid, undefined);
        assert.equal(messages[1].sender.uin, undefined);
        assert.equal(messages[1].sender.avatarUrl, 'http://qh.qlogo.cn/g?b=oidb&ek=avatar-b&s=0');
    } finally {
        if (previousBridge === undefined) delete (globalThis as any).__NAPCAT_BRIDGE__;
        else (globalThis as any).__NAPCAT_BRIDGE__ = previousBridge;
    }
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
        assert.equal((top.records[0] as any).__qceForwardPeer.peerUid, top.peerUid);
    } finally {
        if (previousBridge === undefined) {
            delete (globalThis as any).__NAPCAT_BRIDGE__;
        } else {
            (globalThis as any).__NAPCAT_BRIDGE__ = previousBridge;
        }
    }
});

test('hydrateForwardRecords: 保留 forward.data.content 中的深层聊天记录', async () => {
    const previousBridge = (globalThis as any).__NAPCAT_BRIDGE__;
    (globalThis as any).__NAPCAT_BRIDGE__ = {
        core: { apis: {} },
        actions: {
            get(name: string) {
                if (name !== 'get_forward_msg') return undefined;
                return {
                    async handle() {
                        return {
                            data: {
                                messages: [{
                                    message_id: 'middle-message',
                                    message_seq: 9001,
                                    time: 1700000200,
                                    user_id: 10002,
                                    sender: { nickname: '中层用户' },
                                    message: [{
                                        type: 'forward',
                                        data: {
                                            id: 'deep-forward',
                                            content: [{
                                                message_id: 'deep-message',
                                                message_seq: 9002,
                                                time: 1700000201,
                                                user_id: 10003,
                                                sender: { nickname: '深层用户' },
                                                message: [{ type: 'text', data: { text: '深层正文' } }],
                                            }],
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
            msgId: 'nested-forward-top',
            records: [],
            elements: [{
                multiForwardMsgElement: {
                    resId: 'outer-forward',
                    xmlContent: '<msg><summary>1条转发消息</summary></msg>',
                },
            }],
        });

        const hydrated = await parser.hydrateForwardRecords([top]);
        assert.equal(hydrated, 1);
        assert.equal(top.records[0].records[0].elements[0].textElement.content, '深层正文');

        const [parsed] = await parser.parseMessages([top]);
        const outer = parsed.content.elements.find(element => element.type === 'forward')!.data;
        const nested = outer.messages[0].content.elements.find((element: any) => element.type === 'forward');
        assert.equal(nested.data.messages[0].sender.name, '深层用户');
        assert.equal(nested.data.messages[0].content.text, '深层正文');
        assert.doesNotMatch(nested.data.messages[0].content.text, /\[空消息\]/);
    } finally {
        if (previousBridge === undefined) {
            delete (globalThis as any).__NAPCAT_BRIDGE__;
        } else {
            (globalThis as any).__NAPCAT_BRIDGE__ = previousBridge;
        }
    }
});

test('hydrateForwardRecords: 兼容 NapCat parseForward 的 node.data.message 深层节点', async () => {
    const previousBridge = (globalThis as any).__NAPCAT_BRIDGE__;
    (globalThis as any).__NAPCAT_BRIDGE__ = {
        core: { apis: {} },
        actions: {
            get(name: string) {
                if (name !== 'get_forward_msg') return undefined;
                return {
                    async handle() {
                        // 精确模拟当前 NapCat GoCQHTTPGetForwardMsgAction.parseForward：
                        // 每条消息是 node，嵌套的聊天记录也是 node，并挂在 data.message。
                        return {
                            data: {
                                messages: [{
                                    type: 'node',
                                    data: {
                                        user_id: '10002',
                                        nickname: '中层用户',
                                        message: [{
                                            type: 'node',
                                            data: {
                                                user_id: '10002',
                                                nickname: '中层用户',
                                                message: [{
                                                    type: 'node',
                                                    data: {
                                                        user_id: '10003',
                                                        nickname: '深层用户',
                                                        message: [{ type: 'text', data: { text: '真实深层正文' } }],
                                                        content: [],
                                                    },
                                                }],
                                                content: [],
                                            },
                                        }],
                                        content: [],
                                    },
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
            msgId: 'nested-node-message-top',
            records: [],
            elements: [{
                multiForwardMsgElement: {
                    resId: 'outer-node-forward',
                    xmlContent: '<msg><summary>1条转发消息</summary></msg>',
                },
            }],
        });

        const hydrated = await parser.hydrateForwardRecords([top]);
        assert.equal(hydrated, 1);
        assert.equal(top.records[0].records[0].elements[0].textElement.content, '真实深层正文');

        const [parsed] = await parser.parseMessages([top]);
        const outer = parsed.content.elements.find(element => element.type === 'forward')!.data;
        const nested = outer.messages[0].content.elements.find((element: any) => element.type === 'forward');
        assert.ok(nested, 'node.data.message 应被还原为嵌套 forward 元素');
        assert.equal(nested.data.messages[0].sender.name, '深层用户');
        assert.equal(nested.data.messages[0].content.text, '真实深层正文');
        assert.doesNotMatch(nested.data.messages[0].content.text, /\[空消息\]/);
    } finally {
        if (previousBridge === undefined) {
            delete (globalThis as any).__NAPCAT_BRIDGE__;
        } else {
            (globalThis as any).__NAPCAT_BRIDGE__ = previousBridge;
        }
    }
});

test('hydrateForwardRecords: 使用 NapCat 位置参数并保留深层转发的 rootMsgId', async () => {
    const previousBridge = (globalThis as any).__NAPCAT_BRIDGE__;
    const calls: Array<{ peer: any; rootMsgId: string; parentMsgId: string }> = [];
    (globalThis as any).__NAPCAT_BRIDGE__ = {
        core: {
            apis: {
                MsgApi: {
                    async getMultiMsg(peer: any, rootMsgId: string, parentMsgId: string) {
                        calls.push({ peer, rootMsgId, parentMsgId });
                        if (rootMsgId === 'root-forward' && parentMsgId === 'root-forward') {
                            return {
                                msgList: [rawMessage({
                                    msgId: 'middle-node',
                                    peerUid: '',
                                    elements: [{
                                        multiForwardMsgElement: {
                                            resId: 'inner-res-id',
                                            xmlContent: '<msg><summary>1条转发消息</summary></msg>',
                                        },
                                    }],
                                })],
                            };
                        }
                        if (rootMsgId === 'root-forward' && parentMsgId === 'middle-node') {
                            return {
                                msgList: [rawMessage({
                                    msgId: 'deep-node',
                                    peerUid: '',
                                    sendNickName: '深层用户',
                                    elements: [{ textElement: { content: '原生深层正文' } }],
                                })],
                            };
                        }
                        return { msgList: [] };
                    },
                },
            },
        },
        actions: { get() { return undefined; } },
    };

    try {
        const parser = new SimpleMessageParser({ html: 'none' });
        const top = rawMessage({
            msgId: 'root-forward',
            peerUid: 'real-group-peer',
            records: [],
            elements: [{
                multiForwardMsgElement: {
                    resId: 'outer-res-id',
                    xmlContent: '<msg><summary>1条转发消息</summary></msg>',
                },
            }],
        });

        const hydrated = await parser.hydrateForwardRecords([top]);
        assert.equal(hydrated, 2);
        assert.deepEqual(calls.map(call => ({
            peerUid: call.peer.peerUid,
            rootMsgId: call.rootMsgId,
            parentMsgId: call.parentMsgId,
        })), [
            { peerUid: 'real-group-peer', rootMsgId: 'root-forward', parentMsgId: 'root-forward' },
            { peerUid: 'real-group-peer', rootMsgId: 'root-forward', parentMsgId: 'middle-node' },
        ]);
        assert.equal(top.records[0].records[0].elements[0].textElement.content, '原生深层正文');

        const [parsed] = await parser.parseMessages([top]);
        const outer = parsed.content.elements.find(element => element.type === 'forward')!.data;
        const nested = outer.messages[0].content.elements.find((element: any) => element.type === 'forward');
        assert.equal(nested.data.messages[0].content.text, '原生深层正文');
        assert.doesNotMatch(nested.data.messages[0].content.text, /\[空消息\]/);
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

test('深层转发资源键包含父层命名空间，避免跨层 msgId 冲突', () => {
    const parser = new SimpleMessageParser({ html: 'none' }) as any;
    const parent = rawMessage({ msgId: 'shared-id' }) as any;
    parent.__qceResourceKey = 'shared-id-53767';
    const child = rawMessage({ msgId: 'shared-id', clientSeq: '53767' });

    const [assigned] = parser.assignForwardResourceKeys([child], parent);

    assert.equal(assigned.__qceResourceKey, 'shared-id-53767/shared-id');
});
