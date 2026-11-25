import { ENTITIES } from './entities.js';
import { MONEY } from './money.js';
import { SCHEDULE } from './schedule.js';
import { SYSTEM } from './records-of-system.js';

/**
 * What people write about every operation of the API, by `METHOD /path`.
 * The tests of the reference fail for a route without an entry here, and
 * for an entry without a route.
 */
export const OPERATIONS = { ...ENTITIES, ...MONEY, ...SCHEDULE, ...SYSTEM };
