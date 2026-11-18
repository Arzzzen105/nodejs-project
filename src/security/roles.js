/**
 * Roles of user accounts (EPIC-03). The assistant of an educator has no
 * account: they do not use the system.
 */
export const ROLES = Object.freeze({
    ADMIN: 'ADMIN',
    MANAGER: 'MANAGER',
    EDUCATOR: 'EDUCATOR',
    TEACHER: 'TEACHER',
    PARENT: 'PARENT',
});

/**
 * The field of an account that links it to the person it belongs to, by
 * role. The admin and the manager are not people of any collection, so their
 * accounts link to no one.
 */
export const PERSON_FIELD = Object.freeze({
    ADMIN: null,
    MANAGER: null,
    EDUCATOR: 'educatorId',
    TEACHER: 'teacherId',
    PARENT: 'parentId',
});

/** Every field that links an account to a person. */
export const PERSON_FIELDS = Object.freeze(
    Object.values(PERSON_FIELD).filter(Boolean)
);

/**
 * Roles that run the kindergarten: the admin and the manager. Until a route
 * says otherwise, only they use it; the others see only their own records.
 */
export const MANAGEMENT = Object.freeze([ROLES.ADMIN, ROLES.MANAGER]);
