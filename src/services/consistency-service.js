/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/base-repository.js').BaseRepository} BaseRepository
 */

/**
 * Problems the diagnostics find (FR-019), by the entity they are about. Each
 * one is a state that writes allow on purpose: rules are checked on the side
 * that joins (a kid joining a group), and what breaks later through a change
 * elsewhere is found here.
 */
export const PROBLEMS = Object.freeze({
    kids: [
        // FR-019
        'KID_WITHOUT_GROUP',
        // BR-11: a kid has a mother and a father
        'KID_INCOMPLETE_PARENTS',
        // BR-02, after the age of the group changed
        'KID_GROUP_AGE_MISMATCH',
    ],
    groups: [
        // FR-019
        'GROUP_WITHOUT_EDUCATOR',
        'GROUP_WITHOUT_ASSISTANT',
        'GROUP_WITHOUT_ROOM',
        // BR-08, after a group with kids lost its room, educator or assistant
        'GROUP_NOT_READY_WITH_KIDS',
    ],
    // FR-019
    educators: ['EDUCATOR_WITHOUT_GROUP'],
    assistants: ['ASSISTANT_WITHOUT_GROUP'],
});

/**
 * Diagnostics of the data (FR-019): which records break the rules of the
 * kindergarten, and how. Read only. The collections are read whole in one
 * transaction, so the answers agree: there are at most 15 groups (BR-19) and
 * 20 kids in each (BR-03).
 */
export class ConsistencyService {
    #uow;
    #kids;
    #groups;
    #rooms;
    #educators;
    #assistants;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {BaseRepository} dependencies.kids
     * @param {BaseRepository} dependencies.groups
     * @param {BaseRepository} dependencies.rooms
     * @param {BaseRepository} dependencies.educators
     * @param {BaseRepository} dependencies.assistants
     */
    constructor({ uow, kids, groups, rooms, educators, assistants }) {
        this.#uow = uow;
        this.#kids = kids;
        this.#groups = groups;
        this.#rooms = rooms;
        this.#educators = educators;
        this.#assistants = assistants;
    }

    /**
     * Every problem that has at least one record, with how many records and
     * where to find them. Records themselves are not included, so the answer
     * does not grow with the data.
     * @returns {Promise<{ problems: Array<{ code: string, entity: string, count: number, href: string }> }>}
     */
    async summary() {
        return this.#uow.run(async () => {
            const problems = [];
            for (const entity of Object.keys(PROBLEMS)) {
                const found = await this.#diagnose(entity);
                for (const code of PROBLEMS[entity]) {
                    const count = found.filter((item) =>
                        item.problems.includes(code)
                    ).length;
                    if (count > 0) {
                        problems.push({
                            code,
                            entity,
                            count,
                            href: `/api/consistency/${entity}?problem=${code}`,
                        });
                    }
                }
            }
            return { problems };
        });
    }

    /**
     * A page of the records of an entity that have problems, each with the
     * list of its problems, in the order of creation.
     * @param {keyof PROBLEMS} entity
     * @param {object} [query]
     * @param {string} [query.problem] Only records with this problem
     * @param {number} [query.limit=100]
     * @param {number} [query.offset=0]
     * @returns {Promise<{ items: object[], total: number, limit: number, offset: number }>}
     */
    async list(entity, { problem, limit = 100, offset = 0 } = {}) {
        return this.#uow.run(async () => {
            const found = (await this.#diagnose(entity)).filter(
                (item) => !problem || item.problems.includes(problem)
            );
            return {
                items: found.slice(offset, offset + limit),
                total: found.length,
                limit,
                offset,
            };
        });
    }

    /**
     * @param {keyof PROBLEMS} entity
     * @returns {Promise<object[]>} Records with at least one problem, each
     *   with its `problems`
     */
    async #diagnose(entity) {
        const checks = {
            kids: () => this.#diagnoseKids(),
            groups: () => this.#diagnoseGroups(),
            educators: () =>
                this.#diagnoseWorkers(
                    this.#educators,
                    'educatorId',
                    'EDUCATOR_WITHOUT_GROUP'
                ),
            assistants: () =>
                this.#diagnoseWorkers(
                    this.#assistants,
                    'assistantId',
                    'ASSISTANT_WITHOUT_GROUP'
                ),
        };
        return (await checks[entity]()).filter(
            (item) => item.problems.length > 0
        );
    }

    async #diagnoseKids() {
        const ages = new Map(
            (await this.#groups.findEvery()).map((group) => [
                group.id,
                group.age,
            ])
        );
        return (await this.#kids.findEvery()).map((kid) =>
            withProblems(kid, {
                KID_WITHOUT_GROUP: !kid.groupId,
                KID_INCOMPLETE_PARENTS: !kid.motherId || !kid.fatherId,
                KID_GROUP_AGE_MISMATCH:
                    ages.has(kid.groupId) && ages.get(kid.groupId) !== kid.age,
            })
        );
    }

    async #diagnoseGroups() {
        const withRoom = new Set(
            (await this.#rooms.findEvery()).map((room) => room.groupId)
        );
        const withKids = new Set(
            (await this.#kids.findEvery()).map((kid) => kid.groupId)
        );
        return (await this.#groups.findEvery()).map((group) => {
            const missing = {
                GROUP_WITHOUT_EDUCATOR: !group.educatorId,
                GROUP_WITHOUT_ASSISTANT: !group.assistantId,
                GROUP_WITHOUT_ROOM: !withRoom.has(group.id),
            };
            return withProblems(group, {
                ...missing,
                GROUP_NOT_READY_WITH_KIDS:
                    withKids.has(group.id) &&
                    Object.values(missing).some(Boolean),
            });
        });
    }

    /**
     * @param {BaseRepository} workers Educators or assistants
     * @param {string} field Their reference in groups
     * @param {string} code
     */
    async #diagnoseWorkers(workers, field, code) {
        const assigned = new Set(
            (await this.#groups.findEvery()).map((group) => group[field])
        );
        return (await workers.findEvery()).map((worker) =>
            withProblems(worker, { [code]: !assigned.has(worker.id) })
        );
    }
}

/**
 * @param {object} record
 * @param {Record<string, boolean>} checks Whether the record has each problem
 * @returns {object} The record with the codes of its problems
 */
function withProblems(record, checks) {
    return {
        ...record,
        problems: Object.keys(checks).filter((code) => checks[code]),
    };
}
