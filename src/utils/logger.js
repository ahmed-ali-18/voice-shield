/**
 * VoiceShield — Logger
 * Thin wrapper around console.* that tags every line with its source module,
 * so the dashboard console stays readable once camera/vision/audio/vad are
 * all logging simultaneously at 30fps.
 */

const STYLE = "color:#7dd3fc;font-weight:600";

export function createLogger(moduleName) {
  const tag = `%c[VoiceShield:${moduleName}]`;

  return {
    info: (...args) => console.log(tag, STYLE, ...args),
    warn: (...args) => console.warn(tag, STYLE, ...args),
    error: (...args) => console.error(tag, STYLE, ...args),
    debug: (...args) => {
      if (self.__VOICESHIELD_DEBUG__) console.debug(tag, STYLE, ...args);
    },
  };
}
