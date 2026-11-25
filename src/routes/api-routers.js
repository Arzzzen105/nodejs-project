import { createAuthRouter } from './auth-routes.js';
import { createUserRouter } from './user-routes.js';
import { createFinanceRouter } from './finance-routes.js';
import { createInvoiceRouter } from './invoice-routes.js';
import { createPaymentRouter } from './payment-routes.js';
import { createChangeRouter } from './change-routes.js';
import { createScheduleRouter } from './schedule-routes.js';
import { createKidRouter } from './kid-routes.js';
import { createNoteRouter } from './note-routes.js';
import { createEducatorRouter } from './educator-routes.js';
import { createAssistantRouter } from './assistant-routes.js';
import { createParentRouter } from './parent-routes.js';
import { createGroupRouter } from './group-routes.js';
import { createSubjectRouter } from './subject-routes.js';
import { createDiscountRouter } from './discount-routes.js';
import { createTeacherRouter } from './teacher-routes.js';
import { createRoomRouter } from './room-routes.js';
import { createConsistencyRouter } from './consistency-routes.js';

/**
 * @typedef {object} ApiRouter
 * @property {string} path Where it is mounted, e.g. `/api/kids`
 * @property {import('express').Router} router
 * @property {boolean} [open] Mounted before `authenticate`: its routes need no
 *   token unless they ask for one themselves
 */

/**
 * Every router of the API, in the order they are mounted. One table for the
 * application, which mounts them, and for the API reference (src/openapi),
 * which describes their routes: a router mounted here is documented, or the
 * tests of the reference fail.
 * @param {object} controllers `container.controllers`
 * @param {import('express').RequestHandler} authenticate For the routes of
 *   an open router that need a token (GET /api/auth/me)
 * @returns {ApiRouter[]}
 */
export function createApiRouters(controllers, authenticate) {
    return [
        {
            path: '/api/auth',
            router: createAuthRouter(controllers.auth, authenticate),
            open: true,
        },
        { path: '/api/users', router: createUserRouter(controllers.users) },
        {
            path: '/api/finance',
            router: createFinanceRouter(controllers.finance),
        },
        {
            path: '/api/invoices',
            router: createInvoiceRouter(controllers.invoices),
        },
        {
            path: '/api/payments',
            router: createPaymentRouter(controllers.payments),
        },
        {
            path: '/api/changes',
            router: createChangeRouter(controllers.changes),
        },
        {
            path: '/api/schedules',
            router: createScheduleRouter(controllers.schedules),
        },
        { path: '/api/kids', router: createKidRouter(controllers.kids) },
        {
            path: '/api/kids/:kidId/notes',
            router: createNoteRouter(controllers.notes),
        },
        {
            path: '/api/educators',
            router: createEducatorRouter(controllers.educators),
        },
        {
            path: '/api/assistants',
            router: createAssistantRouter(controllers.assistants),
        },
        {
            path: '/api/parents',
            router: createParentRouter(controllers.parents),
        },
        { path: '/api/groups', router: createGroupRouter(controllers.groups) },
        {
            path: '/api/subjects',
            router: createSubjectRouter(controllers.subjects),
        },
        {
            path: '/api/discounts',
            router: createDiscountRouter(controllers.discounts),
        },
        {
            path: '/api/teachers',
            router: createTeacherRouter(controllers.teachers),
        },
        { path: '/api/rooms', router: createRoomRouter(controllers.rooms) },
        {
            path: '/api/consistency',
            router: createConsistencyRouter(controllers.consistency),
        },
    ];
}
