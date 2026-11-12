// 朋友圈投递报文：与小鱼（waaakong/xiaoyu）的原生组件逐字节一致。
// 结构：44 字节头（魔数 + 请求标识 + 长度）+ protobuf 外壳 + TimelineObject XML。
// 这里只负责“把正文编码成可被原生组件接受的那一包”，不负责注入进程、不负责发布。
import crypto from 'node:crypto';

/**
 * 原生组件的函数地址是按“精确构建”写死的，换版本必须换一整套常量。
 * 这里登记每一份已核对过的核心，以及它离“能发”还差什么：
 *   nativeReady=true  常量齐全、组件可加载、可投递
 *   nativeReady=false 常量还在推导，组件会被自己的 exact_build 拒绝（安全，不会乱发）
 * 绝不因为“版本差不多”就复用另一份核心的地址。
 */
export const SUPPORTED_CORES = Object.freeze([
  Object.freeze({
    wechatVersion: '4.2.0.13',
    coreSha256: 'afe3d02c58bada3c35009c0cd58ee1f57b2a00fe53237d0dce649107fddb9a20',
    component: 'XiaoyuMoments-1',
    nativeReady: true,
    note: '小鱼官方适配的核心，常量齐全。',
  }),
  Object.freeze({
    wechatVersion: '4.1.10.27',
    coreSha256: 'f487e4f56930456a25fb0d7b058c77e2dcd364e268d49bdfff4dc0e3be26ba36',
    component: 'XiaoyuMoments-1',
    nativeReady: true,
    found: ['POST_VTABLE', 'POST_CTOR', 'POST_INFO', 'ALLOCATE', 'FREE', 'TASK_SIZE', 'REQ_OFFSET', 'RES_OFFSET',
      'MESSAGE_CTOR', 'MESSAGE_VTABLE', 'HOLDER_CTOR', 'FACTORY', 'SEND_WRAPPER', 'PROTO_FILL', 'ROOT_GLOBAL',
      'ROOT_VTABLE', 'MANAGER_VTABLE', 'MANAGER_DISPATCH', 'HOLDER_DATA', 'HOLDER_SIZE', 'COMPLETION_FN'],
    missing: [],
    note: 'wechatwb 内置微信（Hook 版）。21 项常量齐全，2026-11-11 实测 ret=0 并返回 objectId。关键：报文的 username 必须是当前登录账号（xwechat_files 最近活跃目录），XML 字段结构也要与真实客户端一致。',
  }),
]);

/** 兼容旧调用：默认取第一份“可用”的核心。 */
export const SUPPORTED_CORE = SUPPORTED_CORES.find(item => item.nativeReady) ?? SUPPORTED_CORES[0];

/** 按 sha256 找登记项。 */
export function coreFor(sha256) {
  return SUPPORTED_CORES.find(item => item.coreSha256 === sha256) ?? null;
}

/** 投递报文魔数（小端读出即 'XYM1'）：发朋友圈。 */
export const MAGIC_POST = 0x314d5958;
/** 只读对象魔数：按 objectId 回读一条已发布的朋友圈，用于核对真实内容。 */
export const MAGIC_DETAIL = 0x334d5958;

export const MAX_TEXT = 2000;
export const MAX_PACKET = 32044;

export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

/* 控制字符与孤立代理项在微信侧会被截断或乱码，宁可直接拒绝。 */
const BAD_TEXT = /[\u0000-\u0008\u000b-\u001f\ufffe\uffff]/u;
const SURROGATE = /\p{Surrogate}/u;
const WXID = /^wxid_[A-Za-z0-9_]{1,100}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

const escapeXml = value => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&apos;');

/** protobuf varint：64 位以内安全编码，不经过 JS Number 以免丢精度。 */
function uint(value) {
  let rest = BigInt(value);
  if (rest < 0n || rest > 0xffffffffffffffffn) throw new Error('整数超出范围');
  const out = [];
  do {
    let byte = Number(rest & 127n);
    rest >>= 7n;
    out.push(byte | (rest ? 128 : 0));
  } while (rest);
  return Buffer.from(out);
}

const fieldVarint = (key, value) => Buffer.concat([uint(key * 8), uint(value)]);
const fieldBytes = (key, value) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return Buffer.concat([uint(key * 8 + 2), uint(bytes.length), bytes]);
};

/** 校验一条正文是否可以进入朋友圈报文；返回清理后的正文。 */
export function normalizeText(text) {
  if (typeof text !== 'string') throw new Error('正文必须是字符串');
  const value = text.trim();
  if (!value) throw new Error('正文不能为空');
  if (value.length > MAX_TEXT) throw new Error(`正文超过 ${MAX_TEXT} 字`);
  if (BAD_TEXT.test(value)) throw new Error('正文含控制字符，微信会截断');
  if (SURROGATE.test(value)) throw new Error('正文含损坏的表情字符');
  return value;
}

/**
 * TimelineObject：微信朋友圈服务端真正解析的那段 XML。
 * contentStyle=2 表示纯文字，private=0 表示公开（当前只开放公开文字）。
 */
export function buildTimeline({account, text, created}) {
  // 字段顺序与真实客户端一致（实测抓包：没有 contentattr，多了 DescShowType/Scene 与若干占位节点）
  return '<TimelineObject>'
    + '<id>0</id>'
    + `<username>${escapeXml(account)}</username>`
    + `<createTime>${created}</createTime>`
    + `<contentDesc>${escapeXml(text)}</contentDesc>`
    + '<contentDescShowType>0</contentDescShowType>'
    + '<contentDescScene>0</contentDescScene>'
    + '<private>0</private>'
    + '<sourceUserName></sourceUserName>'
    + '<sourceNickName></sourceNickName>'
    + '<sightFolded>0</sightFolded>'
    + '<showFlag>0</showFlag>'
    + '<ContentObject><contentStyle>2</contentStyle><title></title><description></description>'
    + '<mediaList></mediaList><contentUrl></contentUrl></ContentObject>'
    + '<appInfo><id></id></appInfo>'
    + '<actionInfo><appMsg><messageAction></messageAction></appMsg></actionInfo>'
    + '<location poiClassifyId="" poiName="" poiAddress="" poiClassifyType="0" city=""></location>'
    + '<publicUserName></publicUserName>'
    + '</TimelineObject>';
}

/**
 * 组装 mmsnspost 的提交报文。
 * 外层字段与小鱼一致：1=设备信息、2=正文缓冲、7=请求标识，其余保留位固定 0。
 */
export function buildPostPacket({account, text, visibility = 'public', requestId = crypto.randomUUID(), created} = {}) {
  if (!WXID.test(account ?? '')) throw new Error('账号必须是 wxid_ 开头的微信号');
  if (visibility !== 'public') throw new Error('当前只开放公开文字，其他可见范围未验证');
  if (!UUID.test(requestId)) throw new Error('请求标识格式无效');
  const stamp = created ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(stamp) || stamp < 1 || stamp > 0xffffffff) throw new Error('发布时间无效');

  const value = normalizeText(text);
  const timeline = buildTimeline({account, text: value, created: stamp});

  // 正文缓冲：1=XML 长度，2=XML 本体
  const body = Buffer.concat([fieldVarint(1, Buffer.byteLength(timeline)), fieldBytes(2, timeline)]);
  // 设备信息：客户端类型/平台，保持 Windows 原样
  const base = Buffer.concat([fieldBytes(1, ''), fieldVarint(2, 0), fieldBytes(3, 'Windows'),
    fieldVarint(4, 0), fieldBytes(5, 'Windows'), fieldVarint(6, 0)]);
  const proto = Buffer.concat([
    fieldBytes(1, base), fieldBytes(2, body),
    fieldVarint(3, 0), fieldVarint(5, 0), fieldVarint(6, 0), fieldBytes(7, requestId),
    fieldVarint(8, 0), fieldVarint(9, 0), fieldVarint(11, 0), fieldVarint(13, 0), fieldVarint(16, 0),
  ]);

  const header = Buffer.alloc(44);
  header.writeUInt32LE(MAGIC_POST, 0);
  header.write(requestId, 4, 36, 'ascii');
  header.writeUInt32LE(proto.length, 40);

  const packet = Buffer.concat([header, proto]);
  if (packet.length > MAX_PACKET) throw new Error('报文过大');
  return {packet, requestId, timeline, created: stamp, account, text: value, visibility, sha256: sha256(packet)};
}

/** 只读对象报文：按 objectId 回读一条已发布的朋友圈，用于核对真实落地内容。 */
export function buildDetailPacket({account, objectId, requestId = crypto.randomUUID()} = {}) {
  if (!WXID.test(account ?? '')) throw new Error('账号无效');
  if (typeof objectId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(objectId)) throw new Error('objectId 无效');
  if (BigInt(objectId) > 0xffffffffffffffffn) throw new Error('objectId 越界');
  if (!UUID.test(requestId)) throw new Error('请求标识格式无效');

  const base = Buffer.concat([fieldBytes(1, ''), fieldVarint(2, 0), fieldBytes(3, 'Windows'),
    fieldVarint(4, 0), fieldBytes(5, 'Windows'), fieldVarint(6, 0)]);
  const proto = Buffer.concat([fieldBytes(1, base), fieldVarint(2, BigInt(objectId)), fieldVarint(3, 0)]);
  const header = Buffer.alloc(44);
  header.writeUInt32LE(MAGIC_DETAIL, 0);
  header.write(requestId, 4, 36, 'ascii');
  header.writeUInt32LE(proto.length, 40);
  return {packet: Buffer.concat([header, proto]), account, objectId, requestId};
}

/** 有界 protobuf 读取：朋友圈 ID 是 64 位，绝不能经过 Number 取整。 */
export function readProto(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 65536) throw new Error('响应过大');
  let at = 0;
  const fields = [];
  const variable = () => {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (at >= buffer.length) throw new Error('响应被截断');
      const byte = buffer[at++];
      if (i === 9 && byte > 1) throw new Error('响应整数溢出');
      value |= BigInt(byte & 127) << (BigInt(i) * 7n);
      if (!(byte & 128)) return value;
    }
    throw new Error('响应整数无效');
  };
  while (at < buffer.length) {
    const tag = variable();
    const key = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (!key || key > 0x1fffffff) throw new Error('响应字段无效');
    let value;
    if (wire === 0) value = variable();
    else if (wire === 2) {
      const size = variable();
      if (size > BigInt(buffer.length - at)) throw new Error('响应长度无效');
      value = buffer.subarray(at, at + Number(size));
      at += Number(size);
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (at + size > buffer.length) throw new Error('响应被截断');
      value = buffer.subarray(at, at + size);
      at += size;
    } else throw new Error('响应编码无效');
    fields.push({key, wire, value});
  }
  return fields;
}

/** 解析 BaseResponse：ret=0 且带 SnsObject.id 才算服务端受理。 */
export function parseResponse(buffer) {
  const fields = readProto(buffer);
  const base = fields.find(item => item.key === 1 && item.wire === 2);
  const object = fields.find(item => item.key === 2 && item.wire === 2);
  const ret = base && readProto(base.value).find(item => item.key === 1 && item.wire === 0)?.value;
  const objectId = object && readProto(object.value).find(item => item.key === 1 && item.wire === 0)?.value;
  if (ret === undefined) throw new Error('缺少服务端返回码');
  const code = Number(BigInt.asIntN(32, ret));
  return {ret: code, objectId: objectId?.toString() ?? null, accepted: code === 0 && objectId !== undefined && objectId > 0n};
}

/** 解析只读对象：取出 username 与 TimelineObject，用来核对“发出去的”和“线上真实内容”是否一致。 */
export function parseObject(buffer) {
  const result = parseResponse(buffer);
  if (!result.accepted) throw new Error('对象查询未成功');
  const object = readProto(buffer).find(item => item.key === 2 && item.wire === 2);
  const fields = readProto(object.value);
  const username = fields.find(item => item.key === 2 && item.wire === 2)?.value.toString('utf8') ?? '';
  const description = fields.find(item => item.key === 5 && item.wire === 2);
  let timeline = '';
  if (description) {
    const inner = readProto(description.value);
    const bytes = inner.find(item => item.key === 2 && item.wire === 2)?.value;
    const size = inner.find(item => item.key === 1 && item.wire === 0)?.value;
    if (bytes && size === BigInt(bytes.length)) timeline = bytes.toString('utf8');
  }
  return {...result, username, timeline};
}

/** 从回读的 TimelineObject 里取出正文，做一次解转义。 */
export function timelineText(timeline) {
  const match = /<contentDesc>([\s\S]*?)<\/contentDesc>/u.exec(timeline ?? '');
  const raw = match?.[1];
  if (raw === undefined) return '';
  if (raw.startsWith('<![CDATA[') && raw.endsWith(']]>')) return raw.slice(9, -3);
  return raw.replace(/&lt;|&gt;|&quot;|&apos;|&amp;/gu, item => ({'&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&'}[item]));
}

/** 报文自检：返回 null 表示通过，否则返回具体问题。加载组件前先跑这一条。 */
export function selfCheck(packet, {account, text, requestId} = {}) {
  try {
    if (!Buffer.isBuffer(packet) || packet.length < 44 || packet.length > MAX_PACKET) return '报文长度异常';
    const magic = packet.readUInt32LE(0);
    const id = packet.subarray(4, 40).toString('ascii');
    const size = packet.readUInt32LE(40);
    if (magic !== MAGIC_POST && magic !== MAGIC_DETAIL) return '魔数不是朋友圈报文';
    if (size !== packet.length - 44) return '头部长度与实际不符';
    if (requestId && id !== requestId) return '请求标识不一致';
    const fields = readProto(packet.subarray(44));
    const keys = fields.map(item => item.key).sort((a, b) => a - b).join(',');
    if (magic === MAGIC_DETAIL) {
      if (keys !== '1,2,3') return '只读报文结构不符';
      return null;
    }
    if (keys !== '1,2,3,5,6,7,8,9,11,13,16') return '投递报文字段不符：' + keys;
    if (fields.some(item => [3, 5, 6, 8, 9, 11, 13, 16].includes(item.key) && item.value !== 0n)) return '保留位不为 0';
    const buffer = readProto(fields.find(item => item.key === 2).value);
    const xml = buffer.find(item => item.key === 2)?.value?.toString('utf8') ?? '';
    if (!xml.startsWith('<TimelineObject>')) return '缺少 TimelineObject';
    if (account && !xml.includes(`<username>${account}</username>`)) return '账号与报文不一致';
    if (text && timelineText(xml) !== text) return '正文与报文不一致';
    if (!xml.includes('<private>0</private>')) return '可见范围不是公开';
    if (/<mediaList>.+<\/mediaList>/u.test(xml)) return '报文含图片/视频，当前不支持';
    return null;
  } catch (error) {
    return error.message;
  }
}
