import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

export type LogLevel = 'GENERAL' | 'INFO' | 'DEBUG' | 'SUCCESS' | 'WARN' | 'ERROR';
export type LogContext = Record<string, unknown>;

function createLogFilePath(): string {
  const timestamp = new Date()
    .toISOString()
    .replace('T', '_')
    .replace(/:/g, '-')
    .replace('.', '-')
    .replace('Z', '');

  return path.join(paths.logRoot, `export-${timestamp}.log`);
}

const logFilePath = createLogFilePath();
const loggedErrors = new WeakSet<object>();
fs.mkdirSync(path.dirname(logFilePath), { recursive: true });

function formatContext(context?: LogContext): string {
  if (!context || Object.keys(context).length === 0) return '';

  return Object.entries(context)
    .map(([key, value]) => {
      let formattedValue: string;

      try {
        formattedValue = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      } catch {
        formattedValue = '[unserializable]';
      }

      const indentedValue = (formattedValue ?? 'undefined').replace(/\n/g, '\n  ');
      return `\n  ${key}: ${indentedValue}`;
    })
    .join('');
}

function write(level: LogLevel, message: string, context?: LogContext): void {
  const line = `${new Date().toISOString()} [${level}] ${message}${formatContext(context)}`;
  const output = level === 'ERROR' || level === 'WARN' ? console.error : console.log;

  output(line);
  try {
    fs.appendFileSync(logFilePath, `${line}\n`, 'utf8');
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    console.error(`[LOGGER_ERROR] Could not write to ${logFilePath}: ${details}`);
  }
}

export const logger = {
  general(message: string, context?: LogContext): void {
    write('GENERAL', message, context);
  },

  info(message: string, context?: LogContext): void {
    write('INFO', message, context);
  },

  debug(message: string, context?: LogContext): void {
    write('DEBUG', message, context);
  },

  success(message: string, context?: LogContext): void {
    write('SUCCESS', message, context);
  },

  warn(message: string, context?: LogContext): void {
    write('WARN', message, context);
  },

  error(message: string, context?: LogContext): void {
    write('ERROR', message, context);
  },
};

// Backwards-compatible helpers for the existing workflow modules.
export function log(message: string, context?: LogContext): void {
  logger.info(message, context);
}

export function logError(message: string, error?: unknown, context?: LogContext): void {
  const errorDetails =
    error instanceof Error
      ? { error: error.message, stack: error.stack }
      : error === undefined
        ? undefined
        : { error: String(error) };

  logger.error(message, { ...context, ...errorDetails });

  if (error && (typeof error === 'object' || typeof error === 'function')) {
    loggedErrors.add(error);
  }
}

export function wasErrorLogged(error: unknown): boolean {
  return Boolean(error && (typeof error === 'object' || typeof error === 'function') && loggedErrors.has(error));
}

export { logFilePath };
