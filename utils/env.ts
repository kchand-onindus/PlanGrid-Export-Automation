import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { ENV_KEYS } from './constants.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(repositoryRoot, '.env') });

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is missing from the repository .env file`);
  return value;
}

export function getCredentials(): { email: string; password: string } {
  return {
    email: required(ENV_KEYS.email),
    password: required(ENV_KEYS.password),
  };
}
