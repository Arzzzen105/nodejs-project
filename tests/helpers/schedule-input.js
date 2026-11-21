/**
 * Input of the timetable generator like the kindergarten of the requirements
 * (FR-005): the six subjects, a teacher for each, the gym shared by physical
 * education and wrestling (BR-18), a room for each other subject.
 * @param {object} [options]
 * @param {number} [options.groups=15] Groups, ages 2–5 in turn; every third
 *   one attends speech lessons
 * @param {number} [options.load=2] Lessons a week of every subject, every age
 * @param {number} [options.lessonSlots=2] Length of a lesson in slots
 */
export function scheduleInput({ groups = 15, load = 2, lessonSlots = 2 } = {}) {
    const loads = {
        lessonsPerWeekAge2: load,
        lessonsPerWeekAge3: load,
        lessonsPerWeekAge4: load,
        lessonsPerWeekAge5: load,
    };
    const subject = (id, name, extra = {}) => ({
        id,
        name,
        ...loads,
        ...extra,
    });
    const subjects = [
        subject('wrestling', 'Wrestling'),
        subject('pe', 'Physical education'),
        subject('music', 'Music'),
        subject('english', 'English'),
        subject('chess', 'Chess'),
        subject('speech', 'Speech therapist', { speechLessons: true }),
    ];
    return {
        groups: Array.from({ length: groups }, (_, i) => ({
            id: `g${String(i).padStart(2, '0')}`,
            name: `Group ${i}`,
            age: 2 + (i % 4),
            attendsSpeechLessons: i % 3 === 0,
        })),
        subjects,
        teachers: subjects.map((s) => ({
            id: `t-${s.id}`,
            firstName: 'Teacher',
            lastName: s.name,
            subjectIds: [s.id],
        })),
        rooms: [
            {
                id: 'gym',
                name: 'Gym',
                groupId: null,
                subjectIds: ['wrestling', 'pe'],
            },
            {
                id: 'music-room',
                name: 'Music room',
                groupId: null,
                subjectIds: ['music'],
            },
            {
                id: 'english-room',
                name: 'English room',
                groupId: null,
                subjectIds: ['english'],
            },
            {
                id: 'chess-room',
                name: 'Chess room',
                groupId: null,
                subjectIds: ['chess'],
            },
            {
                id: 'speech-room',
                name: 'Speech room',
                groupId: null,
                subjectIds: ['speech'],
            },
        ],
        lessonSlots,
    };
}
