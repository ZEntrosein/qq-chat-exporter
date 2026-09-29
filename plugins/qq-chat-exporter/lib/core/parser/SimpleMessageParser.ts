/**
 * 简化消息解析器
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { RawMessage, MessageElement, NTMsgType } from 'NapCatQQ/src/core/types.js';
import { parseMultiForwardXml, looksLikeMultiForwardXml } from './multiForwardXmlParser.js';

/* ------------------------------ 内部高性能工具 ------------------------------ */

/** 并发限流 map（保持顺序） */
async function mapLimit<T, R>(
  arr: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const len = arr.length;
  const out = new Array<R>(len);
  if (len === 0) return out;

  const workers = Math.min((limit >>> 0) || 1, len);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= len) break;
      out[i] = await mapper(arr[i]!, i);
    }
  }
  const tasks = new Array(workers);
  for (let i = 0; i < workers; i++) tasks[i] = worker();
  await Promise.all(tasks);
  return out;
}

function resolveConcurrency(): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('os');
    const cores = (os?.cpus?.() || []).length || 4;
    return Math.max(4, Math.min(32, cores * 2));
  } catch {
    return 8;
  }
}

/** 让出事件循环 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof setImmediate === 'function') setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

/** Chunked 字符串构建器 */
class ChunkedBuilder {
  private chunks: string[] = [];
  push(s: string | undefined | null) {
    if (s) this.chunks.push(s);
  }
  toString() {
    return this.chunks.join('');
  }
  clear() {
    this.chunks.length = 0;
  }
}

const NEED_ESCAPE_RE = /[&<>"']/;
function escapeHtmlFast(text: string): string {
  if (!text) return '';
  if (!NEED_ESCAPE_RE.test(text)) return text;
  const len = text.length;
  let out = '';
  let last = 0;
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    let rep: string | null = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep) {
      if (i > last) out += text.slice(last, i);
      out += rep;
      last = i + 1;
    }
  }
  if (last < len) out += text.slice(last);
  return out;
}

/** RFC3339（UTC）格式化工具 */
function pad2(n: number) {
  return n < 10 ? '0' + n : '' + n;
}
function pad3(n: number) {
  if (n >= 100) return '' + n;
  if (n >= 10) return '0' + n;
  return '00' + n;
}
function pad4(n: number) {
  if (n >= 1000) return '' + n;
  if (n >= 100) return '0' + n;
  if (n >= 10) return '00' + n;
  return '000' + n;
}
function rfc3339FromMillis(ms: number): string {
  const d = new Date(ms);
  return `${pad4(d.getUTCFullYear())}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(
    d.getUTCHours()
  )}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}.${pad3(d.getUTCMilliseconds())}Z`;
}
function rfc3339FromUnixSeconds(sec: number | string | bigint): string {
  try {
    if (typeof sec === 'bigint') {
      const n = Number(sec * 1000n);
      return Number.isFinite(n) ? rfc3339FromMillis(n) : '1970-01-01T00:00:00.000Z';
    }
    const n = typeof sec === 'string' ? parseInt(sec, 10) : sec;
    if (!Number.isFinite(n)) return '1970-01-01T00:00:00.000Z';
    return rfc3339FromMillis(Math.trunc(n * 1000));
  } catch {
    return '1970-01-01T00:00:00.000Z';
  }
}
function millisFromUnixSeconds(sec: number | string | bigint): number {
  try {
    if (typeof sec === 'bigint') {
      const n = Number(sec * 1000n);
      return Number.isFinite(n) ? n : 0;
    }
    const n = typeof sec === 'string' ? parseInt(sec, 10) : sec;
    return Number.isFinite(n) ? Math.trunc(n * 1000) : 0;
  } catch {
    return 0;
  }
}

/** 高性能 JSON 解析（SIMD 优先） */
type FastJsonParser = (s: string) => any;
let fastJsonParse: FastJsonParser = (s) => JSON.parse(s);
(function tryLoadSimdJson() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = typeof require !== 'undefined' ? require('simdjson') : null;
    if (mod && typeof mod.parse === 'function') {
      fastJsonParse = (s) => mod.parse(s);
    }
  } catch {
    // 静默降级
  }
})();

/* ------------------------------ 导出类型（保持不变） ------------------------------ */

export interface CleanMessage {
  id: string;
  seq: string;
  timestamp: number;
  time: string;
  sender: {
    uid: string;
    uin?: string;
    name: string;          // 优先显示的名称（群昵称 > 备注 > QQ昵称）
    nickname?: string;     // QQ昵称（原始昵称）
    groupCard?: string;    // 群名片/群昵称
    remark?: string;       // 好友备注
    title?: string;        // 群头衔（仅群聊）
  };
  type: string;
  content: MessageContent;
  recalled: boolean;
  system: boolean;
}

export interface MessageContent {
  text: string;
  html: string;
  elements: MessageElementData[];
  resources: ResourceData[];
  mentions: MentionData[];
}

export interface MentionData {
  uid: string;
  uin?: string;
  name: string;
  type: 'user' | 'all';
}

export interface MessageElementData {
  type: string;
  data: any;
}

/**
 * issue #128 子项：回复框（reply 元素）里被引用消息的结构化预览片段。
 * 文本字段 `content` 仍保持「[图片]」「[表情341]」等占位串以兼容
 * JSON / TXT / Excel 等纯文本导出；HTML 导出额外消费 previewElements
 * 来渲染图片缩略图 / 表情图等。
 *
 * `localPath` / `url` 字段在解析阶段写不进来——picElement.sourcePath 是 NT
 * 自身的缓存路径，而不是导出的 resources/ 路径。这两个字段会在
 * `updateSingleMessageResourcePaths` 的二次回填里被写上。
 */
export interface ReplyPreviewElement {
  type: 'text' | 'image' | 'video' | 'audio' | 'file' | 'face' | 'marketFace';
  text: string;
  /** image: picElement.md5HexStr，用于跨消息匹配下载后的资源条目 */
  md5?: string;
  /** image: picElement.originImageUrl，回退兜底（QQ 临时签名 URL，会过期） */
  originUrl?: string;
  /** image / video / file: 原始文件名 */
  fileName?: string;
  /** marketFace: 表情包名 */
  faceName?: string;
  /** marketFace: 表情包静态 URL */
  url?: string;
  /** face: 系统小表情 id */
  faceIndex?: number;
  /** updateResourcePaths 二次回填出来的导出包内相对路径，例：images/abc.jpg */
  localPath?: string;
}

/**
 * 合并转发消息卡片里嵌套的子消息。
 * 字段刻意保持扁平，方便直接序列化到 JSON / JSONL，也方便 TXT 导出按行渲染。
 */
export interface ForwardInnerMessage {
  /** 子消息的 msgId，缺失时为空字符串 */
  id: string;
  /** 子消息时间戳（ms），无法解析时为 0 */
  timestamp: number;
  /** ISO 时间，缺失时退到 UNIX 0 */
  time: string;
  sender: {
    uid?: string;
    uin?: string;
    name: string;
    /** 子消息发送者头像；原数据未携带时按 QQ 号生成 qlogo 地址。 */
    avatarUrl?: string;
  };
  content: {
    text: string;
    elements: MessageElementData[];
  };
}

interface ForwardPacketIdentity {
  index: number;
  used: boolean;
  msgId: string;
  seq: string;
  uid: string;
  uin: string;
  name: string;
  avatarUrl: string;
  sourcePeer?: {
    chatType: number;
    peerUid: string;
    guildId: string;
  };
}

export interface ResourceData {
  type: string;
  filename: string;
  size: number;
  url?: string;
  localPath?: string;
  width?: number;
  height?: number;
  duration?: number;
}

export interface MessageStatistics {
  total: number;
  byType: Record<string, number>;
  bySender: Record<string, { uid: string; uin?: string; count: number }>;
  resources: {
    total: number;
    byType: Record<string, number>;
    totalSize: number;
  };
  timeRange: {
    start: string;
    end: string;
    durationDays: number;
  };
}

/**
 * 发件人群头衔解析器：根据 senderUid 或 senderUin 返回该发件人在当前群里的头衔。
 * 调用侧（例如 ApiServer）负责在导出前预拉取群成员信息。
 */
export type SenderTitleResolver = (uid: string | undefined, uin: string | undefined) => string | undefined;

/** 轻量解析器配置 */
export interface SimpleParserOptions {
  concurrency?: number;
  progressEvery?: number;
  yieldEvery?: number;
  html?: 'full' | 'none';
  preferGroupMemberName?: boolean;
  /** 可选的发件人群头衔解析器，错误会被吞掉。返回空字符串或 undefined 代表“无头衔”。 */
  senderTitleResolver?: SenderTitleResolver;
  onProgress?: (processed: number, total: number) => void;
}

const DEFAULT_SIMPLE_OPTIONS: Required<Omit<SimpleParserOptions, 'onProgress' | 'senderTitleResolver'>> = {
  concurrency: resolveConcurrency(),
  progressEvery: 100,
  yieldEvery: 1000,
  html: 'full',
  preferGroupMemberName: true
};

/* ---------------------------------- 主类 ---------------------------------- */

export class SimpleMessageParser {
  /** 嵌套合并转发递归深度上限。三层基本足够，再深就不展开避免栈/性能爆炸。 */
  private static readonly MAX_FORWARD_DEPTH = 3;
  /** 回复链可以再引用另一条回复，限制回溯深度避免异常数据形成环。 */
  private static readonly MAX_REPLY_DEPTH = 6;

  private readonly options: Required<Omit<SimpleParserOptions, 'onProgress' | 'senderTitleResolver'>> & {
    senderTitleResolver?: SenderTitleResolver;
  };
  private readonly onProgress?: (processed: number, total: number) => void;

  private readonly concurrency: number;

  // 全局消息映射，用于查找被引用的消息
  private messageMap: Map<string, RawMessage> = new Map();

  // 只有顶层消息才会被渲染成带 id 的 DOM 节点。records 里的 msgId 是
  // 引用卡片附带的快照 id，不能拿来做页面跳转。
  private exportedMessageIds: Set<string> = new Set();
  private messageBySeq: Map<string, RawMessage> = new Map();
  private messageByClientSeq: Map<string, RawMessage> = new Map();

  // 某些合并转发来源仍会提供可转换的 senderUid；转换并缓存，避免重复请求。
  // 收到的匿名转发节点则优先使用协议自带的签名头像 URL，不走这条链路。
  private forwardSenderUinCache: Map<string, Promise<string>> = new Map();

  // 发件人显示信息缓存：senderUid / senderUin → { groupCard, remark, nickname }
  // 用于在某条消息缺失全部昵称字段时，回退到同一发件人在其他消息上出现过的可读名字。
  private senderInfoCache: Map<string, {
    groupCard?: string;
    remark?: string;
    nickname?: string;
  }> = new Map();

  // QQ表情映射表
  private faceMap: Map<string, string> = new Map();

  constructor(opts: SimpleParserOptions = {}) {
    this.options = { ...DEFAULT_SIMPLE_OPTIONS, ...opts };
    this.onProgress = opts.onProgress;
    this.concurrency = this.options.concurrency ?? resolveConcurrency();
    this.initializeFaceMap();
  }

  /**
   * 在资源扫描之前预取合并转发里的原始消息。
   *
   * 合并转发详情通常要通过 getMultiMsg / get_forward_msg 另取；如果等到
   * parseElement 才取，ResourceHandler 已经结束扫描，子消息图片就只能保留
   * 临时 CDN 地址。这里把详情写回 message.records，让原有资源处理流程自然
   * 递归扫描它们，同时也避免真正解析 HTML 时再次请求同一份详情。
   */
  async hydrateForwardRecords(messages: RawMessage[]): Promise<number> {
    const visited = new WeakSet<object>();
    let hydratedCount = 0;

    const walk = async (message: RawMessage, depth: number): Promise<void> => {
      if (!message || depth > SimpleMessageParser.MAX_FORWARD_DEPTH) return;
      if (typeof message === 'object') {
        if (visited.has(message as object)) return;
        visited.add(message as object);
      }

      const forwardElements = (message.elements || [])
        .filter((element) => !!element?.multiForwardMsgElement);
      let records = Array.isArray((message as any).records)
        ? ((message as any).records as RawMessage[]).filter(Boolean)
        : [];

      if (records.length > 0 && forwardElements.length > 0) {
        const forward = forwardElements[0]?.multiForwardMsgElement;
        const xmlResId = (forward?.xmlContent || '').match(/m_resid="([^"]+)"/)?.[1] || '';
        await this.restoreForwardSenderIdentities(records, forward?.resId || xmlResId);
        records = this.attachForwardFetchContext(records, message);
        records = this.assignForwardResourceKeys(records, message);
        (message as any).records = records;
      }

      if (forwardElements.length > 0 && records.length === 0) {
        for (const element of forwardElements) {
          const forward = element.multiForwardMsgElement!;
          const xmlResId = (forward.xmlContent || '').match(/m_resid="([^"]+)"/)?.[1] || '';
          const resId = forward.resId || xmlResId;
          const fetched = await this.fetchForwardRawMessagesForHydration(message, resId);
          if (fetched.length > 0) {
            records = fetched;
            (message as any).records = fetched;
            hydratedCount++;
            break;
          }
        }
      }

      for (const record of records) {
        await walk(record, depth + 1);
      }
    };

    for (const message of messages) {
      await walk(message, 0);
    }
    return hydratedCount;
  }

  /**
   * 在资源扫描之前补齐 reply 引用的原始消息。
   *
   * QQNT 有一类“空回复”：顶层消息只有 replyElement，图片/视频本体只存在
   * 被引用的原消息中。它不在当前导出时间范围内时，单靠 message.records
   * 和 sourceMsgTextElems 往往只能得到「[图片]」占位文字。这里参照 OhMyMeme 已验证
   * 的实现，按 replayMsgSeq 调用 NapCat MsgApi 取回原始 RawMessage，再将其
   * 作为仅供引用预览/资源扫描使用的 record 挂回父消息。
   *
   * 原生接口不可用或查询失败时，把 sourceMsgTextElems 中的 picElem / videoElem /
   * pttElem / fileElem 还原为正常 MessageElement，仍能交给现有 ResourceHandler 处理。
   */
  async hydrateReplyRecords(messages: RawMessage[]): Promise<number> {
    if (!Array.isArray(messages) || messages.length === 0) return 0;

    const topById = new Map<string, RawMessage>();
    const topBySeq = new Map<string, RawMessage>();
    for (const message of messages) {
      if (message?.msgId != null) topById.set(String(message.msgId), message);
      if (message?.msgSeq != null) topBySeq.set(String(message.msgSeq), message);
      if (message?.clientSeq != null) topBySeq.set(String(message.clientSeq), message);
    }

    const visited = new WeakSet<object>();
    const fetchCache = new Map<string, Promise<RawMessage | null>>();
    let hydratedCount = 0;

    const walk = async (message: RawMessage, depth: number): Promise<void> => {
      if (!message || depth > SimpleMessageParser.MAX_REPLY_DEPTH) return;
      if (typeof message === 'object') {
        if (visited.has(message as object)) return;
        visited.add(message as object);
      }

      const replyElements = (message.elements || [])
        .map((element: MessageElement) => element?.replyElement)
        .filter(Boolean);
      let records = Array.isArray((message as any).records)
        ? ((message as any).records as RawMessage[]).filter(Boolean)
        : [];

      for (let replyIndex = 0; replyIndex < replyElements.length; replyIndex++) {
        const replyElement = replyElements[replyIndex];
        const sourceId = this.replySourceMessageId(replyElement);
        const sequence = this.replySourceSequence(replyElement);
        const topLevel = (sourceId && topById.get(sourceId)) || (sequence && topBySeq.get(sequence));
        if (topLevel && this.hasUsefulReplySource(topLevel)) continue;

        const existingIndex = records.findIndex(record => this.matchesReplySource(record, replyElement));
        const existing = existingIndex >= 0 ? records[existingIndex] : undefined;
        const snapshot = this.rawMessageFromReplySnapshot(message, replyElement);
        const snapshotHasMedia = snapshot ? this.hasMediaElements(snapshot) : false;

        // 普通文字回复的 record 本来就足够，不额外打 NapCat 接口。
        // 空 record、只有「[图片]」之类占位符，或快照明确带媒体时才回查。
        const needsRecovery = !existing
          || !this.hasUsefulReplySource(existing)
          || (snapshotHasMedia && !this.hasMediaElements(existing));
        if (!needsRecovery) continue;

        let recovered: RawMessage | null = null;
        const inlineText = String(
          replyElement?.sourceMsgText
          ?? replyElement?.referencedMsg?.msgBody
          ?? ''
        ).trim();
        const inlineTextNeedsMedia = /\[(?:图片|视频|语音|文件)\]/.test(inlineText);
        const shouldQueryNative = Boolean(sequence && (
          snapshotHasMedia
          || (existing && !this.hasUsefulReplySource(existing))
          || (!existing && !snapshot && (!inlineText || inlineTextNeedsMedia))
        ));
        if (shouldQueryNative) {
          const peer = this.getForwardFetchContext(message).peer;
          const cacheKey = `${peer.chatType}:${peer.peerUid}:${peer.guildId}:${sequence}`;
          let pending = fetchCache.get(cacheKey);
          if (!pending) {
            pending = this.fetchReplyRawMessageBySequence(message, sequence);
            fetchCache.set(cacheKey, pending);
          }
          const fetched = await pending;
          // 同一条原消息可能被多条回复引用。每个父消息都需要独立的
          // __qceResourceKey，不能共享同一个对象后相互覆盖内部字段。
          recovered = fetched ? { ...(fetched as any) } as RawMessage : null;
        }

        // 原生返回偶尔只有占位文本，而 reply 快照反而带 picElem/videoElem；
        // 这种情况快照更有价值。
        if (!recovered || (snapshotHasMedia && !this.hasMediaElements(recovered))) {
          recovered = snapshot;
        }
        if (!recovered || !this.hasUsefulReplySource(recovered)) continue;

        this.attachReplyFetchContext(recovered, message, replyElement, replyIndex);
        if (existingIndex >= 0) records[existingIndex] = recovered;
        else records.push(recovered);
        (message as any).records = records;
        hydratedCount++;
      }

      // 用最新 records 继续走，支持“回复引用的消息本身又是回复”。
      records = Array.isArray((message as any).records)
        ? ((message as any).records as RawMessage[]).filter(Boolean)
        : [];
      for (const record of records) await walk(record, depth + 1);
    };

    for (const message of messages) await walk(message, 0);
    return hydratedCount;
  }

  private replySourceMessageId(replyElement: any): string {
    return String(replyElement?.sourceMsgIdInRecords ?? replyElement?.replayMsgId ?? '').trim();
  }

  private replySourceSequence(replyElement: any): string {
    return String(replyElement?.replayMsgSeq ?? replyElement?.replyMsgClientSeq ?? '').trim();
  }

  private matchesReplySource(record: RawMessage, replyElement: any): boolean {
    if (!record) return false;
    const sourceId = this.replySourceMessageId(replyElement);
    const sequence = this.replySourceSequence(replyElement);
    if (sourceId && String(record.msgId || '') === sourceId) return true;
    return Boolean(sequence && [record.msgSeq, record.clientSeq, (record as any).realSeq]
      .some(value => value != null && String(value) === sequence));
  }

  private hasMediaElements(message: RawMessage): boolean {
    return (message?.elements || []).some((element: MessageElement) => Boolean(
      element?.picElement
      || element?.videoElement
      || element?.pttElement
      || element?.fileElement
      || element?.marketFaceElement
    ));
  }

  private hasUsefulReplySource(message: RawMessage): boolean {
    if (this.hasMediaElements(message)) return true;
    return (message?.elements || []).some((element: MessageElement) => {
      if (!element) return false;
      if (element.textElement) {
        const text = String(element.textElement.content || '').trim();
        if (!text) return false;
        return !/^\[(?:图片|视频|语音|文件|空消息)\]$/.test(text);
      }
      return Boolean(
        element.faceElement
        || element.arkElement
        || element.multiForwardMsgElement
        || element.structLongMsgElement
        || element.grayTipElement
      );
    });
  }

  private rawMessageFromReplySnapshot(parent: RawMessage, replyElement: any): RawMessage | null {
    const source = Array.isArray(replyElement?.sourceMsgTextElems)
      ? replyElement.sourceMsgTextElems
      : [];
    const elements: MessageElement[] = [];
    for (const item of source) {
      if (!item || typeof item !== 'object') continue;
      const pic = item.picElem || item.picElement;
      const video = item.videoElem || item.videoElement;
      const ptt = item.pttElem || item.pttElement;
      const file = item.fileElem || item.fileElement;
      if (pic) {
        elements.push({ elementType: 2, elementId: '', picElement: { ...pic } } as MessageElement);
      } else if (video) {
        elements.push({ elementType: 5, elementId: '', videoElement: { ...video } } as MessageElement);
      } else if (ptt) {
        elements.push({ elementType: 4, elementId: '', pttElement: { ...ptt } } as MessageElement);
      } else if (file) {
        elements.push({ elementType: 3, elementId: '', fileElement: { ...file } } as MessageElement);
      } else {
        const text = String(item.textElemContent ?? item.textElement?.content ?? '').trim();
        if (text) {
          elements.push({
            elementType: 1,
            elementId: '',
            textElement: { content: text, atType: 0 }
          } as MessageElement);
        }
      }
    }
    if (elements.length === 0) return null;

    const sourceId = this.replySourceMessageId(replyElement)
      || `${String(parent.msgId || 'message')}:reply`;
    return {
      ...(parent as any),
      msgId: sourceId,
      msgSeq: this.replySourceSequence(replyElement) || '0',
      clientSeq: String(replyElement?.replyMsgClientSeq ?? this.replySourceSequence(replyElement) ?? '0'),
      msgTime: String(replyElement?.replyMsgTime ?? parent.msgTime ?? '0'),
      senderUid: String(replyElement?.senderUidStr ?? replyElement?.senderUid ?? ''),
      senderUin: String(replyElement?.senderUin ?? ''),
      sendNickName: String(replyElement?.senderNick ?? ''),
      sendMemberName: String(replyElement?.senderMemberName ?? ''),
      elements,
      records: []
    } as RawMessage;
  }

  private async fetchReplyRawMessageBySequence(
    parent: RawMessage,
    sequence: string
  ): Promise<RawMessage | null> {
    const bridge = (globalThis as any).__NAPCAT_BRIDGE__;
    const msgApi = bridge?.core?.apis?.MsgApi || bridge?.core?.apis?.msg;
    if (!msgApi) return null;
    const peer = this.getForwardFetchContext(parent).peer;
    const results: any[] = [];

    if (typeof msgApi.getMsgsBySeqAndCount === 'function') {
      try {
        results.push(await msgApi.getMsgsBySeqAndCount(peer, sequence, 1, true, true));
      } catch {
        // 继续走单条查询兼容接口。
      }
    }
    if (!this.findMessageInQueryResults(results, sequence)
      && typeof msgApi.queryFirstMsgBySeq === 'function') {
      try {
        results.push(await msgApi.queryFirstMsgBySeq(peer, sequence));
      } catch {
        // 继续尝试过滤查询。
      }
    }
    if (!this.findMessageInQueryResults(results, sequence)
      && typeof msgApi.queryMsgsWithFilterExWithSeq === 'function') {
      try {
        results.push(await msgApi.queryMsgsWithFilterExWithSeq(peer, sequence));
      } catch {
        // 全部失败时由调用方使用 reply 快照。
      }
    }
    return this.findMessageInQueryResults(results, sequence);
  }

  private findMessageInQueryResults(results: any[], sequence: string): RawMessage | null {
    for (const result of results) {
      const lists = [
        result?.msgList,
        result?.messages,
        result?.data?.msgList,
        result?.data?.messages,
        Array.isArray(result) ? result : undefined
      ];
      for (const list of lists) {
        if (!Array.isArray(list)) continue;
        const found = list.find((message: RawMessage) =>
          [message?.msgSeq, message?.clientSeq, (message as any)?.realSeq]
            .some(value => value != null && String(value) === sequence)
        );
        if (found) return found;
      }
      if (result?.msgId && [result.msgSeq, result.clientSeq, result.realSeq]
        .some((value: unknown) => value != null && String(value) === sequence)) {
        return result as RawMessage;
      }
    }
    return null;
  }

  private attachReplyFetchContext(
    record: RawMessage,
    parent: RawMessage,
    replyElement: any,
    replyIndex: number
  ): void {
    const context = this.getForwardFetchContext(parent);
    if (!(record as any).chatType) (record as any).chatType = context.peer.chatType;
    if (!(record as any).peerUid) (record as any).peerUid = context.peer.peerUid;
    if (!(record as any).guildId) (record as any).guildId = context.peer.guildId;
    (record as any).__qceForwardPeer = context.peer;
    (record as any).__qceReplyRecord = true;
    const parentKey = String((parent as any).__qceResourceKey || parent.msgId || 'message');
    const sourceKey = this.replySourceMessageId(replyElement)
      || this.replySourceSequence(replyElement)
      || String(replyIndex + 1);
    (record as any).__qceResourceKey = `${parentKey}/reply-${sourceKey}`;
  }

  private async fetchForwardRawMessagesForHydration(
    message: RawMessage,
    resId: string
  ): Promise<RawMessage[]> {
    const nativeMessages = await this.fetchNativeForwardRawMessages(message, resId);
    if (nativeMessages.length > 0) {
      return this.assignForwardResourceKeys(nativeMessages, message);
    }

    const bridge = (globalThis as any).__NAPCAT_BRIDGE__;
    const getForwardAction = bridge?.actions?.get?.('get_forward_msg');
    if (!getForwardAction) return [];

    for (const messageId of [message.msgId, resId].filter(Boolean)) {
      try {
        const result = await getForwardAction.handle({ message_id: messageId }, 'plugin', {});
        const actionMessages = result?.data?.messages;
        if (Array.isArray(actionMessages) && actionMessages.length > 0) {
          const normalized = this.normalizeForwardActionRawMessages(actionMessages, message);
          await this.restoreForwardSenderIdentities(normalized, resId);
          return this.assignForwardResourceKeys(
            this.attachForwardFetchContext(normalized, message),
            message
          );
        }
      } catch {
        // 继续尝试 resId；两种 id 都失败则保留原有降级行为。
      }
    }
    return [];
  }

  /**
   * 调用 NapCat 原生 getMultiMsg，并保存深层转发继续取数所需的根消息上下文。
   *
   * 当前 Framework 的真实签名是 getMultiMsg(peer, rootMsgId, parentMsgId)。
   * 一些旧适配层/测试桩接受单个参数对象，因此位置参数失败或返回空列表时再兼容旧签名。
   */
  private async fetchNativeForwardRawMessages(
    message: RawMessage,
    resId: string
  ): Promise<RawMessage[]> {
    const bridge = (globalThis as any).__NAPCAT_BRIDGE__;
    const core = bridge?.core;
    const msgApi = core?.apis?.MsgApi || core?.apis?.msg;
    if (!msgApi || typeof msgApi.getMultiMsg !== 'function') return [];

    const context = this.getForwardFetchContext(message);
    let result: any;

    try {
      result = await msgApi.getMultiMsg(
        context.peer,
        context.rootMsgId,
        context.parentMsgId
      );
    } catch {
      result = undefined;
    }

    if (!Array.isArray(result?.msgList) || result.msgList.length === 0) {
      try {
        result = await msgApi.getMultiMsg({
          peer: context.peer,
          rootMsgId: context.rootMsgId,
          parentMsgId: context.parentMsgId,
          forwardId: resId,
          resId
        });
      } catch {
        result = undefined;
      }
    }

    if (!Array.isArray(result?.msgList) || result.msgList.length === 0) return [];
    const messages = result.msgList.filter(Boolean);
    await this.restoreForwardSenderIdentities(messages, resId);
    return this.attachForwardFetchContext(messages, message);
  }

  /**
   * getMultiMsg / get_forward_msg 在部分 NapCat 版本里会把制作者账号的
   * UIN/UID 填进所有合并转发子节点。原始长消息资源不会暴露真实账号，
   * 但会在 contentHead.forward 中保留 QQ 客户端实际使用的签名头像 URL。
   * 这里按消息 ID、序号或稳定顺序回填头像；正文和媒体仍走原解析链路。
   */
  private async restoreForwardSenderIdentities(
    records: RawMessage[],
    resId: string
  ): Promise<void> {
    if (!records.length || !resId) return;
    const bridge = (globalThis as any).__NAPCAT_BRIDGE__;
    const operation = bridge?.core?.apis?.PacketApi?.pkt?.operation;
    if (typeof operation?.FetchForwardMsgRaw !== 'function') return;

    let actions: any[];
    try {
      const result = await operation.FetchForwardMsgRaw(resId);
      actions = Array.isArray(result) ? result : [];
    } catch {
      return;
    }

    const main = actions.find(action => String(action?.actionCommand || '') === 'MultiMsg');
    const packetMessages = Array.isArray(main?.actionData?.msgBody)
      ? main.actionData.msgBody
      : [];
    if (!packetMessages.length) return;

    const identities: ForwardPacketIdentity[] = packetMessages.map((packet: any, index: number) => {
      const response = packet?.responseHead || {};
      const content = packet?.contentHead || {};
      const uin = String(response?.fromUin ?? '').trim();
      const groupUin = String(
        response?.grp?.groupUin
        ?? response?.grp?.groupCode
        ?? ''
      ).trim();
      const avatarCandidate = String(
        content?.forward?.unknownBase64
        ?? content?.forward?.avatarUrl
        ?? response?.forward?.avatarUrl
        ?? ''
      ).trim();
      return {
        index,
        used: false,
        msgId: String(content?.newId ?? content?.msgId ?? '').trim(),
        seq: String(content?.sequence ?? content?.msgSeq ?? '').trim(),
        uid: String(response?.fromUid ?? '').trim(),
        uin: /^\d{5,14}$/.test(uin) ? uin : '',
        name: String(
          response?.grp?.memberName
          ?? response?.forward?.friendName
          ?? response?.friendName
          ?? ''
        ).trim(),
        avatarUrl: /^https?:\/\//i.test(avatarCandidate) ? avatarCandidate : '',
        // 原始 MultiMsg 协议里的 groupUin 才是这条子消息真正所属的群。
        // 外层卡片可能位于私聊，不能用外层 peer 去请求子消息的视频/语音。
        sourcePeer: /^\d+$/.test(groupUin) && groupUin !== '0'
          ? { chatType: 2, peerUid: groupUin, guildId: '' }
          : undefined
      };
    }).filter((identity: ForwardPacketIdentity) =>
      identity.uid || identity.uin || identity.name || identity.avatarUrl || identity.sourcePeer
    );
    if (!identities.length) return;

    records.forEach((record, recordIndex) => {
      const recordId = String(record?.msgId || '').trim();
      const recordSeqs = [record?.msgSeq, record?.clientSeq, (record as any)?.realSeq]
        .map(value => String(value ?? '').trim())
        .filter(Boolean);

      let best: typeof identities[number] | undefined;
      let bestScore = 0;
      for (const identity of identities) {
        if (identity.used) continue;
        const idMatches = !!recordId && !!identity.msgId && recordId === identity.msgId;
        const seqMatches = !!identity.seq && recordSeqs.includes(identity.seq);
        const score = (idMatches ? 4 : 0) + (seqMatches ? 8 : 0);
        if (score > bestScore) {
          best = identity;
          bestScore = score;
        }
      }
      if (!best && identities.length === records.length) {
        const sameIndex = identities.find((identity: ForwardPacketIdentity) =>
          identity.index === recordIndex && !identity.used
        );
        if (sameIndex) best = sameIndex;
      }
      if (!best) return;

      best.used = true;
      // QQ 收到的合并转发会把 fromUin/fromUid 匿名替换成制作者账号，
      // 不能据此生成头像或暴露为真实发送者 ID。真正用于头像展示的是
      // contentHead.forward.unknownBase64 中的带签名 qlogo 地址。
      if (best.avatarUrl) {
        (record as any).avatarUrl = best.avatarUrl;
        (record as any).__qceForwardProtocolAvatar = true;
      }
      if (best.name) {
        (record as any).sendNickName = best.name;
        (record as any).sendMemberName = best.name;
      }
      if (best.sourcePeer) {
        (record as any).__qceForwardPeer = best.sourcePeer;
      }
    });
  }

  private getForwardFetchContext(message: RawMessage): {
    peer: { chatType: number; peerUid: string; guildId: string };
    rootMsgId: string;
    parentMsgId: string;
  } {
    const internalPeer = (message as any).__qceForwardPeer;
    const parentPeer = (message as any).parentMsgPeer;
    const peer = {
      chatType: Number(internalPeer?.chatType ?? parentPeer?.chatType ?? message.chatType ?? 0),
      peerUid: String(internalPeer?.peerUid ?? parentPeer?.peerUid ?? message.peerUid ?? ''),
      guildId: String(internalPeer?.guildId ?? parentPeer?.guildId ?? message.guildId ?? '')
    };
    const parentIds = Array.isArray((message as any).parentMsgIdList)
      ? (message as any).parentMsgIdList.map(String).filter(Boolean)
      : [];
    const rootMsgId = String(
      (message as any).__qceForwardRootMsgId || parentIds[0] || message.msgId || ''
    );
    return {
      peer,
      rootMsgId,
      parentMsgId: String(message.msgId || rootMsgId)
    };
  }

  private attachForwardFetchContext(records: RawMessage[], parent: RawMessage): RawMessage[] {
    const context = this.getForwardFetchContext(parent);
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      (record as any).__qceForwardRootMsgId = context.rootMsgId;
      const attachedPeer = (record as any).__qceForwardPeer;
      const attachedPeerUid = String(attachedPeer?.peerUid ?? '').trim();
      const attachedChatType = Number(attachedPeer?.chatType ?? 0);
      if (attachedPeerUid && attachedPeerUid !== '0' && attachedChatType > 0) {
        // restoreForwardSenderIdentities 已从协议包恢复了真正来源群时必须保留。
        // 尤其是“私聊中的合并转发里又引用群视频”的场景，覆盖成外层私聊
        // 会让 getVideoUrlPacket 带错 peer，最终只剩文件名占位文本。
        continue;
      }

      const recordPeerUid = String((record as any).peerUid ?? '').trim();
      const recordChatType = Number((record as any).chatType ?? 0);
      (record as any).__qceForwardPeer = recordPeerUid
        && recordPeerUid !== '0'
        && recordChatType > 0
        ? {
            chatType: recordChatType,
            peerUid: recordPeerUid,
            guildId: String((record as any).guildId ?? '')
          }
        : context.peer;
    }
    return records;
  }

  /**
   * NapCat 的合并转发节点可能共享同一个 msgId（真实样本中三条节点的
   * message_id 完全相同，只有 clientSeq / real_seq 不同）。不改原 msgId，
   * 避免破坏 downloadMedia 的入参；另挂一个仅供 QCE resourceMap 使用的键。
   */
  private assignForwardResourceKeys(records: RawMessage[], parent: RawMessage): RawMessage[] {
    // 外层节点沿用原来的短键，避免无谓改变已导出 JSON；从第二层开始把父键
    // 纳入命名空间。NapCat 的不同层级经常重复使用同一个 msgId / clientSeq，
    // 如果只在同级去重，ResourceHandler 的递归扫描会把深层节点误认为已处理。
    const parentResourceKey = String((parent as any).__qceResourceKey || '');
    const idCounts = new Map<string, number>();
    for (const record of records) {
      const id = String(record?.msgId || '');
      idCounts.set(id, (idCounts.get(id) || 0) + 1);
    }

    const used = new Set<string>();
    records.forEach((record, index) => {
      const baseId = String(record?.msgId || '');
      let resourceKey = baseId;
      if (!baseId || (idCounts.get(baseId) || 0) > 1) {
        const sequence = String(
          record?.clientSeq || record?.msgSeq || (record as any)?.realSeq || index + 1
        );
        resourceKey = `${baseId || parent.msgId || 'forward'}-${sequence}`;
      }
      if (parentResourceKey) resourceKey = `${parentResourceKey}/${resourceKey || index + 1}`;
      if (used.has(resourceKey)) resourceKey = `${resourceKey}-${index + 1}`;
      used.add(resourceKey);
      (record as any).__qceResourceKey = resourceKey;
    });
    return records;
  }

  private normalizeForwardActionRawMessages(
    messages: any[],
    parent: RawMessage,
    depth: number = 0
  ): RawMessage[] {
    if (depth > SimpleMessageParser.MAX_FORWARD_DEPTH) return [];

    return this.normalizeOneBotForwardEntries(messages)
      .filter(Boolean)
      .map((item: any, index: number) => {
        const sender = item.sender || {};
        const messageId = String(
          item.message_id || item.real_id || item.message_seq || item.real_seq ||
          `${parent.msgId || 'forward'}-${index + 1}`
        );
        const senderUin = String(item.user_id || sender.user_id || '');
        const nickname = String(sender.nickname || sender.name || sender.card || senderUin);
        const card = String(sender.card || '');
        const segments = this.getOneBotMessageSegments(item);
        const elements = segments
          .map((segment: any) => this.oneBotSegmentToRawElement(segment))
          .filter((element: MessageElement | null): element is MessageElement => !!element);

        const raw = {
          msgId: messageId,
          msgSeq: String(item.message_seq || item.real_seq || messageId),
          clientSeq: String(item.real_seq || item.message_seq || messageId),
          msgTime: String(item.time || parent.msgTime || 0),
          msgType: 2,
          chatType: parent.chatType,
          peerUid: parent.peerUid,
          senderUid: senderUin,
          senderUin,
          sendNickName: nickname,
          sendMemberName: card,
          sendRemarkName: '',
          recallTime: '0',
          elements,
          records: [],
          parentMsgIdList: [String(parent.msgId || '')].filter(Boolean)
        } as unknown as RawMessage;

        // NapCat 在 get_forward_msg 的结果中会把深层聊天记录直接放到
        // forward.data.content，而不保证这些内层卡片还能再次按 id 拉取。
        // 这里将内联内容提前还原为 records，避免后续递归解析时丢成空消息。
        if (depth < SimpleMessageParser.MAX_FORWARD_DEPTH) {
          const inlineMessages = segments.flatMap((segment: any) => {
            const type = String(segment?.type || '').toLowerCase();
            if (type === 'forward') {
              return this.getOneBotForwardContentEntries(
                segment?.data?.content ?? segment?.data?.message
              );
            }
            // NapCat 当前的 get_forward_msg.parseForward 会把嵌套转发改写成
            // node.data.message = node[]，而不是保留 forward.data.content。
            if (type === 'node') {
              return this.getOneBotForwardContentEntries(this.getOneBotNodeSegments(segment));
            }
            return [];
          });
          if (inlineMessages.length > 0) {
            raw.records = this.normalizeForwardActionRawMessages(inlineMessages, raw, depth + 1);
          }
        }

        return raw;
      });
  }

  /**
   * 兼容 get_forward_msg 的两种子消息形态：
   * 1) NapCat 当前返回的完整 OneBot 消息（message: MessageSegment[]）
   * 2) node 包装（旧版 data.content / 当前 NapCat data.message）
   */
  private normalizeOneBotForwardEntries(entries: any[]): any[] {
    if (!Array.isArray(entries)) return [];
    return entries.map((entry: any, index: number) => {
      const nodeSegments = this.getOneBotNodeSegments(entry);
      if (String(entry?.type || '').toLowerCase() !== 'node' || nodeSegments.length === 0) {
        return entry;
      }
      const data = entry.data || {};
      const userId = data.user_id ?? data.uin ?? '';
      return {
        message_id: data.id ?? data.message_id ?? `forward-node-${index + 1}`,
        message_seq: data.message_seq ?? data.seq ?? index + 1,
        real_seq: data.real_seq ?? data.seq ?? index + 1,
        time: data.time ?? 0,
        user_id: userId,
        sender: {
          user_id: userId,
          nickname: data.nickname ?? data.name ?? String(userId),
          card: data.card ?? ''
        },
        message: nodeSegments,
        raw_message: data.raw_message ?? ''
      };
    });
  }

  private getOneBotMessageSegments(item: any): any[] {
    if (Array.isArray(item?.message)) return item.message;
    if (String(item?.type || '').toLowerCase() === 'node') {
      return this.getOneBotNodeSegments(item);
    }
    return [];
  }

  /**
   * NapCat 的 get_forward_msg 在不同版本中用过两套 node 子消息字段：
   * data.content（旧形态）与 data.message（当前 parseForward 真实输出）。
   */
  private getOneBotNodeSegments(node: any): any[] {
    if (Array.isArray(node?.data?.message) && node.data.message.length > 0) {
      return node.data.message;
    }
    if (Array.isArray(node?.data?.content)) return node.data.content;
    return [];
  }

  private getOneBotForwardContentEntries(content: unknown): any[] {
    if (!Array.isArray(content) || content.length === 0) return [];
    const normalized = this.normalizeOneBotForwardEntries(content);
    const looksLikeBareSegments = normalized.every((entry: any) =>
      typeof entry?.type === 'string'
      && entry?.data != null
      && !Array.isArray(entry?.message)
      && String(entry.type).toLowerCase() !== 'node'
    );
    return looksLikeBareSegments ? [{ message: normalized }] : normalized;
  }

  private oneBotSegmentToRawElement(segment: any): MessageElement | null {
    if (!segment) return null;
    const type = String(segment.type || '').toLowerCase();
    const data = segment.data || {};
    const elementId = String(data.element_id || data.elementId || '');

    if (type === 'text') {
      return {
        elementType: 1,
        elementId,
        textElement: { content: String(data.text || ''), atType: 0, atUid: '', atNtUid: '' }
      } as unknown as MessageElement;
    }
    if (type === 'at') {
      const qq = String(data.qq || data.user_id || '');
      const atAll = qq === 'all';
      return {
        elementType: 1,
        elementId,
        textElement: {
          content: atAll ? '@全体成员' : `@${data.name || qq}`,
          atType: atAll ? 1 : 2,
          atUid: atAll ? '0' : qq,
          atNtUid: atAll ? '' : qq
        }
      } as unknown as MessageElement;
    }
    if (type === 'image') {
      const fileValue = String(data.file || data.file_name || data.filename || '图片');
      const fileName = this.fileNameFromOneBotValue(fileValue, '图片.jpg');
      const md5 = String(data.md5 || fileValue.match(/[a-f0-9]{32}/i)?.[0] || '');
      return {
        elementType: 2,
        elementId,
        picElement: {
          fileName,
          fileSize: String(data.file_size || data.size || 0),
          picWidth: Number(data.width || 0),
          picHeight: Number(data.height || 0),
          md5HexStr: md5,
          originImageUrl: String(data.url || ''),
          sourcePath: String(data.path || data.url || '')
        }
      } as unknown as MessageElement;
    }
    if (type === 'record' || type === 'audio') {
      const fileValue = String(data.file || data.file_name || data.filename || '语音');
      return {
        elementType: 4,
        elementId,
        pttElement: {
          fileName: this.fileNameFromOneBotValue(fileValue, '语音.amr'),
          fileSize: String(data.file_size || data.size || 0),
          duration: Number(data.duration || 0),
          md5HexStr: String(data.md5 || ''),
          filePath: String(data.path || data.url || '')
        }
      } as unknown as MessageElement;
    }
    if (type === 'video') {
      const fileValue = String(data.file || data.file_name || data.filename || '视频');
      return {
        elementType: 4,
        elementId,
        videoElement: {
          fileName: this.fileNameFromOneBotValue(fileValue, '视频.mp4'),
          fileSize: String(data.file_size || data.size || 0),
          duration: Number(data.duration || 0),
          md5HexStr: String(data.md5 || ''),
          fileUuid: String(data.file_id || data.file_uuid || ''),
          filePath: String(data.path || data.url || '')
        }
      } as unknown as MessageElement;
    }
    if (type === 'file') {
      const fileValue = String(data.file || data.file_name || data.name || '文件');
      return {
        elementType: 3,
        elementId,
        fileElement: {
          fileName: this.fileNameFromOneBotValue(fileValue, '文件'),
          fileSize: String(data.file_size || data.size || 0),
          fileMd5: String(data.md5 || ''),
          filePath: String(data.path || data.url || '')
        }
      } as unknown as MessageElement;
    }
    if (type === 'face') {
      return {
        elementType: 6,
        elementId,
        faceElement: { faceIndex: Number(data.id || 0), faceText: String(data.name || '') }
      } as unknown as MessageElement;
    }
    if (type === 'mface' || type === 'market_face') {
      return {
        elementType: 37,
        elementId,
        marketFaceElement: {
          faceName: String(data.summary || data.name || '商城表情'),
          emojiId: String(data.emoji_id || data.id || ''),
          emojiPackageId: Number(data.emoji_package_id || 0),
          key: String(data.key || '')
        }
      } as unknown as MessageElement;
    }
    if (type === 'json') {
      return {
        elementType: 10,
        elementId,
        arkElement: { bytesData: String(data.data || data.json || '{}') }
      } as unknown as MessageElement;
    }
    if (type === 'forward') {
      return {
        elementType: 16,
        elementId,
        multiForwardMsgElement: {
          resId: String(data.id || data.res_id || data.resId || ''),
          xmlContent: String(data.content || '')
        }
      } as unknown as MessageElement;
    }
    if (type === 'node') {
      const nodeSegments = this.getOneBotNodeSegments(segment);
      if (nodeSegments.length === 0) return null;
      return {
        elementType: 16,
        elementId,
        multiForwardMsgElement: {
          resId: String(data.id || data.res_id || data.resId || ''),
          xmlContent: ''
        }
      } as unknown as MessageElement;
    }
    return null;
  }

  private fileNameFromOneBotValue(value: string, fallback: string): string {
    if (!value) return fallback;
    try {
      if (/^https?:\/\//i.test(value)) {
        const urlPath = new URL(value).pathname;
        return path.basename(urlPath) || fallback;
      }
    } catch {
      // 非法 URL 按普通文件名处理。
    }
    const cleanValue = value.split(/[?#]/, 1)[0] || '';
    return path.basename(cleanValue.replace(/\\/g, '/')) || fallback;
  }

  /**
   * 解析消息列表（高并发 + 有序输出）
   */
  async parseMessages(messages: RawMessage[]): Promise<CleanMessage[]> {
    const total = messages.length;
    let processed = 0;

    // 先建立全局消息映射；reply 解析需要看到整批消息，不能边解析边建索引。
    this.indexMessages(messages);

    const results = await mapLimit(messages, this.concurrency, async (message, idx) => {
      try {
        const cm = await this.parseMessage(message);

        processed++;
        if (this.onProgress) {
          this.onProgress(processed, total);
        } else if (processed % this.options.progressEvery === 0) {
          console.log(`[SimpleMessageParser] 已解析 ${processed}/${total}`);
        }

        if (this.options.yieldEvery > 0 && (idx + 1) % this.options.yieldEvery === 0) {
          await yieldToEventLoop();
        }

        return cm;
      } catch (error) {
        console.error('解析消息失败:', error, message?.msgId);
        return this.createErrorMessage(message, error);
      }
    });
    
    // 清理映射
    this.clearMessageIndexes();

    return results;
  }

  /**
   * 把消息上的群名片 / 备注 / 昵称写入按 senderUid 与 senderUin 索引的缓存。
   *
   * 同一群成员的不同消息中，往往只有一部分会携带 sendMemberName / sendNickName，
   * 单条消息都可能因为底层数据漏字段而显示为 QQ 号。这里在解析前先把所有出现过的
   * 名字按发件人聚合，后续 getSenderDisplayInfo 在本地字段全空时会回退到这里查表。
   */
  private cacheSenderInfo(message: RawMessage): void {
    const groupCard = this.getTrimmedText(message.sendMemberName);
    const remark = this.getTrimmedText(message.sendRemarkName);
    const nickname = this.getTrimmedText(message.sendNickName);
    if (!groupCard && !remark && !nickname) return;

    const keys: string[] = [];
    const uid = this.getTrimmedText(message.senderUid);
    if (uid) keys.push(uid);
    const uin = this.getTrimmedText(message.senderUin);
    if (uin) keys.push(uin);

    for (const key of keys) {
      const existing = this.senderInfoCache.get(key) ?? {};
      this.senderInfoCache.set(key, {
        groupCard: existing.groupCard ?? groupCard,
        remark: existing.remark ?? remark,
        nickname: existing.nickname ?? nickname
      });
    }
  }

  /**
   * 在按 senderUid → senderUin 顺序查表，命中即返回。供 getSenderDisplayInfo 在
   * 本条消息字段全空时使用，避免出现把 QQ 号当昵称的情况（参见 #274）。
   */
  private lookupCachedSenderInfo(message: RawMessage): {
    groupCard?: string;
    remark?: string;
    nickname?: string;
  } | undefined {
    const uid = this.getTrimmedText(message.senderUid);
    if (uid) {
      const hit = this.senderInfoCache.get(uid);
      if (hit) return hit;
    }
    const uin = this.getTrimmedText(message.senderUin);
    if (uin) {
      const hit = this.senderInfoCache.get(uin);
      if (hit) return hit;
    }
    return undefined;
  }

  /**
   * 【流式版本】解析消息生成器 - 逐条解析并yield，实现低内存占用
   * 适用于大量消息的场景，配合流式导出可实现全程低内存
   */
  async *parseMessagesStream(
    messages: RawMessage[],
    resourceMap?: Map<string, any>
  ): AsyncGenerator<CleanMessage, void, undefined> {
    const total = messages.length;
    let processed = 0;

    this.indexMessages(messages);
    try {
      for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        if (!message) continue; // 跳过undefined元素
        
        try {
          const cleanMessage = await this.parseMessage(message);

          // 如果提供了resourceMap，立即更新这条消息及 reply 预览的资源路径。
          if (resourceMap) {
            const resources = resourceMap.get(message.msgId);
            if (resources && cleanMessage.content.elements) {
              this.updateSingleMessageResourcePaths(cleanMessage, resources);
            }
            this.backfillReplyPreviewLocalPathsFromResourceMap(cleanMessage, resourceMap);
            this.backfillForwardInnerResourcePathsFromResourceMap(cleanMessage, resourceMap);
          }

          processed++;
          if (this.onProgress) {
            this.onProgress(processed, total);
          } else if (processed % this.options.progressEvery === 0) {
            console.log(`[SimpleMessageParser] 已解析 ${processed}/${total}`);
          }

          if (this.options.yieldEvery > 0 && (i + 1) % this.options.yieldEvery === 0) {
            await yieldToEventLoop();
          }

          yield cleanMessage;
        } catch (error) {
          console.error('解析消息失败:', error, message.msgId);
          yield this.createErrorMessage(message, error);
        }
      }
    } finally {
      this.clearMessageIndexes();
    }
  }

  private indexMessages(messages: RawMessage[]): void {
    this.clearMessageIndexes();
    for (const msg of messages) {
      if (!msg || !msg.msgId) continue;
      this.messageMap.set(String(msg.msgId), msg);
      this.exportedMessageIds.add(String(msg.msgId));
      if (msg.msgSeq != null) this.messageBySeq.set(String(msg.msgSeq), msg);
      if (msg.clientSeq != null) this.messageByClientSeq.set(String(msg.clientSeq), msg);
      this.cacheSenderInfo(msg);
      for (const record of msg.records || []) {
        if (!record?.msgId) continue;
        this.messageMap.set(String(record.msgId), record);
        this.cacheSenderInfo(record);
      }
    }
  }

  private clearMessageIndexes(): void {
    this.messageMap.clear();
    this.exportedMessageIds.clear();
    this.messageBySeq.clear();
    this.messageByClientSeq.clear();
    this.senderInfoCache.clear();
  }

  /**
   * 解析单条消息（公开）
   */
  async parseSingleMessage(message: RawMessage): Promise<CleanMessage> {
    return this.parseMessage(message);
  }

  /**
   * 解析单条消息（内部）
   */
  private async parseMessage(message: RawMessage): Promise<CleanMessage> {
    const tsMs = millisFromUnixSeconds(message.msgTime as any);
    const timestamp = tsMs > 0 ? tsMs : Date.now();
    const senderInfo = this.getSenderDisplayInfo(message);

    const content = await this.parseMessageContent(message);

    const cleanMessage: CleanMessage = {
      id: message.msgId,
      seq: message.msgSeq,
      timestamp,
      // RFC3339（UTC）
      time: rfc3339FromMillis(timestamp),
      sender: {
        uid: message.senderUid || '未知',
        uin: message.senderUin,
        name: senderInfo.name,
        nickname: senderInfo.nickname,
        groupCard: senderInfo.groupCard,
        remark: senderInfo.remark,
        title: this.resolveSenderTitle(message)
      },
      type: this.getMessageTypeString(message.msgType),
      content,
      recalled: message.recallTime !== '0',
      system: this.isSystemMessage(message)
    };

    return cleanMessage;
  }

  /**
   * 调用 senderTitleResolver 获取发件人头衔。仅群聊（chatType=2）生效。
   * 解析器抛错不应该令整个解析流程走不下去，这里丝果干净地吞掉。
   */
  private resolveSenderTitle(message: RawMessage): string | undefined {
    if (!this.options.senderTitleResolver) return undefined;
    if (message.chatType !== 2) return undefined;
    try {
      const title = this.options.senderTitleResolver(message.senderUid, message.senderUin);
      const trimmed = this.getTrimmedText(title);
      return trimmed;
    } catch (error) {
      console.warn('[SimpleMessageParser] senderTitleResolver 抛出异常，已忽略:', error);
      return undefined;
    }
  }

  private getMessageTypeString(msgType: NTMsgType | number): string {
    // NTMsgType 枚举值（兼容两种定义方式）
    // 原始枚举: KMSGTYPENULL=1, KMSGTYPEMIX=2, KMSGTYPEFILE=3, KMSGTYPESTRUCT=4, KMSGTYPEGRAYTIPS=5, KMSGTYPEPTT=6, KMSGTYPEVIDEO=7, KMSGTYPEMULTIMSGFORWARD=8, KMSGTYPEREPLY=9, KMSGTYPEARKSTRUCT=11
    // 简化版: Text=1, Picture=2, File=3, Video=4, Voice=5, Reply=7
    const typeNum = typeof msgType === 'number' ? msgType : Number(msgType);
    switch (typeNum) {
      case 1: // KMSGTYPENULL / Text
      case 2: // KMSGTYPEMIX / Picture (混合消息，通常包含文本)
        return 'text';
      case 3: // KMSGTYPEFILE / File
        return 'file';
      case 4: // KMSGTYPESTRUCT / Video (简化版)
      case 7: // KMSGTYPEVIDEO (原始枚举)
        return 'video';
      case 5: // KMSGTYPEGRAYTIPS / Voice (简化版)
        return 'system';
      case 6: // KMSGTYPEPTT
        return 'audio';
      case 8: // KMSGTYPEMULTIMSGFORWARD
        return 'forward';
      case 9: // KMSGTYPEREPLY
        return 'reply';
      case 11: // KMSGTYPEARKSTRUCT
        return 'json';
      default:
        return `type_${typeNum}`;
    }
  }

  /**
   * 单趟解析消息内容
   */
  private async parseMessageContent(message: RawMessage, forwardDepth: number = 0): Promise<MessageContent> {
    const elements = message.elements || [];
    const parsedElements: MessageElementData[] = new Array(elements.length);
    const resources: ResourceData[] = [];
    const mentions: MentionData[] = [];

    const textB = new ChunkedBuilder();
    const htmlB = new ChunkedBuilder();
    const htmlEnabled = this.options.html !== 'none';

    let count = 0;
    for (let i = 0; i < elements.length; i++) {
      const element = elements[i]!;
      const parsed = await this.parseElement(element, message, forwardDepth);
      if (!parsed) continue;
      parsedElements[count++] = parsed;

      // 资源抽取
      const resource = this.extractResource(parsed);
      if (resource) resources.push(resource);

      // 提取 @ 提及信息
      if (parsed.type === 'at') {
        mentions.push({
          uid: parsed.data.uid || 'unknown',
          uin: parsed.data.uin,
          name: parsed.data.name || '某人',
          type: parsed.data.uid === 'all' ? 'all' : 'user'
        });
      }

      // 文本/HTML
      const { text, html } = this.elementToText(parsed, htmlEnabled);
      textB.push(text);
      if (htmlEnabled) htmlB.push(html);
    }
    // 压缩 parsedElements 实际长度
    parsedElements.length = count;

    return {
      text: textB.toString().trim(),
      html: htmlEnabled ? htmlB.toString().trim() : '',
      elements: parsedElements,
      resources,
      mentions
    };
  }

  /**
   * 元素解析（尽量同步，无额外中间对象）
   *
   * forwardDepth 用于跟踪当前消息已经嵌套在多少层合并转发里，超过 MAX_FORWARD_DEPTH
   * 后再遇到 multiForwardMsgElement 时只保留外壳信息，不再递归拉取内层消息。
   */
  private async parseElement(
    element: MessageElement,
    message: RawMessage,
    forwardDepth: number = 0
  ): Promise<MessageElementData | null> {
    // 文本 / @ 提及
    if (element.textElement) {
      const te = element.textElement;
      // atType: 0=普通文本, 1=@全体成员, 2=@某人
      if (te.atType === 1) {
        return {
          type: 'at',
          data: {
            uid: 'all',
            uin: '0',
            name: '全体成员',
            atType: 1
          }
        };
      } else if (te.atType === 2) {
        return {
          type: 'at',
          data: {
            uid: te.atNtUid || te.atUid || 'unknown',
            uin: te.atUid || '0',
            name: (te.content || '').replace(/^@/, ''),
            atType: 2
          }
        };
      }
      // 普通文本
      return {
        type: 'text',
        data: { text: te.content || '' }
      };
    }

    // 表情
    if (element.faceElement) {
      const faceId = element.faceElement.faceIndex?.toString() || '';
      const faceName = element.faceElement.faceText || this.faceMap.get(faceId) || `表情${faceId}`;
      return {
        type: 'face',
        data: {
          id: faceId,
          name: faceName
        }
      };
    }

    // 商城表情
    if (element.marketFaceElement) {
      const emojiId = element.marketFaceElement.emojiId || '';
      const key = element.marketFaceElement.key || '';
      const url = emojiId ? this.generateMarketFaceUrl(emojiId) : '';

      return {
        type: 'market_face',
        data: {
          name: element.marketFaceElement.faceName || '商城表情',
          tabName: (element.marketFaceElement as any).tabName || '',
          key,
          emojiId,
          emojiPackageId: element.marketFaceElement.emojiPackageId,
          url
        }
      };
    }

    // 图片
    if (element.picElement) {
      return {
        type: 'image',
        data: {
          filename: element.picElement.fileName || '图片',
          size: this.parseSizeString(element.picElement.fileSize),
          width: element.picElement.picWidth,
          height: element.picElement.picHeight,
          md5: element.picElement.md5HexStr,
          url: element.picElement.originImageUrl || ''
        }
      };
    }

    // 文件
    if (element.fileElement) {
      return {
        type: 'file',
        data: {
          filename: element.fileElement.fileName || '文件',
          size: this.parseSizeString(element.fileElement.fileSize),
          md5: element.fileElement.fileMd5
        }
      };
    }

    // 视频
    if (element.videoElement) {
      return {
        type: 'video',
        data: {
          filename: element.videoElement.fileName || '视频',
          size: this.parseSizeString(element.videoElement.fileSize),
          duration: (element.videoElement as any).duration || 0,
          thumbSize: this.parseSizeString(element.videoElement.thumbSize)
        }
      };
    }

    // 语音
    if (element.pttElement) {
      return {
        type: 'audio',
        data: {
          filename: element.pttElement.fileName || '语音',
          size: this.parseSizeString(element.pttElement.fileSize),
          duration: element.pttElement.duration || 0
        }
      };
    }

    // 回复
    if (element.replyElement) {
      const replyData = this.extractReplyContent(element.replyElement, message);
      return {
        type: 'reply',
        data: {
          messageId: replyData.messageId,
          referencedMessageId: replyData.referencedMessageId,  // 被引用消息的实际messageId
          previewResourceMessageId: replyData.previewResourceMessageId,
          sourceAvailable: replyData.sourceAvailable,
          senderUin: replyData.senderUin,
          senderName: replyData.senderName,
          content: replyData.content,
          timestamp: replyData.timestamp,
          // issue #128 子项：回复框里的图片 / 表情等元素，HTML 导出时拿来
          // 渲染缩略图。文本字段 `content` 保持「[图片]」「[表情341]」不变，
          // JSON / TXT / Excel 等纯文本导出零影响。
          previewElements: replyData.previewElements
        }
      };
    }

    // 转发
    if (element.multiForwardMsgElement) {
      const resId = element.multiForwardMsgElement.resId || '';
      const xmlContent = element.multiForwardMsgElement.xmlContent || '';

      // 拉合并转发消息卡片里的真实消息列表，导出 JSON / TXT 时把内容也带上（issue #161）。
      // 失败时降级为只保留 XML summary，绝不阻断主导出；嵌套过深也直接停在外壳。
      const innerMessages =
        forwardDepth >= SimpleMessageParser.MAX_FORWARD_DEPTH
          ? []
          : await this.fetchForwardInnerMessages(message, resId, forwardDepth + 1);

      // issue #128 子项 3：拉子消息失败时不再把 XML 原文塞进 summary，
      // 改解析 QQ 客户端的卡片 XML（带 <title>/<summary> 标记）抠出可读预览。
      // 拉成功的情况下也留一份 xmlPreview，方便 fallback 到 fallback 时还能用。
      const xmlInfo = parseMultiForwardXml(xmlContent);
      const cardTitle = xmlInfo.header || '聊天记录';
      const cardSummary = xmlInfo.summary
        || (innerMessages.length > 0 ? `查看${innerMessages.length}条转发消息` : '查看转发消息');
      const messageCount = innerMessages.length > 0
        ? innerMessages.length
        : xmlInfo.messageCount;

      return {
        type: 'forward',
        data: {
          title: cardTitle,
          resId,
          summary: cardSummary,
          preview: xmlInfo.previewLines,
          messageCount,
          messages: innerMessages
        }
      };
    }

    // JSON 卡片
    if (element.arkElement) {
      const jsonContent = element.arkElement.bytesData || '{}';
      const parsedJson = this.parseJsonContent(jsonContent);
      return {
        type: 'json',
        data: {
          content: jsonContent,
          title: parsedJson.title || 'JSON消息',
          description: parsedJson.description,
          url: parsedJson.url,
          preview: parsedJson.preview,
          appName: parsedJson.appName,
          summary: parsedJson.title || parsedJson.description || 'JSON消息'
        }
      };
    }

    // 位置
    if (element.shareLocationElement) {
      return {
        type: 'location',
        data: {
          title: '位置消息',
          summary: '分享了位置'
        }
      };
    }

    // 小灰条（系统提示）
    if (element.grayTipElement) {
      return this.parseGrayTipElement(element.grayTipElement);
    }

    // 长消息 (ElementType 13 - STRUCTLONGMSG)
    if (element.structLongMsgElement) {
      return {
        type: 'long_message',
        data: {
          summary: '长消息',
          resId: element.structLongMsgElement.resId || '',
          xmlContent: element.structLongMsgElement.xmlContent || ''
        }
      };
    }

    // 音视频通话记录 (ElementType 21 - AVRECORD)
    if (element.avRecordElement) {
      const avRecord = element.avRecordElement;
      const typeText = avRecord.type === 1 ? '语音通话' : avRecord.type === 2 ? '视频通话' : '通话';
      const statusText = avRecord.text || '已结束';
      return {
        type: 'av_record',
        data: {
          summary: `${typeText} - ${statusText}`,
          type: avRecord.type,
          time: avRecord.time || '0',
          text: statusText,
          mainType: avRecord.mainType,
          extraType: avRecord.extraType
        }
      };
    }

    // Markdown (ElementType 14 - MARKDOWN)
    if (element.markdownElement) {
      return {
        type: 'markdown',
        data: {
          content: element.markdownElement.content || '',
          summary: 'Markdown消息'
        }
      };
    }

    // Giphy动图 (ElementType 15 - GIPHY)
    if (element.giphyElement) {
      return {
        type: 'giphy',
        data: {
          id: element.giphyElement.id || '',
          width: element.giphyElement.width || 0,
          height: element.giphyElement.height || 0,
          isClip: element.giphyElement.isClip || false,
          summary: 'Giphy动图'
        }
      };
    }

    // 内联键盘 (ElementType 17 - INLINEKEYBOARD)
    if (element.inlineKeyboardElement) {
      return {
        type: 'inline_keyboard',
        data: {
          botAppid: element.inlineKeyboardElement.botAppid || '',
          rows: element.inlineKeyboardElement.rows || [],
          summary: '内联键盘'
        }
      };
    }

    // 日历 (ElementType 19 - CALENDAR)
    if (element.calendarElement) {
      return {
        type: 'calendar',
        data: {
          summary: element.calendarElement.summary || '日历',
          msg: element.calendarElement.msg || '',
          expireTimeMs: element.calendarElement.expireTimeMs || '0',
          schemaType: element.calendarElement.schemaType || 0
        }
      };
    }

    // YOLO游戏结果 (ElementType 20 - YOLOGAMERESULT)
    if (element.yoloGameResultElement) {
      return {
        type: 'yolo_game_result',
        data: {
          userInfo: element.yoloGameResultElement.UserInfo || [],
          summary: 'YOLO游戏结果'
        }
      };
    }

    // 表情气泡 (ElementType 27 - FACEBUBBLE)
    if (element.faceBubbleElement) {
      return {
        type: 'face_bubble',
        data: {
          faceCount: element.faceBubbleElement.faceCount || 0,
          faceSummary: element.faceBubbleElement.faceSummary || '',
          summary: element.faceBubbleElement.faceSummary || '表情气泡'
        }
      };
    }

    // 豆腐记录 (ElementType 23 - TOFURECORD)
    if (element.tofuRecordElement) {
      return {
        type: 'tofu_record',
        data: {
          type: element.tofuRecordElement.type || 0,
          descriptionContent: element.tofuRecordElement.descriptionContent || '',
          summary: element.tofuRecordElement.descriptionContent || '豆腐记录'
        }
      };
    }

    // 置顶任务消息 (ElementType 29 - TASKTOPMSG)
    if (element.taskTopMsgElement) {
      return {
        type: 'task_top_msg',
        data: {
          msgTitle: element.taskTopMsgElement.msgTitle || '',
          msgSummary: element.taskTopMsgElement.msgSummary || '',
          iconUrl: element.taskTopMsgElement.iconUrl || '',
          summary: element.taskTopMsgElement.msgTitle || '置顶消息'
        }
      };
    }

    // 推荐消息 (ElementType 43 - RECOMMENDEDMSG)
    if (element.recommendedMsgElement) {
      return {
        type: 'recommended_msg',
        data: {
          botAppid: (element.recommendedMsgElement as any).botAppid || '',
          summary: '推荐消息'
        }
      };
    }

    // 操作栏 (ElementType 44 - ACTIONBAR)
    if (element.actionBarElement) {
      return {
        type: 'action_bar',
        data: {
          botAppid: element.actionBarElement.botAppid || '',
          rows: element.actionBarElement.rows || [],
          summary: '操作栏'
        }
      };
    }

    // 未知类型
    console.warn(`[SimpleMessageParser] 未知消息元素类型: ${element.elementType}`, element);
    return {
      type: 'system',
      data: {
        elementType: element.elementType,
        summary: this.getSystemMessageSummary(element),
        text: this.getSystemMessageSummary(element)
      }
    };
  }

  private extractResource(element: MessageElementData): ResourceData | null {
    if (!['image', 'file', 'video', 'audio'].includes(element.type)) return null;
    const d = element.data || {};
    return {
      type: element.type,
      filename: d.filename || '未知',
      size: d.size || 0,
      url: d.url,
      localPath: d.localPath, // 包含本地路径信息
      width: d.width,
      height: d.height,
      duration: d.duration
    };
  }

  private elementToText(element: MessageElementData, htmlEnabled: boolean): { text: string; html: string } {
    switch (element.type) {
      case 'text': {
        const t = element.data.text || '';
        return { text: t, html: htmlEnabled ? escapeHtmlFast(t) : '' };
      }
      case 'face': {
        const t = `[表情${element.data.id}]`;
        return { text: t, html: htmlEnabled ? t : '' };
      }
      case 'market_face': {
        const t = `[${element.data.name || '表情'}]`;
        return { text: t, html: htmlEnabled ? t : '' };
      }
      case 'image': {
        const t = `[图片:${element.data.filename}]`;
        return { text: t, html: htmlEnabled ? `<img alt="${escapeHtmlFast(element.data.filename)}" class="image">` : '' };
      }
      case 'file': {
        const t = `[文件:${element.data.filename}]`;
        return { text: t, html: htmlEnabled ? `<span class="file">${escapeHtmlFast(t)}</span>` : '' };
      }
      case 'video': {
        const t = `[视频:${element.data.filename}]`;
        return { text: t, html: htmlEnabled ? `<span class="video">${escapeHtmlFast(t)}</span>` : '' };
      }
      case 'audio': {
        const t = `[语音:${element.data.duration}秒]`;
        return { text: t, html: htmlEnabled ? `<span class="audio">${escapeHtmlFast(t)}</span>` : '' };
      }
      case 'at': {
        const name = element.data.name || '某人';
        const t = `@${name}`;
        const uid = element.data.uid || 'unknown';
        if (uid === 'all') {
          return { text: t, html: htmlEnabled ? `<span class="mention mention-all">${escapeHtmlFast(t)}</span>` : '' };
        }
        return { text: t, html: htmlEnabled ? `<span class="mention" data-uid="${uid}">${escapeHtmlFast(t)}</span>` : '' };
      }
      case 'reply': {
        const t = `[回复消息]`;
        return { text: t, html: htmlEnabled ? `<div class="reply">${t}</div>` : '' };
      }
      case 'forward': {
        const inner: ForwardInnerMessage[] = Array.isArray(element.data?.messages) ? element.data.messages : [];
        const count = element.data?.messageCount ?? inner.length;
        // issue #128：拉子消息失败时退回到 multiForwardMsg XML 抠出来的卡片预览行（已 unescape，无 XML）。
        const xmlPreview: string[] = Array.isArray(element.data?.preview)
          ? element.data.preview.filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0)
          : [];

        // 预览前几条作者+文本，方便扫一眼能看到合并转发里到底是什么内容。
        const innerPreviewLines = inner.slice(0, 3).map((m) => {
          const name = m?.sender?.name || (m?.sender?.uin ? String(m.sender.uin) : '');
          const body = (m?.content?.text || '').replace(/\s+/g, ' ').trim();
          const trimmedBody = body.length > 40 ? body.slice(0, 40) + '…' : body;
          if (name && trimmedBody) return `${name}: ${trimmedBody}`;
          if (name) return name;
          return trimmedBody;
        }).filter(Boolean);
        const previewLines = innerPreviewLines.length > 0
          ? innerPreviewLines
          : xmlPreview.slice(0, 3).map((l) => l.length > 60 ? l.slice(0, 60) + '…' : l);

        const header = count > 0 ? `[转发消息: ${count}条]` : `[转发消息]`;
        const text = previewLines.length > 0 ? `${header}\n${previewLines.map((l) => `  ${l}`).join('\n')}` : header;

        if (!htmlEnabled) {
          return { text, html: '' };
        }

        let innerHtml = '';
        if (inner.length > 0) {
          innerHtml = `<ul class="forward-inner">${inner.map((m) => {
            const name = escapeHtmlFast(m?.sender?.name || (m?.sender?.uin ? String(m.sender.uin) : '未知'));
            const body = escapeHtmlFast((m?.content?.text || '').replace(/\s+/g, ' ').trim());
            return `<li><span class="forward-inner-sender">${name}</span><span class="forward-inner-text">${body}</span></li>`;
          }).join('')}</ul>`;
        } else if (xmlPreview.length > 0) {
          innerHtml = `<ul class="forward-inner">${xmlPreview.slice(0, 5).map((line) => {
            return `<li><span class="forward-inner-text">${escapeHtmlFast(line)}</span></li>`;
          }).join('')}</ul>`;
        }
        return {
          text,
          html: `<div class="forward">${escapeHtmlFast(header)}${innerHtml}</div>`
        };
      }
      case 'location': {
        const t = `[位置消息]`;
        return { text: t, html: htmlEnabled ? `<div class="location">${t}</div>` : '' };
      }
      case 'json': {
        const t = `[JSON消息]`;
        return { text: t, html: htmlEnabled ? `<div class="json">${t}</div>` : '' };
      }
      case 'long_message': {
        const t = `[长消息]`;
        return { text: t, html: htmlEnabled ? `<div class="long-message">${t}</div>` : '' };
      }
      case 'av_record': {
        const t = element.data.summary || '[通话记录]';
        return { text: t, html: htmlEnabled ? `<div class="av-record">${escapeHtmlFast(t)}</div>` : '' };
      }
      case 'markdown': {
        const t = `[Markdown消息]`;
        return { text: t, html: htmlEnabled ? `<div class="markdown">${t}</div>` : '' };
      }
      case 'giphy': {
        const t = `[Giphy动图]`;
        return { text: t, html: htmlEnabled ? `<div class="giphy">${t}</div>` : '' };
      }
      case 'inline_keyboard': {
        const t = `[内联键盘]`;
        return { text: t, html: htmlEnabled ? `<div class="inline-keyboard">${t}</div>` : '' };
      }
      case 'calendar': {
        const t = element.data.summary || '[日历]';
        return { text: t, html: htmlEnabled ? `<div class="calendar">${escapeHtmlFast(t)}</div>` : '' };
      }
      case 'yolo_game_result': {
        const t = `[YOLO游戏结果]`;
        return { text: t, html: htmlEnabled ? `<div class="yolo-game">${t}</div>` : '' };
      }
      case 'face_bubble': {
        const t = element.data.summary || '[表情气泡]';
        return { text: t, html: htmlEnabled ? `<div class="face-bubble">${escapeHtmlFast(t)}</div>` : '' };
      }
      case 'tofu_record': {
        const t = element.data.summary || '[豆腐记录]';
        return { text: t, html: htmlEnabled ? `<div class="tofu-record">${escapeHtmlFast(t)}</div>` : '' };
      }
      case 'task_top_msg': {
        const t = element.data.summary || '[置顶消息]';
        return { text: t, html: htmlEnabled ? `<div class="task-top">${escapeHtmlFast(t)}</div>` : '' };
      }
      case 'recommended_msg': {
        const t = `[推荐消息]`;
        return { text: t, html: htmlEnabled ? `<div class="recommended">${t}</div>` : '' };
      }
      case 'action_bar': {
        const t = `[操作栏]`;
        return { text: t, html: htmlEnabled ? `<div class="action-bar">${t}</div>` : '' };
      }
      case 'system': {
        const t = element.data.text || element.data.summary || '系统消息';
        return { text: t, html: htmlEnabled ? `<div class="system">${escapeHtmlFast(t)}</div>` : '' };
      }
      default: {
        const rawText = element.data.text || element.data.summary || element.data.content || '';
        return { text: rawText, html: htmlEnabled ? (rawText ? `<span>${escapeHtmlFast(rawText)}</span>` : '') : '' };
      }
    }
  }

  private parseSizeString(size: string | number | undefined): number {
    if (typeof size === 'number') return size;
    if (typeof size === 'string') {
      const n = parseInt(size, 10);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }

  /**
   * 拉合并转发消息卡片里的子消息列表，并把每条子消息扁平化成 ForwardInnerMessage（issue #161）。
   *
   * 数据来源优先级：
   *   1) message.records（NapCat 推消息时偶尔会顺手填上）
   *   2) bridge 的 NapCatCore.apis.MsgApi.getMultiMsg(...)
   *
   * 任何一步抛错都吞掉返回空数组，外层在 summary / xmlContent 上还是有兜底信息。
   */
  private async fetchForwardInnerMessages(
    message: RawMessage,
    resId: string,
    depth: number
  ): Promise<ForwardInnerMessage[]> {
    if (depth > SimpleMessageParser.MAX_FORWARD_DEPTH) return [];

    let raws: RawMessage[] = [];
    const inlineRecords = (message as any).records;
    if (Array.isArray(inlineRecords) && inlineRecords.length > 0) {
      // hydrateReplyRecords 也会把引用原消息放进 records，但它不是
      // 合并转发消息卡片的子节点，不能混进展开后的聊天记录。
      raws = inlineRecords.filter((record: RawMessage) => !(record as any)?.__qceReplyRecord);
    }

    if (raws.length === 0) {
      raws = await this.fetchNativeForwardRawMessages(message, resId);
    }

    if (raws.length === 0) {
      const fromAction = await this.fetchForwardInnerMessagesByAction(message, resId, depth);
      if (fromAction.length > 0) {
        return fromAction;
      }
    }

    if (raws.length === 0) return [];

    const out: ForwardInnerMessage[] = [];
    for (const raw of raws) {
      if (!raw) continue;
      try {
        const tsMs = millisFromUnixSeconds(raw.msgTime as any);
        this.cacheSenderInfo(raw);
        const senderInfo = this.getSenderDisplayInfo(raw);
        // 协议头像存在时，QQ 同时返回的 fromUin/fromUid 是匿名占位身份，
        // 不把它序列化成该节点发送者的真实账号。
        const senderUid = (raw as any).__qceForwardProtocolAvatar
          ? ''
          : String(raw.senderUid || '').trim();
        const senderUin = await this.resolveNativeForwardSenderUin(raw, senderUid);

        const elementsArr: MessageElementData[] = [];
        const textParts: string[] = [];

        const els = raw.elements || [];
        for (const el of els) {
          const parsed = await this.parseElement(el, raw, depth);
          if (!parsed) continue;
          elementsArr.push(parsed);
          const rendered = this.elementToText(parsed, false);
          if (rendered.text) textParts.push(rendered.text);
        }

        out.push({
          id: String((raw as any).__qceResourceKey || raw.msgId || ''),
          timestamp: tsMs,
          time: rfc3339FromMillis(tsMs),
          sender: {
            uid: senderUid || undefined,
            uin: senderUin || undefined,
            name: senderInfo.name,
            avatarUrl: this.resolveForwardAvatarUrl([
              (raw as any).avatarUrl,
              (raw as any).avatar,
              (raw as any).senderAvatar,
              (raw as any).sender?.avatarUrl,
              (raw as any).sender?.avatar
            ], senderUin, senderUid)
          },
          content: {
            text: textParts.join(''),
            elements: elementsArr
          }
        });
      } catch {
        // 单条子消息解析失败时跳过，避免拖死整批。
      }
    }
    return out;
  }

  private async fetchForwardInnerMessagesByAction(
    message: RawMessage,
    resId: string,
    depth: number
  ): Promise<ForwardInnerMessage[]> {
    const bridge = (globalThis as any).__NAPCAT_BRIDGE__;
    const getForwardAction = bridge?.actions?.get?.('get_forward_msg');
    if (!getForwardAction) return [];

    for (const messageId of [message.msgId, resId].filter(Boolean)) {
      try {
        const result = await getForwardAction.handle({ message_id: messageId }, 'plugin', {});
        const messages = result?.data?.messages;
        if (Array.isArray(messages) && messages.length > 0) {
          return this.normalizeForwardActionMessages(messages, depth);
        }
      } catch {
        // 继续尝试下一个 messageId / resId。
      }
    }
    return [];
  }

  private normalizeForwardActionMessages(
    messages: any[],
    depth: number = 0
  ): ForwardInnerMessage[] {
    if (depth > SimpleMessageParser.MAX_FORWARD_DEPTH) return [];

    const out: ForwardInnerMessage[] = [];
    for (const item of this.normalizeOneBotForwardEntries(messages)) {
      if (!item) continue;
      const sender = item.sender || {};
      const elements = this.getOneBotMessageSegments(item).map((element: any) => {
        const type = String(element?.type || 'unknown').toLowerCase();
        const data = element?.data || {};
        if (type !== 'forward' && type !== 'node') return { type, data };

        const contentEntries = this.getOneBotForwardContentEntries(
          type === 'node'
            ? this.getOneBotNodeSegments(element)
            : (data.content ?? data.message)
        );
        const innerMessages = depth < SimpleMessageParser.MAX_FORWARD_DEPTH
          ? this.normalizeForwardActionMessages(contentEntries, depth + 1)
          : [];
        const explicitCount = Number(data.message_count ?? data.messageCount);
        return {
          type: 'forward',
          data: {
            ...data,
            title: data.title || '聊天记录',
            resId: String(data.id || data.res_id || data.resId || ''),
            summary: data.summary || (innerMessages.length > 0
              ? `查看${innerMessages.length}条转发消息`
              : '查看转发消息'),
            messageCount: Number.isFinite(explicitCount) ? explicitCount : innerMessages.length,
            messages: innerMessages
          }
        };
      });
      const textFromElements = elements
        .map((element) => this.elementToText(element, false).text)
        .filter(Boolean)
        .join('');
      const rawText = typeof item.raw_message === 'string' ? item.raw_message : '';
      const text = textFromElements || rawText;
      const tsMs = millisFromUnixSeconds(item.time || 0);
      const senderName = sender.card || sender.nickname || sender.name || String(item.user_id || sender.user_id || '');
      const senderUid = String(
        sender.user_uid ?? sender.uid ?? item.user_uid ?? item.uid ?? item.user_id ?? ''
      ).trim();
      const senderUin = String(sender.user_id ?? sender.uin ?? item.user_id ?? item.uin ?? '').trim();

      out.push({
        id: String(item.message_id || item.real_id || item.message_seq || item.real_seq || ''),
        timestamp: tsMs,
        time: rfc3339FromMillis(tsMs),
        sender: {
          uid: senderUid || undefined,
          uin: senderUin || undefined,
          name: senderName,
          avatarUrl: this.resolveForwardAvatarUrl([
            sender.avatarUrl,
            sender.avatar_url,
            sender.avatar,
            item.avatarUrl,
            item.avatar_url,
            item.avatar
          ], senderUin, senderUid)
        },
        content: {
          text,
          elements
        }
      });
    }
    return out;
  }

  /**
   * 优先保留 NapCat / OneBot 给出的头像地址；没有时只对纯数字 QQ 号
   * 生成 qlogo URL。`u_xxx` 形式的 UID 不能直接用于 qlogo，留给 HTML
   * 用姓名首字作离线兜底。
   */
  private resolveForwardAvatarUrl(
    explicitCandidates: unknown[],
    senderUin?: string,
    senderUid?: string
  ): string | undefined {
    for (const candidate of explicitCandidates) {
      if (typeof candidate !== 'string') continue;
      const url = candidate.trim();
      if (/^https?:\/\//i.test(url) || /^data:image\//i.test(url)) return url;
    }
    const numericId = [senderUin, senderUid]
      .map(value => String(value || '').trim())
      .find(value => /^\d{5,14}$/.test(value));
    return numericId
      ? `https://q1.qlogo.cn/g?b=qq&nk=${numericId}&s=100`
      : undefined;
  }

  private async resolveNativeForwardSenderUin(raw: RawMessage, senderUid: string): Promise<string> {
    const rawUin = String(raw.senderUin || (raw as any).senderUinStr || '').trim();
    if (/^\d{5,14}$/.test(senderUid)) return senderUid;
    if (!senderUid) return '';

    let pending = this.forwardSenderUinCache.get(senderUid);
    if (!pending) {
      pending = (async () => {
        const bridge = (globalThis as any).__NAPCAT_BRIDGE__;
        const userApi = bridge?.core?.apis?.UserApi || bridge?.core?.apis?.user;
        const converter = userApi?.getUinByUidV2;
        if (typeof converter !== 'function') return '';
        try {
          const converted = String(await converter.call(userApi, senderUid) || '').trim();
          return /^\d{5,14}$/.test(converted) ? converted : '';
        } catch {
          return '';
        }
      })();
      this.forwardSenderUinCache.set(senderUid, pending);
    }

    // senderUid 存在时，rawUin 在真实样本中已证实可能是外层发送者。
    // 转换失败就返回空，让 HTML 用名字首字兜底，不冒用错误头像。
    return await pending;
  }

  private isSystemMessage(message: RawMessage): boolean {
    return message.msgType === NTMsgType.KMSGTYPEGRAYTIPS;
  }

  private createErrorMessage(message: RawMessage, error: any): CleanMessage {
    const tsMs = millisFromUnixSeconds(message.msgTime as any);
    const timestamp = tsMs > 0 ? tsMs : Date.now();
    const senderInfo = this.getSenderDisplayInfo(message);

    const errMsg = (error && (error.message || error.toString?.())) || 'Unknown';
    return {
      id: message.msgId,
      seq: message.msgSeq,
      timestamp,
      time: rfc3339FromMillis(timestamp),
      sender: {
        uid: message.senderUid || '未知',
        uin: message.senderUin,
        name: senderInfo.name,
        nickname: senderInfo.nickname,
        groupCard: senderInfo.groupCard,
        remark: senderInfo.remark,
        title: this.resolveSenderTitle(message)
      },
      type: 'error',
      content: {
        text: `[解析失败: ${errMsg}]`,
        html: `<span class="error">[解析失败: ${escapeHtmlFast(errMsg)}]</span>`,
        elements: [],
        resources: [],
        mentions: []
      },
      recalled: false,
      system: false
    };
  }

  private getTrimmedText(value: unknown): string | undefined {
    if (value === null || value === undefined) return undefined;
    const text = String(value).trim();
    return text || undefined;
  }

  private getSenderDisplayInfo(message: RawMessage): {
    name: string;
    nickname: string | undefined;
    groupCard: string | undefined;
    remark: string | undefined;
  } {
    let groupCard = this.getTrimmedText(message.sendMemberName);
    let remark = this.getTrimmedText(message.sendRemarkName);
    let nickname = this.getTrimmedText(message.sendNickName);
    const isGroupChat = message.chatType === 2;
    const preferGroupMemberName = isGroupChat && this.options.preferGroupMemberName !== false;

    // #274：当本条消息没有任何可读名字时，回退到同发件人在其他消息上出现过的名字。
    if (!groupCard && !remark && !nickname) {
      const cached = this.lookupCachedSenderInfo(message);
      if (cached) {
        groupCard = cached.groupCard;
        remark = cached.remark;
        nickname = cached.nickname;
      }
    }

    const name = (
      isGroupChat
        ? (preferGroupMemberName ? groupCard || remark || nickname : nickname)
        : remark || nickname
    ) || this.getTrimmedText(message.senderUin) || this.getTrimmedText(message.senderUid) || '未知用户';

    return {
      name,
      nickname,
      groupCard,
      remark
    };
  }

  /** @deprecated 使用 isPureMediaMessage 代替 */
  isPureImageMessage(message: CleanMessage): boolean {
    return this.isPureMediaMessage(message);
  }

  isPureMediaMessage(message: CleanMessage): boolean {
    const els = message.content.elements || [];
    
    // 必须包含媒体元素
    const hasMedia = els.some((e) => ['image', 'video', 'audio', 'file', 'face'].includes(e.type));
    if (!hasMedia) return false;

    // 最可靠的判断：检查实际的文本内容
    // content.text已经是所有元素解析后的纯文本内容
    const actualText = (message.content.text || '').trim();
    
    // 如果有实际的文本内容，则不是纯媒体消息
    if (actualText.length > 0) {
      // 进一步检查是否只包含CQ码
      const withoutCQ = actualText.replace(/\[CQ:[^\]]+\]/g, '').trim();
      if (withoutCQ.length > 0) {
        return false; // 有实际文字内容，不过滤
      }
    }

    // 没有实际文字内容，判定为纯媒体消息
    return true;
  }

  private hasRealTextContent(message: CleanMessage): boolean {
    const textEls = message.content.elements.filter((e) => e.type === 'text');
    for (let i = 0; i < textEls.length; i++) {
      const t = textEls[i]!.data?.text || '';
      if (t.trim().length > 0 && !this.isOnlyCQCode(t)) return true;
    }
    return false;
  }

  private isOnlyCQCode(text: string): boolean {
    if (!text || text.trim().length === 0) return true;
    // 移除所有 CQ 码，检测是否还有实际文字
    const without = text.replace(/\[CQ:[^\]]+\]/g, '').trim();
    return without.length === 0;
  }

  filterMessages(messages: CleanMessage[], includePureImages: boolean = true): CleanMessage[] {
    if (includePureImages) return messages;
    return messages.filter((m) => !this.isPureMediaMessage(m));
  }

  calculateStatistics(messages: CleanMessage[]): MessageStatistics {
    const stats: MessageStatistics = {
      total: messages.length,
      byType: {},
      bySender: {},
      resources: {
        total: 0,
        byType: {},
        totalSize: 0
      },
      timeRange: {
        start: '',
        end: '',
        durationDays: 0
      }
    };

    if (messages.length === 0) return stats;

    // 时间范围
    const ts = messages.map((m) => m.timestamp).filter((t) => t > 0).sort((a, b) => a - b);
    if (ts.length > 0) {
      const start = new Date(ts[0]!);
      const end = new Date(ts[ts.length - 1]!);
      stats.timeRange = {
        start: start.toISOString(),
        end: end.toISOString(),
        durationDays: Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
      };
    }

    // 统计
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      if (!m || !m.content) continue;

      // 类型
      stats.byType[m.type] = (stats.byType[m.type] || 0) + 1;

      // 发送者
      const senderKey = m.sender?.name || m.sender?.uid || '未知用户';
      if (!stats.bySender[senderKey]) {
        stats.bySender[senderKey] = {
          uid: m.sender?.uid || 'unknown',
          uin: m.sender?.uin,
          count: 0
        };
      }
      if (!stats.bySender[senderKey]!.uin && m.sender?.uin) {
        stats.bySender[senderKey]!.uin = m.sender.uin;
      }
      stats.bySender[senderKey]!.count++;

      // 资源
      const res = m.content.resources || [];
      for (let j = 0; j < res.length; j++) {
        const r = res[j]!;
        stats.resources.total++;
        const t = r.type || 'unknown';
        stats.resources.byType[t] = (stats.resources.byType[t] || 0) + 1;
        stats.resources.totalSize += r.size || 0;
      }
    }

    return stats;
  }

  async updateResourcePaths(messages: CleanMessage[], resourceMap: Map<string, any[]>): Promise<void> {
    for (let mi = 0; mi < messages.length; mi++) {
      const message = messages[mi]!;
      const resources = resourceMap.get(message.id);
      if (resources && resources.length > 0) {
        this.updateSingleMessageResourcePaths(message, resources);
      }
    }
    // issue #128：所有消息的资源路径写完之后，再回头把 reply 元素里的
    // previewElements.localPath 拉齐，让 HTML 导出能直接渲染缩略图。
    this.backfillReplyPreviewLocalPaths(messages);
    for (const message of messages) {
      this.backfillReplyPreviewLocalPathsFromResourceMap(message, resourceMap);
      this.backfillForwardInnerResourcePathsFromResourceMap(message, resourceMap);
    }
  }

  /**
   * 合并转发详情的子消息不在顶层 messages 数组中，但 ResourceHandler 会把
   * message.records 里的资源按子消息 id 写入 resourceMap。这里递归回填路径，
   * 让离线 HTML 展开卡片后也能显示图片、视频、语音和文件。
   */
  private backfillForwardInnerResourcePathsFromResourceMap(
    message: CleanMessage,
    resourceMap: Map<string, any[]>
  ): void {
    const visitElements = (elements: MessageElementData[]): void => {
      for (const element of elements) {
        if (element.type !== 'forward' || !Array.isArray(element.data?.messages)) continue;
        for (const innerMessage of element.data.messages as ForwardInnerMessage[]) {
          const innerElements = Array.isArray(innerMessage?.content?.elements)
            ? innerMessage.content.elements
            : [];
          const resources = innerMessage?.id ? (resourceMap.get(String(innerMessage.id)) || []) : [];
          let resourceIndex = 0;

          for (const innerElement of innerElements) {
            if (!['image', 'video', 'audio', 'file'].includes(innerElement.type)) continue;
            const matching = resources.find((resource, index) =>
              index >= resourceIndex
              && resource?.type === innerElement.type
              && resource?.localPath
              && resource?.accessible !== false
            );
            if (!matching) continue;
            const fileName = path.basename(String(matching.localPath));
            const typeDir = `${matching.type}s`;
            innerElement.data = innerElement.data && typeof innerElement.data === 'object'
              ? innerElement.data
              : {};
            innerElement.data.localPath = `${typeDir}/${fileName}`;
            innerElement.data.url = `resources/${typeDir}/${fileName}`;
            resourceIndex = resources.indexOf(matching) + 1;
          }

          visitElements(innerElements);
        }
      }
    };

    visitElements(message.content.elements);
  }

  /**
   * 二次回填：扫一遍 messages，把每条 reply 元素的 previewElements 里的
   * 图片片段补上 `localPath`，方便 HTML 导出器直接渲染缩略图。
   *
   * 匹配规则：先按 md5（picElement.md5HexStr 一对一稳定映射），匹配不到时
   * 按顺序兜底（极端老快照里 md5 可能缺失）。被引用消息不在导出范围内时
   * 自然找不到，留空让 HTML 端走「[图片]」文字回退。
   */
  public backfillReplyPreviewLocalPaths(messages: CleanMessage[]): void {
    if (messages.length === 0) return;
    // 第一步：建 msgId → image[] 索引
    const imagesByMsgId = new Map<string, Array<{ md5: string; localPath: string }>>();
    for (const m of messages) {
      const imgs: Array<{ md5: string; localPath: string }> = [];
      for (const el of m.content.elements) {
        if (el.type !== 'image' || !el.data || typeof el.data !== 'object') continue;
        const data = el.data as { md5?: string; localPath?: string };
        if (!data.localPath) continue;
        imgs.push({ md5: String(data.md5 || ''), localPath: data.localPath });
      }
      if (imgs.length > 0) imagesByMsgId.set(m.id, imgs);
    }
    if (imagesByMsgId.size === 0) return;
    // 第二步：扫所有 reply 元素，按 referencedMessageId 找回原消息的图片
    for (const m of messages) {
      for (const el of m.content.elements) {
        if (el.type !== 'reply' || !el.data || typeof el.data !== 'object') continue;
        const data = el.data as { referencedMessageId?: string; previewElements?: ReplyPreviewElement[] };
        const refId = data.referencedMessageId ? String(data.referencedMessageId) : '';
        if (!refId || !Array.isArray(data.previewElements)) continue;
        const refImgs = imagesByMsgId.get(refId);
        if (!refImgs || refImgs.length === 0) continue;
        let fallbackIdx = 0;
        for (const pe of data.previewElements) {
          if (pe.type !== 'image') continue;
          const byMd5 = pe.md5 ? refImgs.find(r => r.md5 && r.md5 === pe.md5) : null;
          const candidate = byMd5 || refImgs[fallbackIdx];
          if (candidate?.localPath) pe.localPath = candidate.localPath;
          fallbackIdx++;
        }
      }
    }
  }

  /**
   * 流式导出无法在 CleanMessage 层回看已经 yield 的源消息，因此直接从
   * ResourceHandler 返回的 msgId → resources 映射回填引用缩略图。这个映射
   * 同时包含顶层消息和 reply records 快照，所以引用源不在导出时间范围内时
   * 也仍能使用本地缩略图。
   */
  public backfillReplyPreviewLocalPathsFromResourceMap(
    message: CleanMessage,
    resourceMap: Map<string, any[]>
  ): void {
    for (const el of message.content.elements) {
      if (el.type !== 'reply' || !el.data || typeof el.data !== 'object') continue;
      const data = el.data as {
        referencedMessageId?: string;
        previewResourceMessageId?: string;
        messageId?: string;
        previewElements?: ReplyPreviewElement[];
      };
      if (!Array.isArray(data.previewElements)) continue;
      const resourceKey = [data.previewResourceMessageId, data.referencedMessageId, data.messageId]
        .map(value => value == null ? '' : String(value))
        .find(value => value && resourceMap.has(value));
      if (!resourceKey) continue;
      const availableResources = (resourceMap.get(resourceKey) || [])
        // ResourceHandler 在下载失败时也会保留“计划写入”的 localPath；只有
        // accessible=true 才代表文件确实存在，避免 HTML 指向 ZIP 中不存在的文件。
        .filter(resource => ['image', 'video', 'audio', 'file'].includes(resource?.type)
          && resource?.localPath
          && resource?.accessible === true
          && fs.existsSync(String(resource.localPath)))
        .map(resource => ({
          type: String(resource.type),
          md5: String(resource.md5 || ''),
          localPath: `${String(resource.type)}s/${path.basename(String(resource.localPath))}`
        }));
      if (availableResources.length === 0) continue;
      const fallbackIndexes = new Map<string, number>();
      for (const preview of data.previewElements) {
        if (!['image', 'video', 'audio', 'file'].includes(preview.type)) continue;
        const candidates = availableResources.filter(resource => resource.type === preview.type);
        const fallbackIdx = fallbackIndexes.get(preview.type) || 0;
        const byMd5 = preview.md5
          ? candidates.find(resource => resource.md5 && resource.md5 === preview.md5)
          : undefined;
        const candidate = byMd5 || candidates[fallbackIdx];
        if (candidate) preview.localPath = candidate.localPath;
        fallbackIndexes.set(preview.type, fallbackIdx + 1);
      }
    }
  }

  /**
   * 更新单条消息的资源路径（供批量、流式以及 JSON / TXT / Excel 等
   * 非 HTML 导出器逐条调用）。issue #277。
   */
  public updateSingleMessageResourcePaths(message: CleanMessage, resources: any[]): void {
    console.log(`[SimpleMessageParser] 更新消息 ${message.id} 的资源路径，资源数量: ${resources.length}`);
    
    // 更新 message.content.resources
    const resArr = message.content.resources;
    const n = Math.min(resArr.length, resources.length);
    for (let i = 0; i < n; i++) {
      const info = resources[i];
      if (info && info.localPath) {
        const fileName = path.basename(info.localPath);
        const typeDir = info.type + 's';  // image -> images, video -> videos
        // 修复 Issue #30: 保留类型子目录，让导出器能正确找到文件
        resArr[i]!.localPath = `${typeDir}/${fileName}`;
        resArr[i]!.url = `resources/${typeDir}/${fileName}`;
        resArr[i]!.type = info.type;
        console.log(`[SimpleMessageParser] 资源 ${i}: type=${info.type}, path=${typeDir}/${fileName}`);
      } else {
        console.warn(`[SimpleMessageParser] 资源 ${i} 无localPath:`, info);
      }
    }

    // 更新 elements 中的 URL
    // 按类型和顺序匹配，而不是按文件名（因为下载后文件名可能改变）
    const els = message.content.elements;
    let resourceIndex = 0;
    
    console.log(`[SimpleMessageParser] 消息有 ${els.length} 个元素`);
    
    for (let i = 0; i < els.length; i++) {
      const el = els[i]!;
      if (!el.data || typeof el.data !== 'object') continue;
      
      // 只处理媒体类型元素
      if (el.type === 'image' || el.type === 'video' || el.type === 'audio' || el.type === 'file') {
        console.log(`[SimpleMessageParser] 元素 ${i}: type=${el.type}, filename=${(el.data as any).filename}`);
        
        // 按顺序匹配对应类型的资源
        const matchingResource = resources.find((r, idx) => 
          idx >= resourceIndex && r.type === el.type
        );
        
        if (matchingResource && matchingResource.localPath) {
          const fileName = path.basename(matchingResource.localPath);
          const typeDir = matchingResource.type + 's';
          // 修复 Issue #30: 保留类型子目录，让导出器能正确找到文件
          (el.data as any).localPath = `${typeDir}/${fileName}`;
          (el.data as any).url = `resources/${typeDir}/${fileName}`;
          
          console.log(`[SimpleMessageParser] ✓ 元素 ${i} 匹配到资源: ${typeDir}/${fileName}`);
          
          // 更新资源索引
          resourceIndex = resources.indexOf(matchingResource) + 1;
        } else {
          console.warn(`[SimpleMessageParser] ✗ 元素 ${i} (type=${el.type}) 未找到匹配资源`);
        }
      }
    }
  }

  private parseJsonContent(jsonString: string): any {
    try {
      const json = fastJsonParse(jsonString);
      const result: any = {};

      // 标题
      if (json.prompt) result.title = json.prompt;
      else if (json.meta?.detail_1?.title) result.title = json.meta.detail_1.title;
      else if (json.meta?.news?.title) result.title = json.meta.news.title;

      // 描述
      if (json.meta?.detail_1?.desc) result.description = json.meta.detail_1.desc;
      else if (json.meta?.news?.desc) result.description = json.meta.news.desc;

      // URL
      if (json.meta?.detail_1?.qqdocurl) result.url = json.meta.detail_1.qqdocurl;
      else if (json.meta?.detail_1?.url) result.url = json.meta.detail_1.url;
      else if (json.meta?.news?.jumpUrl) result.url = json.meta.news.jumpUrl;

      // 预览图
      if (json.meta?.detail_1?.preview) result.preview = json.meta.detail_1.preview;
      else if (json.meta?.news?.preview) result.preview = json.meta.news.preview;

      // 应用名称
      if (json.meta?.detail_1?.title && json.app) result.appName = json.meta.detail_1.title;
      else if (json.app === 'com.tencent.miniapp_01') result.appName = '小程序';

      return result;
    } catch (error) {
      console.warn('[SimpleMessageParser] JSON解析失败:', error);
      return {};
    }
  }

  private extractReplyContent(replyElement: any, message: RawMessage): any {
    const replayMsgId = replyElement.replayMsgId == null ? '' : String(replyElement.replayMsgId);
    const sourceMsgId = replyElement.sourceMsgIdInRecords == null ? '' : String(replyElement.sourceMsgIdInRecords);
    let referencedMessageId: string | undefined;
    let referencedMessage: RawMessage | undefined;
    let source: 'messageMap' | 'records' | 'sourceMsgText' | 'sourceMsgTextElems' | 'referencedMsg' | 'seq' | 'none' = 'none';
    
    // 1. replayMsgId 只有在它确实属于本次导出的顶层消息时才可作为跳转目标。
    if (replayMsgId && replayMsgId !== '0' && this.exportedMessageIds.has(replayMsgId)) {
      referencedMessageId = replayMsgId;
      referencedMessage = this.messageMap.get(replayMsgId);
      source = 'messageMap';
    }

    // 2. NT 数据里的 sourceMsgIdInRecords 通常只是内嵌快照 id；真正源消息
    // 需要通过 replayMsgSeq / replyMsgClientSeq 在顶层消息中定位。
    if (!referencedMessage && replyElement.replayMsgSeq) {
      const bySeq = this.messageBySeq.get(String(replyElement.replayMsgSeq));
      if (bySeq) {
        referencedMessage = bySeq;
        referencedMessageId = String(bySeq.msgId);
        source = 'seq';
      }
    }

    // 3. 客户端序号作为次级索引。
    if (!referencedMessage && replyElement.replyMsgClientSeq) {
      const byClientSeq = this.messageByClientSeq.get(String(replyElement.replyMsgClientSeq));
      if (byClientSeq) {
        referencedMessage = byClientSeq;
        referencedMessageId = String(byClientSeq.msgId);
        source = 'seq';
      }
    }

    // 4. 源消息不在导出范围内时，用 records 快照生成文字/缩略图，但绝不
    // 把 record.msgId 当成 DOM 跳转目标。
    if (!referencedMessage && ((sourceMsgId && sourceMsgId !== '0') || replyElement.replayMsgSeq != null)) {
      referencedMessage = message.records?.find((record: RawMessage) =>
        String(record.msgId) === sourceMsgId
        || (replyElement.replayMsgSeq != null && [record.msgSeq, record.clientSeq, (record as any).realSeq]
          .some(value => value != null && String(value) === String(replyElement.replayMsgSeq)))
      )
        || this.messageMap.get(sourceMsgId);
      if (referencedMessage) source = 'records';
    }

    // #289：被引用消息发件人显示名解析。
    // 历史上这里在很多分支会落到 senderUidStr (`u_xxxxxxxx` 形式) 或 senderUin（QQ 号）。
    // 现在统一走 resolveReplySenderName：
    //   - 找得到原消息：套用 getSenderDisplayInfo 的群名片 / 备注 / 昵称优先级；
    //   - 找不到原消息：先用 replyElement 自带的字段，再回退到本批消息里同一发件人
    //     已被 cacheSenderInfo 收录的可读名字；
    //   - 全部失败时优先用 senderUin（QQ 号）而不是 senderUidStr（u_xxx）。
    const senderName = this.resolveReplySenderName(replyElement, message, referencedMessage);
    const result: {
      messageId: string;
      referencedMessageId: string | undefined;
      previewResourceMessageId: string | undefined;
      sourceAvailable: boolean;
      senderUin: string;
      senderName: string;
      content: string;
      timestamp: number;
      previewElements: ReplyPreviewElement[];
    } = {
      messageId: sourceMsgId || replyElement.replayMsgId || replyElement.replayMsgSeq || '0',
      referencedMessageId,
      previewResourceMessageId: referencedMessage
        ? String((referencedMessage as any).__qceResourceKey || referencedMessage.msgId || sourceMsgId || '')
        : (sourceMsgId || undefined),
      sourceAvailable: Boolean(referencedMessageId),
      senderUin: replyElement.senderUin || (referencedMessage?.senderUin ?? ''),
      senderName,
      content: '原消息',
      timestamp: 0,
      previewElements: []
    };

    // 如果找到了被引用的消息，从中提取内容
    if (referencedMessage) {
      // 保持messageId为sourceMsgId，referencedMessageId已经在前面设置
      result.senderUin = referencedMessage.senderUin;

      // 提取被引用消息的文本内容 + 结构化的 previewElements
      if (referencedMessage.elements && referencedMessage.elements.length > 0) {
        const parts: string[] = [];
        for (const element of referencedMessage.elements) {
          if (element.textElement?.content) {
            parts.push(element.textElement.content);
            result.previewElements.push({ type: 'text', text: element.textElement.content });
          } else if (element.picElement) {
            parts.push('[图片]');
            result.previewElements.push({
              type: 'image',
              text: '[图片]',
              md5: element.picElement.md5HexStr || '',
              originUrl: element.picElement.originImageUrl || '',
              fileName: element.picElement.fileName || ''
            });
          } else if (element.videoElement) {
            // issue #128：视频 / 文件元素带文件名时直接挂在占位符里，
            // JSON / TXT / Excel 这些纯文本导出能看出原消息引用的是哪个视频。
            const videoName = element.videoElement.fileName || '';
            const videoText = videoName ? `[视频:${videoName}]` : '[视频]';
            parts.push(videoText);
            result.previewElements.push({
              type: 'video',
              text: videoText,
              fileName: videoName
            });
          } else if (element.pttElement) {
            parts.push('[语音]');
            result.previewElements.push({ type: 'audio', text: '[语音]' });
          } else if (element.fileElement) {
            const fileName = element.fileElement.fileName || '';
            const fileText = fileName ? `[文件:${fileName}]` : '[文件]';
            parts.push(fileText);
            result.previewElements.push({
              type: 'file',
              text: fileText,
              fileName
            });
          } else if (element.faceElement) {
            // issue #128：表情元素优先用 faceText / faceMap 给出的可读名（如 /微 /奋），
            // 而不是抛"[表情341]"这种调用方还得自己查表的占位文本。
            const faceId = element.faceElement.faceIndex?.toString() || '';
            const faceText = element.faceElement.faceText || this.faceMap.get(faceId) || `表情${faceId}`;
            const facePart = faceText.startsWith('[') ? faceText : `[${faceText}]`;
            parts.push(facePart);
            result.previewElements.push({
              type: 'face',
              text: facePart,
              faceIndex: element.faceElement.faceIndex
            });
          } else if (element.marketFaceElement) {
            const faceName = element.marketFaceElement.faceName || '超级表情';
            parts.push(`[${faceName}]`);
            result.previewElements.push({
              type: 'marketFace',
              text: `[${faceName}]`,
              faceName,
              url: this.generateMarketFaceUrl(element.marketFaceElement.emojiId || '')
            });
          }
        }
        if (parts.length > 0) {
          result.content = parts.join('');
        }
      }
      
      if (referencedMessage.msgTime) {
        result.timestamp = parseInt(referencedMessage.msgTime) || 0;
      }
    } else {
      // 如果没有找到被引用的消息，尝试从 replyElement 中提取内容（备用方案）
    if (replyElement.sourceMsgText) {
      result.content = replyElement.sourceMsgText;
        source = 'sourceMsgText';
    } else if (replyElement.sourceMsgTextElems && replyElement.sourceMsgTextElems.length > 0) {
      const parts = [];
      for (let i = 0; i < replyElement.sourceMsgTextElems.length; i++) {
        const e = replyElement.sourceMsgTextElems[i];
        if (e?.textElement?.content) parts.push(e.textElement.content);
      }
        if (parts.length > 0) {
          result.content = parts.join('');
          source = 'sourceMsgTextElems';
        }
    } else if (replyElement.referencedMsg && replyElement.referencedMsg.msgBody) {
      result.content = replyElement.referencedMsg.msgBody;
        source = 'referencedMsg';
      }
    }

    if (replyElement.replayMsgTime) result.timestamp = replyElement.replayMsgTime;

    return result;
  }

  /**
   * 把被引用消息（reply）发件人解析成一个尽量可读的名字。
   *
   * 解析顺序：
   *  1. 命中 messageMap / records 的原消息：复用 getSenderDisplayInfo（群名片 > 备注 > 昵称）。
   *  2. 否则用 replyElement 自带的 senderMemberName / senderNick 字段。
   *  3. 否则按 senderUid / senderUin 查 senderInfoCache，取本批消息里同发件人的可读名字。
   *  4. 最后退回 senderUin（QQ 号），再退回 senderUidStr（`u_xxx` 形式）。
   *
   * 历史代码会先把 senderName 设为 `replyElement.senderUidStr`，再有条件覆盖；当原消息
   * 不在导出范围内、且 replyElement 也没有 senderNick 字段时就直接显示 `u_xxx`，
   * 即 #289 报告的情况。
   */
  private resolveReplySenderName(
    replyElement: any,
    message: RawMessage,
    referencedMessage: RawMessage | undefined
  ): string {
    if (referencedMessage) {
      const display = this.getSenderDisplayInfo(referencedMessage);
      if (display.name && display.name !== '未知用户') return display.name;
    }

    const senderMemberName = this.getTrimmedText(replyElement.senderMemberName);
    const senderNick = this.getTrimmedText(replyElement.senderNick);
    const isGroupChat = message.chatType === 2;
    const preferGroupMemberName = isGroupChat && this.options.preferGroupMemberName !== false;
    if (preferGroupMemberName && senderMemberName) return senderMemberName;
    if (senderNick) return senderNick;
    if (senderMemberName) return senderMemberName;

    const cached = this.lookupCachedSenderInfo({
      senderUid: replyElement.senderUid,
      senderUin: replyElement.senderUin
    } as RawMessage);
    if (cached) {
      const fromCache = preferGroupMemberName
        ? (cached.groupCard || cached.remark || cached.nickname)
        : (cached.remark || cached.nickname || cached.groupCard);
      if (fromCache) return fromCache;
    }

    const senderUin = this.getTrimmedText(replyElement.senderUin);
    if (senderUin) return senderUin;
    const senderUidStr = this.getTrimmedText(replyElement.senderUidStr);
    if (senderUidStr) return senderUidStr;
    return '';
  }

  private generateMarketFaceUrl(emojiId: string): string {
    if (emojiId.length < 2) return '';
    const prefix = emojiId.substring(0, 2);
    return `https://gxh.vip.qq.com/club/item/parcel/item/${prefix}/${emojiId}/raw300.gif`;
  }

  private parseGrayTipElement(grayTip: any): MessageElementData {
    const subType = grayTip.subElementType;
    let summary = '系统消息';
    let text = '';

    try {
      if (subType === 1 && grayTip.revokeElement) {
        const revokeInfo = grayTip.revokeElement;
        const operatorName = revokeInfo.operatorName || '用户';
        const originalSenderName = revokeInfo.origMsgSenderName || '用户';

        if (revokeInfo.isSelfOperate) {
          text = `${operatorName} 撤回了一条消息`;
        } else if (operatorName === originalSenderName) {
          text = `${operatorName} 撤回了一条消息`;
        } else {
          text = `${operatorName} 撤回了 ${originalSenderName} 的消息`;
        }
        if (revokeInfo.wording) text = revokeInfo.wording;
        summary = text;
      } else if (subType === 4 && grayTip.groupElement) {
        text = grayTip.groupElement.content || '群聊更新';
        summary = text;
      } else if (subType === 17 && grayTip.jsonGrayTipElement) {
        const jsonContent = grayTip.jsonGrayTipElement.jsonStr || '{}';
        try {
          const parsed = fastJsonParse(jsonContent);
          text = parsed.prompt || parsed.content || '系统提示';
        } catch {
          text = '系统提示';
        }
        summary = text;
      } else if (grayTip.aioOpGrayTipElement) {
        const aioOp = grayTip.aioOpGrayTipElement;
        if (aioOp.operateType === 1) {
          const fromUser = aioOp.peerName || '用户';
          const toUser = aioOp.targetName || '用户';
          text = `${fromUser} 拍了拍 ${toUser}`;
          if (aioOp.suffix) text += ` ${aioOp.suffix}`;
        } else {
          text = aioOp.content || '互动消息';
        }
        summary = text;
      } else {
        const content = grayTip.content || grayTip.text || grayTip.wording;
        if (content) {
          text = content;
          summary = content;
        } else {
          text = `系统提示 (类型: ${subType})`;
          summary = text;
        }
      }
    } catch (error) {
      console.warn('[SimpleMessageParser] 解析灰条消息失败:', error, grayTip);
      text = '系统消息';
      summary = text;
    }

    return {
      type: 'system',
      data: {
        subType,
        text,
        summary,
        originalData: grayTip
      }
    };
  }

  private getSystemMessageSummary(element: any): string {
    const t = element.elementType;
    switch (t) {
      case 8:  // ElementType.GreyTip
        return '系统提示消息';
      case 9:  // ElementType.WALLET
        return '钱包/红包消息';
      case 10: // ElementType.ARK
        return 'Ark卡片消息';
      case 11: // ElementType.MFACE
        return '商城表情';
      case 12: // ElementType.LIVEGIFT
        return '直播礼物';
      case 13: // ElementType.STRUCTLONGMSG
        return '长消息';
      case 14: // ElementType.MARKDOWN
        return 'Markdown消息';
      case 15: // ElementType.GIPHY
        return 'Giphy动图';
      case 16: // ElementType.MULTIFORWARD
        return '合并转发';
      case 17: // ElementType.INLINEKEYBOARD
        return '内联键盘';
      case 18: // ElementType.INTEXTGIFT
        return '文内礼物';
      case 19: // ElementType.CALENDAR
        return '日历';
      case 20: // ElementType.YOLOGAMERESULT
        return 'YOLO游戏结果';
      case 21: // ElementType.AVRECORD
        return '音视频通话记录';
      case 22: // ElementType.FEED
        return '动态';
      case 23: // ElementType.TOFURECORD
        return '豆腐记录';
      case 24: // ElementType.ACEBUBBLE
        return 'ACE气泡';
      case 25: // ElementType.ACTIVITY
        return '活动';
      case 26: // ElementType.TOFU
        return '豆腐';
      case 27: // ElementType.FACEBUBBLE
        return '表情气泡';
      case 28: // ElementType.SHARELOCATION
        return '位置分享';
      case 29: // ElementType.TASKTOPMSG
        return '置顶任务消息';
      case 43: // ElementType.RECOMMENDEDMSG
        return '推荐消息';
      case 44: // ElementType.ACTIONBAR
        return '操作栏';
      default:
        return `系统消息 (类型: ${t})`;
    }
  }

  /**
   * 初始化QQ表情映射表
   */
  private initializeFaceMap(): void {
    try {
      // ES模块中获取当前文件目录
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      
      const faceConfigPath = path.join(__dirname, 'face_config.json');
      if (fs.existsSync(faceConfigPath)) {
        const faceConfig = JSON.parse(fs.readFileSync(faceConfigPath, 'utf-8'));
        if (faceConfig.sysface && Array.isArray(faceConfig.sysface)) {
          for (const face of faceConfig.sysface) {
            if (face.QSid && face.QDes) {
              this.faceMap.set(face.QSid.toString(), face.QDes);
            }
          }
        }
      }
    } catch (error) {
      // 加载失败时静默失败，使用默认的"表情{ID}"格式
      console.warn('[SimpleMessageParser] 加载表情映射失败:', error);
    }
  }
}
