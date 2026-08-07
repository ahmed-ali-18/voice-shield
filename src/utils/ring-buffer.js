/**
 * utils/ring-buffer.js — small fixed-capacity FIFO buffer. Used by
 * vision/speech-pattern-detector.js (lip-movement history) and
 * decision/av-sync-detector.js (paired lip/audio history) — pulled out
 * here since both need the same "keep the last N samples" behavior.
 */
export function createRingBuffer(capacity) {
  const values = [];
  return {
    push(value) {
      values.push(value);
      if (values.length > capacity) values.shift();
    },
    get values() {
      return values;
    },
    get length() {
      return values.length;
    },
    get isFull() {
      return values.length >= capacity;
    },
    clear() {
      values.length = 0;
    },
  };
}
