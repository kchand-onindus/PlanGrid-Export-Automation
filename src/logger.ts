import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

export type LogLevel = 'GENERAL' | 'INFO' | 'DEBUG' | 'SUCCESS' | 'WARN' | 'ERROR';
export type LogContext = Record<string, unknown>;

function createLogFilePath(prefix: string): string {
  const timestamp = new Date()
    .toISOString()
    .replace('T', '_')
    .replace(/:/g, '-')
    .replace('.', '-')
    .replace('Z', '');

  return path.join(paths.logRoot, `${prefix}-${timestamp}.log`);
}

const loggedErrors = new WeakSet<object>();

function formatContext(context?: LogContext): string {
  if (!context || Object.keys(context).length === 0) return '';

  return Object.entries(context)
    .map(([key, value]) => {
      let formattedValue: string;

      try {
        formattedValue = typeof value === 'string' && key !== 'projectName'
          ? value : JSON.stringify(value, null, 2);
      } catch {
        formattedValue = '[unserializable]';
      }

      const indentedValue = (formattedValue ?? 'undefined').replace(/\n/g, '\n  ');
      return `\n  ${key}: ${indentedValue}`;
    })
    .join('');
}

function write(logFilePath: string, level: LogLevel, message: string, context?: LogContext): void {
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

export function createLogger(prefix: string) {
  const logFilePath = createLogFilePath(prefix);
  fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
  const logger = {
    general(message: string, context?: LogContext): void {
      write(logFilePath, 'GENERAL', message, context);
    },

    info(message: string, context?: LogContext): void {
      write(logFilePath, 'INFO', message, context);
    },

    debug(message: string, context?: LogContext): void {
      write(logFilePath, 'DEBUG', message, context);
    },

    success(message: string, context?: LogContext): void {
      write(logFilePath, 'SUCCESS', message, context);
    },

    warn(message: string, context?: LogContext): void {
      write(logFilePath, 'WARN', message, context);
    },

    error(message: string, context?: LogContext): void {
      write(logFilePath, 'ERROR', message, context);
    },
  };
  return { logger, logFilePath };
}
export type Logger = ReturnType<typeof createLogger>['logger'];
export const { logger, logFilePath } = createLogger('export');

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
