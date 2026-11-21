import { createReadyGroup } from './ready-group.js';

/**
 * The kindergarten of the requirements in the database (FR-005): the six
 * subjects, a teacher for each, the gym shared by physical education and
 * wrestling (BR-18), a room for each other subject, and ready groups of ages
 * 2–5 in turn. The first group has a kid who needs speech lessons (FR-021).
 * Everything goes through the repositories, past the rules of the services.
 * @param {object} repositories `container.repositories`
 * @param {object} [options]
 * @param {number} [options.groups=4]
 * @returns {Promise<{ subjects: object, teachers: object, rooms: object, groups: object[] }>}
 *   Subjects, teachers and rooms by short name: pe, wrestling, music,
 *   english, chess, speech; rooms also gym
 */
export async function seedKindergarten(repositories, { groups = 4 } = {}) {
    const names = {
        wrestling: 'Wrestling',
        pe: 'Physical education',
        music: 'Music',
        english: 'English',
        chess: 'Chess',
        speech: 'Speech therapist',
    };
    const subjects = {};
    const teachers = {};
    for (const [key, name] of Object.entries(names)) {
        subjects[key] = await repositories.subjects.create({
            name,
            speechLessons: key === 'speech',
        });
        teachers[key] = await repositories.teachers.create({
            firstName: 'Teacher',
            lastName: name,
            subjectIds: [subjects[key].id],
        });
    }
    const rooms = {
        gym: await repositories.rooms.create({
            name: 'Gym',
            subjectIds: [subjects.pe.id, subjects.wrestling.id],
        }),
    };
    for (const key of ['music', 'english', 'chess', 'speech']) {
        rooms[key] = await repositories.rooms.create({
            name: `${names[key]} room`,
            subjectIds: [subjects[key].id],
        });
    }
    const created = [];
    for (let i = 0; i < groups; i++) {
        created.push(
            await createReadyGroup(repositories, { age: 2 + (i % 4) })
        );
    }
    if (created.length > 0) {
        await repositories.kids.create({
            firstName: 'Marko',
            lastName: 'Koval',
            age: created[0].age,
            sex: 'MALE',
            groupId: created[0].id,
            needsSpeechLessons: true,
        });
    }
    return { subjects, teachers, rooms, groups: created };
}
