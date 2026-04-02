// MODULE: logger
// PURPOSE: Leveled, color-coded console logger with in-memory history for dev panel
// DEPENDS ON: nothing

const MAX_HISTORY = 1000;
const history = [];
let currentLevel = 'debug'; // debug < info < warn < error

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

const COLORS = {
  debug: 'color:#888; font-weight:normal',
  info:  'color:#4A9EFF; font-weight:bold',
  warn:  'color:#FFD700; font-weight:bold',
  error: 'color:#FF4444; font-weight:bold',
};

const MODULE_COLORS = [
  '#B57BFF','#00FF88','#4A9EFF','#FF8C00','#FF6B9D',
  '#00CCFF','#AAFFAA','#FFB347','#C8A2C8','#87CEEB',
];
const moduleColorMap = new Map();
let colorIdx = 0;

function getModuleColor(mod) {
  if (!moduleColorMap.has(mod)) {
    moduleColorMap.set(mod, MODULE_COLORS[colorIdx % MODULE_COLORS.length]);
    colorIdx++;
  }
  return moduleColorMap.get(mod);
}

function addToHistory(entry) {
  history.push(entry);
  if (history.length > MAX_HISTORY) history.shift();
}

function shouldLog(level) {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function log(moduleName, level, message, data) {
  if (!shouldLog(level)) return;

  const ts = new Date().toISOString();
  const entry = { ts, level, module: moduleName, message, data };
  addToHistory(entry);

  const modColor = getModuleColor(moduleName);
  const prefix = `%c[${level.toUpperCase()}]%c [${moduleName}]%c`;
  const levelStyle = COLORS[level];
  const modStyle = `color:${modColor}; font-weight:bold`;
  const resetStyle = 'color:inherit; font-weight:normal';

  if (data !== undefined) {
    console[level === 'debug' ? 'log' : level](prefix, levelStyle, modStyle, resetStyle, message, data);
  } else {
    console[level === 'debug' ? 'log' : level](prefix, levelStyle, modStyle, resetStyle, message);
  }
}

/**
 * Create a scoped logger for a module
 * @param {string} moduleName - Name displayed in log output
 * @returns {{ debug, info, warn, error, getHistory, clearHistory, setLevel }}
 */
export function createLogger(moduleName) {
  return {
    debug: (msg, data) => log(moduleName, 'debug', msg, data),
    info:  (msg, data) => log(moduleName, 'info',  msg, data),
    warn:  (msg, data) => log(moduleName, 'warn',  msg, data),
    error: (msg, data) => log(moduleName, 'error', msg, data),
  };
}

/** Returns a frozen copy of the last MAX_HISTORY log entries */
export function getHistory() {
  return [...history];
}

/** Clears all log history */
export function clearHistory() {
  history.length = 0;
}

/**
 * Set the minimum log level globally
 * @param {'debug'|'info'|'warn'|'error'} level
 */
export function setLevel(level) {
  if (LEVELS[level] === undefined) throw new Error(`Invalid level: ${level}`);
  currentLevel = level;
}

/** Returns current minimum log level */
export function getLevel() {
  return currentLevel;
}
