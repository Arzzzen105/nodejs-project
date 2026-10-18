import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export class DatabaseError extends Error {
    constructor(message, status = 500, code = 'INTERNAL_ERROR') {
        super(message);
        this.name = 'DatabaseError';
        this.status = status;
        this.code = code;
    }
}

const COLLECTION_NAME = /^[a-z][a-z0-9_-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createUuidV7() {
    const bytes = randomBytes(16);
    let timestamp = BigInt(Date.now());

    for (let index = 5; index >= 0; index -= 1) {
        bytes[index] = Number(timestamp & 0xffn);
        timestamp >>= 8n;
    }

    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function valueKey(value) {
    return JSON.stringify(value);
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateConfig(name, config) {
    if (!COLLECTION_NAME.test(name)) {
        throw new DatabaseError(`Invalid collection name: ${name}`, 500, 'INVALID_CONFIG');
    }
    if (!isPlainObject(config) || config.table !== name || config.primaryKey !== 'id') {
        throw new DatabaseError(`Invalid config for collection "${name}".`, 500, 'INVALID_CONFIG');
    }
    if (!isPlainObject(config.columns) || !Array.isArray(config.indexes)) {
        throw new DatabaseError(`Config for "${name}" must define columns and indexes.`, 500, 'INVALID_CONFIG');
    }
    for (const [column, definition] of Object.entries(config.columns)) {
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(column) || !isPlainObject(definition)) {
            throw new DatabaseError(`Invalid column definition in "${name}".`, 500, 'INVALID_CONFIG');
        }
        if (!['string', 'number', 'integer', 'boolean', 'object', 'array'].includes(definition.type)) {
            throw new DatabaseError(`Invalid type for "${name}.${column}".`, 500, 'INVALID_CONFIG');
        }
    }
    if (Object.hasOwn(config.columns, 'id')) {
        throw new DatabaseError(`The primary key "id" is managed by the file database.`, 500, 'INVALID_CONFIG');
    }
    for (const index of config.indexes) {
        if (typeof index !== 'string' || !hasOwn(config.columns, index) ||
            ['object', 'array'].includes(config.columns[index]?.type)) {
            throw new DatabaseError(`Invalid index in collection "${name}".`, 500, 'INVALID_CONFIG');
        }
    }
}

function validateField(collection, field, value, definition) {
    if (value === null && definition.nullable) return;
    const valid = {
        string: typeof value === 'string',
        number: typeof value === 'number' && Number.isFinite(value),
        integer: Number.isSafeInteger(value),
        boolean: typeof value === 'boolean',
        object: isPlainObject(value),
        array: Array.isArray(value),
    }[definition.type];
    if (!valid) {
        throw new DatabaseError(`"${field}" must be ${definition.type}.`, 422, 'VALIDATION_ERROR');
    }
    if (typeof value === 'number' && definition.min !== undefined && value < definition.min) {
        throw new DatabaseError(`"${field}" must be at least ${definition.min}.`, 422, 'VALIDATION_ERROR');
    }
    if (typeof value === 'number' && definition.max !== undefined && value > definition.max) {
        throw new DatabaseError(`"${field}" must be at most ${definition.max}.`, 422, 'VALIDATION_ERROR');
    }
    if (typeof value === 'string' && definition.minLength !== undefined && value.length < definition.minLength) {
        throw new DatabaseError(`"${field}" is too short.`, 422, 'VALIDATION_ERROR');
    }
    if (typeof value === 'string' && definition.maxLength !== undefined && value.length > definition.maxLength) {
        throw new DatabaseError(`"${field}" is too long.`, 422, 'VALIDATION_ERROR');
    }
    if (definition.enum && !definition.enum.some((choice) => Object.is(choice, value))) {
        throw new DatabaseError(`"${field}" must be one of the configured values.`, 422, 'VALIDATION_ERROR');
    }
    if (definition.pattern && typeof value === 'string' && !new RegExp(definition.pattern).test(value)) {
        throw new DatabaseError(`"${field}" has an invalid format.`, 422, 'VALIDATION_ERROR');
    }
}

export class FileDatabase {
    #root;
    #collections = new Map();
    #locks = new Map();
    #initialized = false;

    constructor(root = process.env.DATABASE_DIR ?? path.resolve(process.cwd(), 'database')) {
        this.#root = path.resolve(root);
    }

    async init() {
        await fs.mkdir(this.#root, { recursive: true });
        const entries = await fs.readdir(this.#root, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const name = entry.name;
            if (!COLLECTION_NAME.test(name)) continue;

            const directory = path.join(this.#root, name);
            let config;
            try {
                config = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'));
            } catch (error) {
                if (error.code === 'ENOENT') continue;
                throw new DatabaseError(`Cannot read config for "${name}": ${error.message}`, 500, 'INVALID_CONFIG');
            }
            validateConfig(name, config);
            const collection = { name, directory, config, records: new Set(), indexes: new Map() };
            for (const field of config.indexes) collection.indexes.set(field, new Map());

            const files = await fs.readdir(directory, { withFileTypes: true });
            for (const file of files) {
                if (!file.isFile() || !UUID.test(file.name.replace(/\.json$/, '')) || !file.name.endsWith('.json')) continue;
                const id = file.name.slice(0, -5);
                let record;
                try {
                    record = JSON.parse(await fs.readFile(path.join(directory, file.name), 'utf8'));
                } catch (error) {
                    throw new DatabaseError(`Cannot read ${name}/${file.name}: ${error.message}`, 500, 'CORRUPT_RECORD');
                }
                if (!isPlainObject(record) || record.id !== id) {
                    throw new DatabaseError(`Record ${name}/${file.name} has an invalid id.`, 500, 'CORRUPT_RECORD');
                }
                collection.records.add(id);
                this.#indexRecord(collection, record);
            }
            this.#collections.set(name, collection);
        }
        this.#initialized = true;
        return this;
    }

    collections() {
        this.#assertInitialized();
        return [...this.#collections.keys()];
    }

    schema(name) {
        return structuredClone(this.#collection(name).config);
    }

    async create(name, input) {
        const collection = this.#collection(name);
        if (!isPlainObject(input)) throw new DatabaseError('The request body must be a JSON object.', 400, 'INVALID_BODY');
        if (hasOwn(input, 'id')) throw new DatabaseError('The "id" field is generated by the server.', 422, 'VALIDATION_ERROR');
        const record = this.#normalize(collection, input, true);
        record.id = createUuidV7();
        const filePath = this.#recordPath(collection, record.id);
        await this.#atomicWrite(filePath, record);
        collection.records.add(record.id);
        this.#indexRecord(collection, record);
        return structuredClone(record);
    }

    async get(name, id) {
        const collection = this.#collection(name);
        this.#validateId(id);
        if (!collection.records.has(id)) throw new DatabaseError('Record not found.', 404, 'NOT_FOUND');
        return structuredClone(await this.#readRecord(collection, id));
    }

    async list(name, { where = {}, limit = 100, offset = 0 } = {}) {
        const collection = this.#collection(name);
        if (!isPlainObject(where)) throw new DatabaseError('"where" must be a JSON object.', 400, 'INVALID_QUERY');
        if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0) {
            throw new DatabaseError('"limit" must be 1–500 and "offset" must be zero or greater.', 400, 'INVALID_QUERY');
        }
        for (const [field, value] of Object.entries(where)) {
            if (!hasOwn(collection.config.columns, field)) {
                throw new DatabaseError(`Unknown filter field "${field}".`, 400, 'INVALID_QUERY');
            }
            validateField(name, field, value, collection.config.columns[field]);
        }

        let candidates = null;
        for (const [field, value] of Object.entries(where)) {
            const index = collection.indexes.get(field);
            if (!index) continue;
            const matches = index.get(valueKey(value)) ?? new Set();
            if (candidates === null || matches.size < candidates.size) candidates = matches;
        }
        const source = candidates === null ? collection.records : candidates;
        const records = [];
        for (const id of source) {
            const record = await this.#readRecord(collection, id);
            if (Object.entries(where).every(([field, value]) => isDeepStrictEqual(record[field], value))) records.push(record);
        }
        // UUIDv7 starts with its creation timestamp, so lexical ID order is chronological.
        records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        return { items: records.slice(offset, offset + limit).map((record) => ({ ...record })), total: records.length, limit, offset };
    }

    async update(name, id, changes, { replace = false } = {}) {
        const collection = this.#collection(name);
        this.#validateId(id);
        if (!isPlainObject(changes)) throw new DatabaseError('The request body must be a JSON object.', 400, 'INVALID_BODY');
        if (hasOwn(changes, 'id')) throw new DatabaseError('The "id" field cannot be changed.', 422, 'VALIDATION_ERROR');

        return this.#withLock(`${name}:${id}`, async () => {
            if (!collection.records.has(id)) throw new DatabaseError('Record not found.', 404, 'NOT_FOUND');
            const previous = await this.#readRecord(collection, id);
            const merged = replace ? changes : { ...previous, ...changes };
            delete merged.id;
            const candidate = this.#normalize(collection, merged, replace);
            candidate.id = id;
            await this.#atomicWrite(this.#recordPath(collection, id), candidate);
            this.#unindexRecord(collection, previous);
            this.#indexRecord(collection, candidate);
            return structuredClone(candidate);
        });
    }

    async delete(name, id) {
        const collection = this.#collection(name);
        this.#validateId(id);
        return this.#withLock(`${name}:${id}`, async () => {
            if (!collection.records.has(id)) throw new DatabaseError('Record not found.', 404, 'NOT_FOUND');
            const previous = await this.#readRecord(collection, id);
            await fs.unlink(this.#recordPath(collection, id));
            collection.records.delete(id);
            this.#unindexRecord(collection, previous);
        });
    }

    #collection(name) {
        this.#assertInitialized();
        if (typeof name !== 'string' || !COLLECTION_NAME.test(name)) {
            throw new DatabaseError('Invalid collection name.', 400, 'INVALID_COLLECTION');
        }
        const collection = this.#collections.get(name);
        if (!collection) throw new DatabaseError(`Unknown collection "${name}".`, 404, 'COLLECTION_NOT_FOUND');
        return collection;
    }

    #assertInitialized() {
        if (!this.#initialized) throw new DatabaseError('File database is not initialized.', 503, 'DATABASE_NOT_READY');
    }

    #validateId(id) {
        if (typeof id !== 'string' || !UUID.test(id)) throw new DatabaseError('"id" must be a UUID.', 400, 'INVALID_ID');
    }

    #normalize(collection, input, creating) {
        const output = {};
        for (const field of Object.keys(input)) {
            if (!hasOwn(collection.config.columns, field)) {
                throw new DatabaseError(`Unknown field "${field}".`, 422, 'VALIDATION_ERROR');
            }
        }
        for (const [field, definition] of Object.entries(collection.config.columns)) {
            if (hasOwn(input, field)) output[field] = input[field];
            else if (creating && hasOwn(definition, 'default')) output[field] = structuredClone(definition.default);
            else if (creating && definition.required) throw new DatabaseError(`"${field}" is required.`, 422, 'VALIDATION_ERROR');
            else if (!creating && definition.required) throw new DatabaseError(`"${field}" is required.`, 422, 'VALIDATION_ERROR');
            if (hasOwn(output, field)) validateField(collection.name, field, output[field], definition);
        }
        return output;
    }

    #recordPath(collection, id) {
        return path.join(collection.directory, `${id}.json`);
    }

    async #readRecord(collection, id) {
        try {
            return JSON.parse(await fs.readFile(this.#recordPath(collection, id), 'utf8'));
        } catch (error) {
            if (error.code === 'ENOENT') {
                throw new DatabaseError('Record not found on disk. Restart the server to rebuild its indexes.', 404, 'NOT_FOUND');
            }
            throw new DatabaseError(`Cannot read ${collection.name}/${id}.json: ${error.message}`, 500, 'CORRUPT_RECORD');
        }
    }

    async #atomicWrite(target, record) {
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
            await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
            await fs.rename(temporary, target);
        } catch (error) {
            await fs.rm(temporary, { force: true }).catch(() => {});
            throw error;
        }
    }

    #indexRecord(collection, record) {
        for (const [field, index] of collection.indexes) {
            if (!hasOwn(record, field)) continue;
            const key = valueKey(record[field]);
            if (!index.has(key)) index.set(key, new Set());
            index.get(key).add(record.id);
        }
    }

    #unindexRecord(collection, record) {
        for (const [field, index] of collection.indexes) {
            if (!hasOwn(record, field)) continue;
            const key = valueKey(record[field]);
            const ids = index.get(key);
            ids?.delete(record.id);
            if (ids?.size === 0) index.delete(key);
        }
    }

    async #withLock(key, operation) {
        const previous = this.#locks.get(key) ?? Promise.resolve();
        let release;
        const current = new Promise((resolve) => { release = resolve; });
        this.#locks.set(key, current);
        await previous;
        try {
            return await operation();
        } finally {
            release();
            if (this.#locks.get(key) === current) this.#locks.delete(key);
        }
    }
}
