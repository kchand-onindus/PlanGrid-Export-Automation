import '../../utils/env.js';
import { ENV_KEYS, URLS } from '../../utils/constants.js';

export const kahuaUrl = process.env[ENV_KEYS.kahuaUrl]?.trim() || URLS.kahuaLanding;
