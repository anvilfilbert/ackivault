/** Strict decoding for the isolated, full-replace, no-callback contracts in this console. */
type Cursor = { data: Buffer; offset: number };
type Part = { bytes: Buffer; next: Cursor };
type NumberPart = { value: number; next: Cursor };
export type Field = { name: string; kind: number; bytes: Buffer };
export type Event = { name: string; eventClass: bigint; fields: Field[] };
export type Output = { statusCode: number; state: string | null; outboundCount: number; events: Event[] };

export class FrameError extends Error {
  constructor(message: string) { super(message); this.name = "FrameError"; }
}

function take(cursor: Cursor, length: number): Part {
  if (length < 0 || cursor.offset + length > cursor.data.length) throw new FrameError(`Truncated ACMO frame at byte ${cursor.offset}; need ${length} bytes`);
  return { bytes: cursor.data.subarray(cursor.offset, cursor.offset + length), next: { data: cursor.data, offset: cursor.offset + length } };
}
function u32(cursor: Cursor): NumberPart { const part = take(cursor, 4); return { value: part.bytes.readUInt32LE(0), next: part.next }; }
function u16(cursor: Cursor): NumberPart { const part = take(cursor, 2); return { value: part.bytes.readUInt16LE(0), next: part.next }; }
function name(cursor: Cursor): { value: string; next: Cursor } {
  const length = u16(cursor);
  if (length.value === 0 || length.value > 128) throw new FrameError("ACMO name length is outside the supported range");
  const part = take(length.next, length.value);
  const value = part.bytes.toString("utf8");
  if (!/^[a-z][a-z0-9_.]*$/.test(value)) throw new FrameError("ACMO name is not canonical ASCII");
  return { value, next: part.next };
}
function finish(cursor: Cursor): void {
  if (cursor.offset !== cursor.data.length) throw new FrameError(`ACMO has ${cursor.data.length - cursor.offset} trailing bytes`);
}

function fields(data: Buffer): Field[] {
  let cursor: Cursor = { data, offset: 0 };
  const count = u16(cursor); cursor = count.next;
  const reserved = u16(cursor); cursor = reserved.next;
  if (count.value > 4 || reserved.value !== 0) throw new FrameError("ACMO event field count or reserved bits are invalid");
  const decoded: Field[] = [];
  for (let index = 0; index < count.value; index++) {
    const length = u16(cursor); cursor = length.next;
    const kind = take(cursor, 1); cursor = kind.next;
    const valueLength = u16(cursor); cursor = valueLength.next;
    const fieldName = take(cursor, length.value); cursor = fieldName.next;
    const value = take(cursor, valueLength.value); cursor = value.next;
    const expected = kind.bytes[0] === 2 ? 8 : kind.bytes[0] === 4 ? 16 : kind.bytes[0] === 8 ? 64 : -1;
    const key = fieldName.bytes.toString("utf8");
    if (!/^[a-z][a-z0-9_]*$/.test(key) || valueLength.value !== expected ||
        (decoded.length > 0 && decoded[decoded.length - 1]!.name >= key)) throw new FrameError("ACMO event fields have an invalid kind, length or order");
    decoded.push({ name: key, kind: kind.bytes[0]!, bytes: value.bytes });
  }
  finish(cursor);
  return decoded;
}

function outbound(cursor: Cursor): Cursor {
  const index = u32(cursor);
  const destination = take(index.next, 64);
  const main = take(destination.next, 16);
  const reserve = take(main.next, 16);
  const extras = u16(reserve.next);
  const currency = u32(extras.next);
  const amount = take(currency.next, 16);
  const method = take(amount.next, 8);
  const body = u32(method.next);
  if (index.value !== 0 || extras.value !== 1 || currency.value !== 2 || body.value !== 0 ||
      main.bytes.some((byte: number): boolean => byte !== 0) ||
      destination.bytes.subarray(0, 32).every((byte: number): boolean => byte === 0) ||
      destination.bytes.subarray(32).every((byte: number): boolean => byte === 0) ||
      amount.bytes.every((byte: number): boolean => byte === 0) || method.bytes.readBigUInt64LE(0) === 0n) {
    throw new FrameError("ACMO outbound intent violates this console's SHELL transfer shape");
  }
  return body.next;
}

export function decodeOutput(data: Buffer): Output {
  let cursor: Cursor = { data, offset: 0 };
  const magic = take(cursor, 4); cursor = magic.next;
  if (magic.bytes.toString("ascii") !== "ACMO") throw new FrameError("Executor output must have the ACMO header");
  const status = u32(cursor); cursor = status.next;
  const flags = take(cursor, 1); cursor = flags.next;
  const success = status.value === 0;
  if (flags.bytes[0] !== (success ? 1 : 0)) throw new FrameError("ACMO flags do not match the required success or effect-free rejection shape");
  let state: string | null = null;
  if (success) {
    const mode = u32(cursor); cursor = mode.next;
    const length = u32(cursor); cursor = length.next;
    if (mode.value !== 0 || ![24, 473].includes(length.value)) throw new FrameError("ACMO state must be a complete supported full replacement");
    const value = take(cursor, length.value); cursor = value.next; state = value.bytes.toString("hex");
  }
  const resultLength = u32(cursor); cursor = resultLength.next;
  if (resultLength.value !== 0) throw new FrameError("These contracts do not return callback bodies");
  const outbounds = u32(cursor); cursor = outbounds.next;
  if (outbounds.value > 1 || (!success && outbounds.value !== 0)) throw new FrameError("ACMO outbound count is invalid");
  if (outbounds.value === 1) cursor = outbound(cursor);
  const callbacks = u32(cursor); cursor = callbacks.next;
  if (callbacks.value !== 0) throw new FrameError("These contracts do not emit callback intents");
  const eventCount = u32(cursor); cursor = eventCount.next;
  if (eventCount.value > 1 || (!success && eventCount.value !== 0)) throw new FrameError("ACMO event count is invalid");
  const events: Event[] = [];
  for (let index = 0; index < eventCount.value; index++) {
    const inputIndex = u32(cursor); cursor = inputIndex.next;
    const kind = take(cursor, 1); cursor = kind.next;
    const eventClass = take(cursor, 8); cursor = eventClass.next;
    const eventName = name(cursor); cursor = eventName.next;
    const topics = u16(cursor); cursor = topics.next;
    const fieldsLength = u32(cursor); cursor = fieldsLength.next;
    if (inputIndex.value !== 0 || kind.bytes[0] !== 0 || topics.value !== 0 || fieldsLength.value > 4096 || eventClass.bytes.readBigUInt64LE(0) === 0n) throw new FrameError("ACMO event metadata is invalid");
    const fieldBytes = take(cursor, fieldsLength.value); cursor = fieldBytes.next;
    events.push({ name: eventName.value, eventClass: eventClass.bytes.readBigUInt64LE(0), fields: fields(fieldBytes.bytes) });
  }
  finish(cursor);
  return { statusCode: status.value, state, outboundCount: outbounds.value, events };
}
