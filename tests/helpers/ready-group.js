let counter = 0;

/**
 * A group that kids can join (BR-08): it has a room, an educator and an
 * assistant. Everything is created through the repositories, past the rules
 * of the services. Names are numbered, so a test can create several.
 * @param {object} repositories `container.repositories`
 * @param {object} [fields] Fields of the group, e.g. `{ age: 4 }`
 * @returns {Promise<object>} The group; its room is `rooms.findByGroup(group.id)`
 * @example
 * const group = await createReadyGroup(repositories, { age: 4 });
 * await request(app).post('/api/kids').send({ ...kid, age: 4, groupId: group.id });
 */
export async function createReadyGroup(repositories, fields = {}) {
    const n = ++counter;
    const educator = await repositories.educators.create({
        firstName: 'Ганна',
        lastName: 'Мельник',
    });
    const assistant = await repositories.assistants.create({
        firstName: 'Оксана',
        lastName: 'Бойко',
    });
    const group = await repositories.groups.create({
        name: `Група ${n}`,
        age: 3,
        educatorId: educator.id,
        assistantId: assistant.id,
        ...fields,
    });
    await repositories.rooms.create({
        name: `Кімната ${n}`,
        groupId: group.id,
    });
    return group;
}
