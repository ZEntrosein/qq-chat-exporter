/**
 * Issue #434: 嵌套合并转发（[聊天记录]里又套了一层[聊天记录]）应递归渲染成内层卡片，
 * 而不是只显示一行"[转发消息]"占位。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ModernHtmlExporter } from '../../lib/core/exporter/ModernHtmlExporter.js';
import { createTempDir } from '../helpers/tempDir.js';
import { silenceConsole } from '../helpers/silenceConsole.js';

let console_!: ReturnType<typeof silenceConsole>;
let tmp!: ReturnType<typeof createTempDir>;

test.beforeEach(() => {
    console_ = silenceConsole();
    tmp = createTempDir();
});

test.afterEach(() => {
    tmp.cleanup();
    console_.restore();
});

async function renderMessage(message: any): Promise<string> {
    const outputDir = path.join(tmp.path, 'out');
    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'chat.html');
    const exporter = new ModernHtmlExporter({
        outputPath,
        includeResourceLinks: true,
        includeSystemMessages: true
    });
    async function* iter() {
        yield message;
    }
    await exporter.exportFromIterable(iter(), { name: 'Alice', type: 'private' });
    return fs.readFileSync(outputPath, 'utf8');
}

test('nested merged-forward is rendered recursively as inner cards (#434)', async () => {
    // 外层转发里有一条子消息，这条子消息本身又是一层转发，里面装着两条最里层消息。
    const innerForward = {
        type: 'forward',
        data: {
            title: '聊天记录',
            messageCount: 2,
            messages: [
                { sender: { name: '深层用户甲' }, content: { text: '最里层消息一', elements: [{ type: 'text', data: { text: '最里层消息一' } }] } },
                { sender: { name: '深层用户乙' }, content: { text: '最里层消息二', elements: [{ type: 'text', data: { text: '最里层消息二' } }] } }
            ]
        }
    };

    const message: any = {
        id: 'm_1',
        timestamp: Date.now(),
        sender: { id: 'u_alice', uin: '11111', name: 'Alice' },
        chatType: 1,
        peer: { peerUid: 'u_alice' },
        content: {
            elements: [
                {
                    type: 'forward',
                    data: {
                        title: '聊天记录',
                        messageCount: 1,
                        messages: [
                            {
                                sender: { name: '中层用户' },
                                content: { text: '[转发消息: 2条]', elements: [innerForward] }
                            }
                        ]
                    }
                }
            ]
        }
    };

    const html = await renderMessage(message);

    // 最里层的发送者与消息内容必须出现，说明递归展开成功，而不是停在占位文本。
    assert.ok(html.includes('深层用户甲'), 'innermost sender 深层用户甲 should be rendered');
    assert.ok(html.includes('最里层消息一'), 'innermost message body should be rendered');
    assert.ok(html.includes('深层用户乙'), 'second innermost sender should be rendered');
    // 内层卡片应带 forward-card-nested 标记。
    assert.ok(html.includes('forward-card-nested'), 'nested forward card class should be present');
    // 占位文本"[转发消息: 2条]"被内层卡片替代，不应再作为正文出现。
    assert.ok(!html.includes('[转发消息: 2条]'), 'placeholder text should be replaced by the nested card');
});

test('forward render depth is capped to avoid runaway nesting (#434)', async () => {
    // 构造超过上限的深层嵌套，确保不抛错且能正常导出。
    const makeForward = (depth: number): any => {
        if (depth === 0) {
            return { sender: { name: '叶子' }, content: { text: '叶子消息', elements: [{ type: 'text', data: { text: '叶子消息' } }] } };
        }
        const child = makeForward(depth - 1);
        return {
            sender: { name: `第${depth}层` },
            content: {
                text: '[转发消息: 1条]',
                elements: [{ type: 'forward', data: { title: '聊天记录', messageCount: 1, messages: [child] } }]
            }
        };
    };

    const message: any = {
        id: 'm_deep',
        timestamp: Date.now(),
        sender: { id: 'u_alice', uin: '11111', name: 'Alice' },
        chatType: 1,
        peer: { peerUid: 'u_alice' },
        content: {
            elements: [
                { type: 'forward', data: { title: '聊天记录', messageCount: 1, messages: [makeForward(6)] } }
            ]
        }
    };

    const html = await renderMessage(message);
    // 不抛错即视为通过；浅层应渲染出来。
    assert.ok(html.includes('第6层') || html.includes('第5层'), 'shallow nesting levels should render');
});

test('merged-forward card expands to every inner message with rich media', async () => {
    const innerMessages = Array.from({ length: 7 }, (_, index) => ({
        id: `inner-${index}`,
        timestamp: Date.UTC(2026, 0, 1, 8, index),
        time: new Date(Date.UTC(2026, 0, 1, 8, index)).toISOString(),
        sender: { name: `成员${index + 1}`, uin: String(10001 + index) },
        content: {
            text: index === 0 ? '[图片:detail.png]' : `完整消息${index + 1}`,
            elements: index === 0
                ? [{ type: 'image', data: { filename: 'detail.png', localPath: 'images/detail.png' } }]
                : [{ type: 'text', data: { text: `完整消息${index + 1}` } }],
        },
    }));
    const message: any = {
        id: 'm_expandable',
        timestamp: Date.now(),
        sender: { id: 'u_alice', uin: '11111', name: 'Alice' },
        content: {
            elements: [{
                type: 'forward',
                data: { title: '项目讨论', messageCount: innerMessages.length, messages: innerMessages },
            }],
        },
    };

    const html = await renderMessage(message);

    assert.ok(html.includes('<details class="forward-card forward-card-expandable">'));
    assert.ok(html.includes('<summary class="forward-card-summary"'));
    assert.ok(html.includes('forward-card-action-expand">展开'));
    assert.ok(html.includes('forward-card-action-collapse">收起'));
    assert.equal((html.match(/class="forward-message-item"/g) || []).length, 7);
    assert.equal((html.match(/class="forward-message-avatar"/g) || []).length, 7);
    assert.ok(html.includes('src="https://q1.qlogo.cn/g?b=qq&amp;nk=10001&amp;s=100"'), '应按子消息 QQ 号显示头像');
    assert.ok(html.includes('class="forward-message-avatar-fallback"'), '头像加载失败时应有文字兜底');
    assert.ok(html.includes('完整消息7'), 'messages beyond the five-line preview must be retained');
    assert.ok(html.includes('src="./resources/images/detail.png"'), 'inner images should render in details');
    assert.ok(html.includes('<time class="forward-message-time">'), 'inner message timestamps should render');
});

test('forward cards without saved inner messages explain why they cannot expand', async () => {
    const html = await renderMessage({
        id: 'm_unavailable',
        timestamp: Date.now(),
        sender: { id: 'u_alice', name: 'Alice' },
        content: {
            elements: [{
                type: 'forward',
                data: { title: '聊天记录', messageCount: 12, messages: [] },
            }],
        },
    });

    assert.ok(html.includes('forward-card-unavailable'));
    assert.ok(html.includes('详情未随导出保存'));
    assert.ok(!html.includes('<details class="forward-card forward-card-expandable'));
});

test('merged-forward sender without QQ number uses a visible text avatar fallback', () => {
    const exporter = new ModernHtmlExporter({ outputPath: 'unused.html' });
    const html = (exporter as any).renderForwardElement({
        title: '聊天记录',
        messages: [{
            sender: { uid: 'u_internal', name: '测试用户' },
            content: { text: '消息', elements: [{ type: 'text', data: { text: '消息' } }] },
        }],
    });

    assert.match(html, /class="forward-message-avatar"/);
    assert.match(html, /class="forward-message-avatar-fallback" style="display:inline-flex">测<\/span>/);
    assert.doesNotMatch(html, /qlogo\.cn/);
});

test('forward preview hides bare media hashes from OneBot filenames', () => {
    const exporter = new ModernHtmlExporter({ outputPath: 'unused.html' });
    const html = (exporter as any).renderForwardElement({
        title: '聊天记录',
        messages: [{
            id: 'child-1',
            timestamp: 1700000000000,
            sender: { name: '用户' },
            content: {
                text: '[图片:8d0e5bf2171d671429eac107b9590a9c]',
                elements: [{
                    type: 'image',
                    data: { filename: '8d0e5bf2171d671429eac107b9590a9c' },
                }],
            },
        }],
    });

    const previewBody = html.match(/forward-card-body">([^<]+)</)?.[1] || '';
    assert.equal(previewBody, '[图片]');
    assert.doesNotMatch(previewBody, /8d0e5bf2171d671429eac107b9590a9c/);
});

test('resource collection descends into merged-forward details', () => {
    const exporter = new ModernHtmlExporter({
        outputPath: path.join(tmp.path, 'out', 'chat.html'),
        includeResourceLinks: true,
    }) as any;
    const resources = Array.from(exporter.iterResources({
        content: {
            resources: [],
            elements: [{
                type: 'forward',
                data: {
                    messages: [{
                        content: {
                            elements: [
                                { type: 'image', data: { filename: 'inner.jpg', localPath: 'images/inner.jpg' } },
                                { type: 'video', data: { filename: 'inner.mp4', localPath: 'videos/inner.mp4' } },
                            ],
                        },
                    }],
                },
            }],
        },
    }));

    assert.deepEqual(resources.map((resource: any) => resource.type), ['image', 'video']);
    assert.deepEqual(resources.map((resource: any) => resource.fileName), ['inner.jpg', 'inner.mp4']);
});
