import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { MODERN_SINGLE_APP_JS } from '../../lib/core/exporter/ModernHtmlTemplates.js';

class FakeElement {
    public children: FakeElement[] = [];
    public style: Record<string, string> = {};
    public attributes = new Map<string, string>();
    public className = '';
    public height: number;
    public id: string;
    public isFragment = false;
    private absoluteTop: number;

    constructor(id = '', height = 0, absoluteTop = 0) {
        this.id = id;
        this.height = height;
        this.absoluteTop = absoluteTop;
    }

    get classList() {
        return { add() {}, remove() {} };
    }

    appendChild(child: FakeElement) {
        if (child.isFragment) this.children.push(...child.children);
        else this.children.push(child);
        return child;
    }

    set innerHTML(_value: string) {
        this.children = [];
    }

    get innerHTML() {
        return '';
    }

    setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
    }

    getAttribute(name: string) {
        return this.attributes.get(name) ?? null;
    }

    querySelector(selector: string) {
        if (selector === '.message') return { id: this.id };
        return null;
    }

    querySelectorAll() {
        return [];
    }

    cloneNode() {
        const clone = new FakeElement(this.id, this.height, this.absoluteTop);
        clone.attributes = new Map(this.attributes);
        return clone;
    }

    getBoundingClientRect() {
        const pageYOffset = Number((globalThis as any).__qceTestPageYOffset || 0);
        return { top: this.absoluteTop - pageYOffset, height: this.height };
    }
}

function loadVirtualScroller() {
    const container = new FakeElement('', 0, 100);
    const windowObject: any = {
        pageYOffset: 0,
        innerHeight: 250,
        addEventListener() {},
        removeEventListener() {},
        scrollTo(options: any) {
            this.pageYOffset = typeof options === 'number' ? options : options.top;
            (globalThis as any).__qceTestPageYOffset = this.pageYOffset;
        },
        scrollBy(_x: number, y: number) {
            this.pageYOffset += y;
            (globalThis as any).__qceTestPageYOffset = this.pageYOffset;
        },
        getComputedStyle() {
            return { marginTop: '0', marginBottom: '0', backgroundColor: 'transparent' };
        },
    };
    const documentObject: any = {
        documentElement: { scrollTop: 0 },
        createElement() { return new FakeElement(); },
        createDocumentFragment() {
            const fragment = new FakeElement();
            fragment.isFragment = true;
            return fragment;
        },
        addEventListener() {},
    };
    const context: any = {
        window: windowObject,
        document: documentObject,
        requestAnimationFrame(callback: () => void) { callback(); },
        setTimeout,
        clearTimeout,
        console,
        Map,
        Array,
        Number,
        Math,
        parseFloat,
    };
    vm.runInNewContext(
        `${MODERN_SINGLE_APP_JS}\n;globalThis.VirtualScrollerForTest = VirtualScroller;`,
        context,
    );
    return { VirtualScroller: context.VirtualScrollerForTest, container, windowObject };
}

function item(id: string, height: number) {
    const element = new FakeElement(id, height);
    element.setAttribute('data-qce-virtual-height', String(height));
    return element;
}

test('dynamic virtual scroller indexes variable message heights and updates measurements', () => {
    (globalThis as any).__qceTestPageYOffset = 0;
    const { VirtualScroller, container } = loadVirtualScroller();
    const scroller = new VirtualScroller(container, [
        item('msg-1', 80),
        item('msg-2', 200),
        item('msg-3', 50),
        item('msg-4', 300),
    ], { itemHeight: 120, bufferSize: 1 });

    assert.deepEqual(Array.from(scroller.itemOffsets), [0, 80, 280, 330, 630]);
    assert.equal(scroller.findIndexAtOffset(79), 0);
    assert.equal(scroller.findIndexAtOffset(80), 1);
    assert.equal(scroller.findIndexAtOffset(329), 2);

    const firstRendered = scroller.content.children.find(
        (entry: FakeElement) => entry.getAttribute('data-qce-virtual-index') === '0',
    );
    assert.ok(firstRendered);
    firstRendered.height = 140;
    // 模拟图片加载完成后，同一消息再次 clone 时也具有新的固有高度。
    scroller.allItems[0].height = 140;
    scroller.measureRenderedItems();

    assert.deepEqual(Array.from(scroller.itemOffsets), [0, 140, 340, 390, 690]);
    assert.equal(scroller.spacer.style.height, '690px');
});

test('scrollToIndex uses cumulative measured height instead of index × fixed height', () => {
    (globalThis as any).__qceTestPageYOffset = 0;
    const { VirtualScroller, container, windowObject } = loadVirtualScroller();
    const scroller = new VirtualScroller(container, [
        item('msg-1', 80),
        item('msg-2', 200),
        item('msg-3', 50),
    ], { itemHeight: 120, bufferSize: 1 });

    scroller.scrollToIndex(2);

    // 容器绝对 top=100，第三项累计 offset=80+200=280。
    assert.equal(windowObject.pageYOffset, 380);
});

test('height changes above the viewport preserve the visible anchor position', () => {
    (globalThis as any).__qceTestPageYOffset = 0;
    const { VirtualScroller, container, windowObject } = loadVirtualScroller();
    const scroller = new VirtualScroller(container, [
        item('msg-1', 80),
        item('msg-2', 200),
        item('msg-3', 50),
        item('msg-4', 300),
    ], { itemHeight: 120, bufferSize: 1 });

    // 第三条消息内向下 10px：容器 top 100 + 前两条 280 + 10。
    windowObject.pageYOffset = 390;
    (globalThis as any).__qceTestPageYOffset = 390;
    scroller.update();
    const secondRendered = scroller.content.children.find(
        (entry: FakeElement) => entry.getAttribute('data-qce-virtual-index') === '1',
    );
    assert.ok(secondRendered);

    // 视口上方的第二条增加 40px，页面也应补偿滚动 40px，第三条保持原位。
    secondRendered.height = 240;
    scroller.allItems[1].height = 240;
    scroller.measureRenderedItems();

    assert.equal(windowObject.pageYOffset, 430);
    assert.deepEqual(Array.from(scroller.itemOffsets), [0, 80, 320, 370, 670]);
});

test('filtering to zero messages clears the rendered virtual window', () => {
    (globalThis as any).__qceTestPageYOffset = 0;
    const { VirtualScroller, container } = loadVirtualScroller();
    const scroller = new VirtualScroller(container, [item('msg-1', 80)], {
        itemHeight: 120,
        bufferSize: 1,
    });
    assert.ok(scroller.content.children.length > 0);

    scroller.updateItems([]);

    assert.equal(scroller.content.children.length, 0);
    assert.equal(scroller.spacer.style.height, '0px');
    assert.equal(scroller.content.style.transform, 'translateY(0px)');
});

test('ordinary scrolling inside the buffered window does not rebuild the DOM', () => {
    (globalThis as any).__qceTestPageYOffset = 0;
    const { VirtualScroller, container, windowObject } = loadVirtualScroller();
    const items = Array.from({ length: 100 }, (_, index) => item(`msg-${index}`, 100));
    const scroller = new VirtualScroller(container, items, { itemHeight: 100, bufferSize: 10 });
    const originalRender = scroller.render.bind(scroller);
    let renderCount = 0;
    scroller.render = () => {
        renderCount++;
        originalRender();
    };

    // 容器 top=100；滚动到列表内 110px，仍远离初始缓冲窗口边缘。
    windowObject.pageYOffset = 210;
    (globalThis as any).__qceTestPageYOffset = 210;
    scroller.update();

    assert.equal(renderCount, 0);
});

test('large variable-height lists keep index jumps monotonic and render the target window', () => {
    (globalThis as any).__qceTestPageYOffset = 0;
    const { VirtualScroller, container, windowObject } = loadVirtualScroller();
    const heights = Array.from({ length: 1000 }, (_, index) => [64, 118, 286, 92][index % 4]!);
    const items = heights.map((height, index) => item(`msg-${index}`, height));
    const scroller = new VirtualScroller(container, items, { itemHeight: 120, bufferSize: 30 });
    let previousScrollTop = -1;

    for (let index = 0; index < items.length; index += 37) {
        scroller.scrollToIndex(index);
        assert.ok(windowObject.pageYOffset > previousScrollTop);
        previousScrollTop = windowObject.pageYOffset;
        assert.equal(
            scroller.content.children.some(
                (entry: FakeElement) => entry.getAttribute('data-qce-virtual-index') === String(index),
            ),
            true,
        );
    }

    assert.equal(scroller.totalHeight, heights.reduce((sum, height) => sum + height, 0));
});
