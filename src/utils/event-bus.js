/**
 * VoiceShield — Event Bus
 * A minimal pub/sub so camera/, vision/, audio/, vad/, and decision/ never
 * import each other directly. Each module only knows about the bus + constants.
 * This keeps the "single responsibility per module" rule enforceable.
 */

class EventBus extends EventTarget {
  emit(eventName, detail) {
    this.dispatchEvent(new CustomEvent(eventName, { detail }));
  }

  on(eventName, handler) {
    const listener = (event) => handler(event.detail);
    this.addEventListener(eventName, listener);
    return () => this.removeEventListener(eventName, listener); // unsubscribe fn
  }

  once(eventName, handler) {
    const listener = (event) => {
      handler(event.detail);
      this.removeEventListener(eventName, listener);
    };
    this.addEventListener(eventName, listener);
  }
}

// Singleton — every module imports this same instance.
export const eventBus = new EventBus();
