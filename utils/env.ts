import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { ENV_KEYS } from './constants.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(repositoryRoot, '.env') });

function required(name: string, trim = true): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is missing from the repository .env file`);
  return trim ? value.trim() : value;
}

export function getKahuaCredentials(): { username: string; password: string } {
  return {
    username: required(ENV_KEYS.kahuaUsername),
    password: required(ENV_KEYS.kahuaPassword, false),
  };
}

export function getKahuaUsername(): string {
  return required(ENV_KEYS.kahuaUsername);
}

export function getCredentials(): { email: string; password: string } {
  return {
    email: required(ENV_KEYS.email),
    password: required(ENV_KEYS.password),
  };
}
