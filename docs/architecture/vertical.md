# Вертикаль: від HTTP-запиту до бази

Цей документ для тих, хто ще не працював із шаровою архітектурою. Прочитайте його першим, а за деталями кожного шару переходьте сюди:

- [controllers.md](controllers.md) — рутери, валідація, контролери;
- [services.md](services.md) — сервіси й бізнес-правила;
- [repositories.md](repositories.md) — репозиторії й транзакції;
- [file-database.md](file-database.md) — сама база.

## 1. Що таке вертикаль

Код застосунку поділено на **шари**. Кожен шар робить один вид роботи: один розбирається з HTTP, інший перевіряє бізнес-правила, ще інший читає й пише дані.

**Вертикаль** — це всі шари однієї сутності, зверху донизу. Наприклад, вертикаль дітей складається з таких файлів:

```
                     ВЕРТИКАЛЬ ДІТЕЙ

  клієнт (браузер, Postman)
     │  PATCH /api/kids/0190...  { "groupId": "..." }
     ▼
  ┌────────────┐
  │ Рутер      │  src/routes/kid-routes.js
  ├────────────┤
  │ Схеми      │  src/validators/kid-schemas.js
  ├────────────┤
  │ Контролер  │  src/controllers/kid-controller.js
  ├────────────┤
  │ Сервіс     │  src/services/kid-service.js
  ├────────────┤
  │ Репозиторій│  src/repositories/kid-repository.js
  └────────────┘
     │
     ▼
  база даних (колекція, описана в database/kids/config.json)
```

Запит іде згори вниз, а відповідь повертається знизу вгору.

Головне правило: **шар викликає лише сусідній шар під собою**. Контролер не звертається до репозиторія напряму, а сервіс нічого не знає про HTTP.

### Навіщо це потрібно

Той самий CRUD можна написати в одному файлі, і спершу це навіть швидше. Проблеми починаються, коли застосунок росте:

- **Зміна лишається в одному місці.** Правило «у групі не більше 20 дітей» лежить лише в сервісі. Якщо ліміт зміниться, правити треба один рядок, а не шукати його по всіх маршрутах.
- **Правило не можна обійти.** Усі, хто записує дитину, проходять через сервіс. Якщо пізніше з'явиться масове додавання дітей, воно використає ті самі перевірки.
- **Код легше тестувати.** Бізнес-правила можна перевірити викликом методу, без HTTP-запитів.
- **Команда не заважає одне одному.** Кожен працює у файлах своєї сутності.

## 2. За що відповідає кожен шар

Кожен шар відповідає на одне запитання:

| Шар         | На яке запитання відповідає                                      |
| ----------- | ---------------------------------------------------------------- |
| Рутер       | Який код запустити для цього методу й адреси?                    |
| Схема       | Чи запит правильно сформований? (без звернення до бази)          |
| Контролер   | Як перекласти запит на виклик сервісу, а результат на HTTP?      |
| Сервіс      | Чи дозволяють бізнес-правила цю дію?                             |
| Репозиторій | Як дістати чи записати ці дані?                                  |
| База        | Чи дані відповідають схемі й зв'язкам, і як їх надійно зберегти? |

### Рутер

Лише зв'язує адресу, перевірку й метод контролера. Логіки в ньому немає.

```js
router.patch(
    '/:id',
    validate({ params: idParams, body: updateKid }),
    controller.update
);
```

### Схема (валідація)

Описує, як має виглядати запит: які поля є, якого вони типу, які межі. **Схема не ходить у базу**, вона бачить лише сам запит. Тому питання «чи існує така група» або «чи є в ній місце» — не для неї.

```js
export const updateKid = createKid.partial();
```

Такий опис даних, що приходять від клієнта, ще називають **DTO** (Data Transfer Object).

Перевіряє запит middleware `validate`. Він виконується до контролера: якщо дані неправильні, контролер не запускається, а клієнт отримує список помилок. **Middleware** — це функція, через яку запит проходить на шляху до обробника.

### Контролер

Перекладач між HTTP і сервісом: бере перевірені дані, викликає сервіс, вибирає статус відповіді. Зазвичай метод займає кілька рядків. Бізнес-правил тут немає.

```js
update = async (request, response) => {
    const { params, body } = request.validated;
    response.json(await this.#kids.update(params.id, body));
};
```

### Сервіс

Серце застосунку. Тут живуть бізнес-правила з [requirements.md](../business/requirements.md) і сценарії, що зачіпають кілька сутностей. Сервіс нічого не знає про `request` і `response`: на вхід отримує дані, на вихід дає запис або кидає помилку.

Якщо метод робить кілька операцій, він загортає їх у **транзакцію** (`uow.run`). Транзакція — це група операцій, які виконуються разом або не виконуються взагалі. Якщо всередині виникла помилка, база лишається такою, якою була до початку.

### Репозиторій

Єдине місце, яке працює з даними колекції. Базові операції (`findById`, `getById`, `findPage`, `create`, `update`, `replace`, `delete`) успадковуються від `BaseRepository`. Сюди додаються лише іменовані запити, потрібні сервісу:

```js
async countByGroup(groupId) {
    const page = await this.findPage({ where: { groupId }, limit: 1 });
    return page.total;
}
```

Правил тут немає: репозиторій не вирішує, чи дозволена дія, а просто виконує її.

### База

Останній захист. Вона перевіряє схему з `database/<сутність>/config.json`, унікальність полів і існування пов'язаних записів, а також зберігає дані на диск. Сервіс можна викликати не лише через HTTP, тому база не покладається на те, що хтось перевірив дані до неї.

### Що зв'язує шари

- **Контейнер** ([container.js](../../src/container.js)). Тут створюються всі класи й передаються одне одному через конструктор. Самі класи нічого не створюють, а отримують готове. Це називається **впровадженням залежностей** (dependency injection), і саме воно дає змогу в тестах зібрати застосунок над тимчасовою базою.
- **Обробник помилок** ([app.js](../../src/app.js)). Будь-який шар може кинути помилку, і вона долетить сюди. Обробник бере з неї `status` і `code` і формує відповідь. Тому в контролерах немає `try/catch`.

## 3. Повний цикл: переведення дитини в групу

**Сценарій.** Менеджер переводить дитину в групу «Сонечко». Вимоги кажуть: у групі мають бути діти одного віку (BR-02), і не більше 20 (BR-03).

Клієнт надсилає такий запит:

```http
PATCH /api/kids/01a18ee5-1f84-7142-9a5e-7fac525620cd
Content-Type: application/json

{ "groupId": "01a18ee6-2a11-7c3d-8e21-5fbd63a1c9f0" }
```

### Шлях запиту вниз

**1. Рутер** знаходить маршрут `PATCH /api/kids/:id` і передає запит у ланцюжок `validate` → `controller.update`.

**2. Схема.** `validate` перевіряє частини запиту по черзі:

- `params` за схемою `idParams`: чи `id` — це UUIDv7;
- `body` за схемою `updateKid`: чи `groupId` — це UUIDv7 і чи немає зайвих полів.

Усе гаразд, тому перевірені дані кладуться в `request.validated`.

**3. Контролер** дістає дані й викликає сервіс. Про групи й вік він нічого не знає:

```js
const { params, body } = request.validated;
response.json(await this.#kids.update(params.id, body));
```

**4. Сервіс** відкриває транзакцію, читає поточну дитину й перевіряє правила для запису **після** зміни:

```js
async update(id, changes) {
    return this.#uow.run(async () => {
        const current = await this.#kids.getById(id);
        await this.#assertRules(current, { ...current, ...changes });
        return this.#kids.update(id, changes);
    });
}
```

У запиті є лише `groupId`, а вік треба звіряти теж, тому зміни накладаються на поточний запис. Оскільки дитина приходить у нову групу, сервіс викликає перевірку групи:

```js
if (group.age !== kid.age) {
    throw new HttpError(
        StatusCodes.UNPROCESSABLE_ENTITY,
        'GROUP_AGE_MISMATCH',
        `The kid must be ${group.age} years old to be in this group.`
    );
}
if ((await this.#kids.countByGroup(group.id)) >= MAX_GROUP_SIZE) {
    throw new HttpError(
        StatusCodes.CONFLICT,
        'GROUP_FULL',
        `The group already has ${MAX_GROUP_SIZE} kids.`
    );
}
```

Завдяки транзакції ніхто не займе останнє місце між перевіркою й записом.

**5. Репозиторій** виконує операції, які просить сервіс: `getById` у `KidRepository`, `findById` у `GroupRepository`, `countByGroup` і `update` у `KidRepository`. Він не вирішує, чи дозволена дія.

**6. База** перевіряє новий запис за схемою і чи існує група, а коли транзакція завершується, зберігає зміни на диск.

### Шлях відповіді вгору

**7. Сервіс** повертає оновлений запис контролеру. **Контролер** віддає його як JSON зі статусом 200:

```json
{
    "id": "01a18ee5-1f84-7142-9a5e-7fac525620cd",
    "firstName": "Марко",
    "lastName": "Коваль",
    "age": 3,
    "sex": "MALE",
    "needsSpeechLessons": false,
    "groupId": "01a18ee6-2a11-7c3d-8e21-5fbd63a1c9f0",
    "discountId": null,
    "motherId": null,
    "fatherId": null,
    "createdAt": "2026-10-31T10:15:00.000Z",
    "updatedAt": "2026-10-31T10:20:00.000Z"
}
```

### Якщо щось пішло не так

Запит зупиняється на тому шарі, який першим виявив проблему. Нижчі шари тоді не виконуються.

| Що не так                   | Хто виявив                 | Відповідь                 |
| --------------------------- | -------------------------- | ------------------------- |
| Зламаний JSON у тілі        | `express.json`             | 400 `INVALID_JSON`        |
| `id` в адресі не UUIDv7     | Схема                      | 400 `INVALID_ID`          |
| `groupId` не UUIDv7         | Схема                      | 422 `VALIDATION_ERROR`    |
| Невідоме поле в тілі        | Схема                      | 422 `VALIDATION_ERROR`    |
| Такої дитини немає          | Сервіс (через репозиторій) | 404 `NOT_FOUND`           |
| Група іншого віку           | Сервіс                     | 422 `GROUP_AGE_MISMATCH`  |
| У групі вже 20 дітей        | Сервіс                     | 409 `GROUP_FULL`          |
| Групи з таким `id` не існує | База                       | 422 `REFERENCE_NOT_FOUND` |
| Несподівана помилка в коді  | Будь-хто                   | 500 `INTERNAL_ERROR`      |

Усі помилки клієнт отримує в одному форматі:

```json
{
    "error": {
        "code": "GROUP_FULL",
        "message": "The group already has 20 kids."
    }
}
```

Коли сервіс кидає `GROUP_FULL`, транзакція відкочується, і дитина лишається у старій групі. Писати для цього окремий код не треба.

## 4. Як зробити вертикаль для своєї сутності

Розберемо групи, з одним правилом: **садок приймає не більше 15 груп (BR-19)**. Це навчальний приклад. Той, хто братиме групи, може почати з нього й додати решту правил.

**Працюйте знизу вгору**, бо кожен шар використовує той, що під ним. Спершу подивіться в `database/<сутність>/config.json`, які поля має сутність, і в [requirements.md](../business/requirements.md), які для неї є правила.

Файли репозиторія й сервісу вже є: це шаблони, які лише передають виклики далі. Їх треба доповнити, а решту створити.

### Крок 1. Репозиторій

Додайте іменований запит, якщо сервісу він потрібен. Для ліміту потрібно знати кількість груп:

```js
// src/repositories/group-repository.js
import { BaseRepository } from './base-repository.js';

/**
 * Groups (collection "groups"). Named queries are added here as
 * services need them.
 */
export class GroupRepository extends BaseRepository {
    /**
     * @param {import('./unit-of-work.js').UnitOfWork} uow
     */
    constructor(uow) {
        super(uow, 'groups');
    }

    /**
     * How many groups there are, without reading them.
     * @returns {Promise<number>}
     */
    async count() {
        const page = await this.findPage({ limit: 1 });
        return page.total;
    }
}
```

`limit: 1` тут не обмежує підрахунок: `total` завжди показує кількість усіх записів, а `limit` стосується лише того, скільки їх завантажити в `items`.

### Крок 2. Сервіс

Додайте правила. `create` робить дві операції (порахувати й записати), тому загорнутий у транзакцію. Методи без правил просто передають виклик далі:

```js
// src/services/group-service.js
import { StatusCodes } from 'http-status-codes';
import { HttpError } from '../http-error.js';

/**
 * Most groups the kindergarten can take (BR-19).
 */
export const MAX_GROUPS = 15;

/**
 * Use cases for groups.
 */
export class GroupService {
    #uow;
    #groups;

    /**
     * @param {object} dependencies
     * @param {import('../repositories/unit-of-work.js').UnitOfWork} dependencies.uow
     * @param {import('../repositories/group-repository.js').GroupRepository} dependencies.groups
     */
    constructor({ uow, groups }) {
        this.#uow = uow;
        this.#groups = groups;
    }

    /** @see BaseRepository#findPage */
    async list(query) {
        return this.#groups.findPage(query);
    }

    /** @see BaseRepository#getById */
    async get(id) {
        return this.#groups.getById(id);
    }

    /**
     * @see BaseRepository#create
     * @throws {HttpError} 409 GROUP_LIMIT_REACHED
     */
    async create(data) {
        return this.#uow.run(async () => {
            if ((await this.#groups.count()) >= MAX_GROUPS) {
                throw new HttpError(
                    StatusCodes.CONFLICT,
                    'GROUP_LIMIT_REACHED',
                    `The kindergarten already has ${MAX_GROUPS} groups.`
                );
            }
            return this.#groups.create(data);
        });
    }

    /** @see BaseRepository#replace */
    async replace(id, data) {
        return this.#groups.replace(id, data);
    }

    /** @see BaseRepository#update */
    async update(id, changes) {
        return this.#groups.update(id, changes);
    }

    /** @see BaseRepository#delete */
    async delete(id) {
        return this.#groups.delete(id);
    }
}
```

Перевіряти унікальність назви (BR-07) не треба: база вже зробить це за схемою й відповість `409 UNIQUE_VIOLATION`. Перш ніж писати правило, подивіться, чи воно вже не задане в `config.json`.

Тепер сервісу потрібен `uow`, тому змініть реєстрацію в [container.js](../../src/container.js):

```js
groups: new GroupService({ uow, groups: repositories.groups }),
```

### Крок 3. Схеми

Перепишіть правила полів із `database/groups/config.json`. Використовуйте `z.strictObject` і не додавайте `.default()`: чому саме, пояснено в [controllers.md](controllers.md).

```js
// src/validators/group-schemas.js
import { z } from 'zod';

/**
 * Body of POST and PUT /api/groups. Keep the rules in step with
 * database/groups/config.json.
 */
export const createGroup = z.strictObject({
    name: z.string().min(1).max(100),
    age: z.int().min(2).max(5),
    educatorId: z.uuidv7().nullable().optional(),
    assistantId: z.uuidv7().nullable().optional(),
});

/**
 * Body of PATCH /api/groups/:id: the same fields, each of them optional.
 */
export const updateGroup = createGroup.partial();
```

### Крок 4. Контролер

Контролери всіх сутностей майже однакові:

```js
// src/controllers/group-controller.js
import { StatusCodes } from 'http-status-codes';

/**
 * HTTP side of groups: takes what `validate` checked, calls the service and
 * chooses the status.
 *
 * Handlers are arrow functions, so they keep `this` when passed to a router.
 */
export class GroupController {
    #groups;

    /**
     * @param {object} dependencies
     * @param {import('../services/group-service.js').GroupService} dependencies.groups
     */
    constructor({ groups }) {
        this.#groups = groups;
    }

    list = async (request, response) => {
        response.json(await this.#groups.list(request.validated.query));
    };

    create = async (request, response) => {
        const group = await this.#groups.create(request.validated.body);
        response
            .location(`${request.baseUrl}/${group.id}`)
            .status(StatusCodes.CREATED)
            .json(group);
    };

    get = async (request, response) => {
        response.json(await this.#groups.get(request.validated.params.id));
    };

    replace = async (request, response) => {
        const { params, body } = request.validated;
        response.json(await this.#groups.replace(params.id, body));
    };

    update = async (request, response) => {
        const { params, body } = request.validated;
        response.json(await this.#groups.update(params.id, body));
    };

    delete = async (request, response) => {
        await this.#groups.delete(request.validated.params.id);
        response.status(StatusCodes.NO_CONTENT).end();
    };
}
```

### Крок 5. Рутер

```js
// src/routes/group-routes.js
import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { createGroup, updateGroup } from '../validators/group-schemas.js';
import { idParams } from '../validators/id-params.js';
import { listQuery } from '../validators/list-query.js';

/**
 * Routes of /api/groups.
 * @param {import('../controllers/group-controller.js').GroupController} controller
 * @returns {import('express').Router}
 */
export function createGroupRouter(controller) {
    const router = Router();

    router.get('/', validate({ query: listQuery }), controller.list);
    router.post('/', validate({ body: createGroup }), controller.create);
    router.get('/:id', validate({ params: idParams }), controller.get);
    router.put(
        '/:id',
        validate({ params: idParams, body: createGroup }),
        controller.replace
    );
    router.patch(
        '/:id',
        validate({ params: idParams, body: updateGroup }),
        controller.update
    );
    router.delete('/:id', validate({ params: idParams }), controller.delete);

    return router;
}
```

### Крок 6. Підключення

Зареєструйте контролер у `controllers` у [container.js](../../src/container.js) (не забудьте імпорт):

```js
const controllers = Object.freeze({
    groups: new GroupController({ groups: services.groups }),
    kids: new KidController({ kids: services.kids }),
});
```

Підключіть рутер у `createApp` в [app.js](../../src/app.js), поруч із рутером дітей:

```js
app.use('/api/groups', createGroupRouter(container.controllers.groups));
```

### Крок 7. Тести

Перевірте через HTTP, що маршрути працюють і що правило спрацьовує. Бази вручну створювати не треба: `createTestApp()` дає кожному тесту власну чисту базу.

```js
// tests/http/groups.test.js
import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import request from 'supertest';
import { MAX_GROUPS } from '../../src/services/group-service.js';
import { createTestApp } from '../helpers/test-app.js';

describe('/api/groups', () => {
    let app;
    let container;
    let close;

    beforeEach(async () => {
        ({ app, container, close } = await createTestApp());
    });

    afterEach(async () => close());

    test('creates a group', async () => {
        const response = await request(app)
            .post('/api/groups')
            .send({ name: 'Сонечко', age: 3 })
            .expect(201);

        expect(response.headers.location).toBe(
            `/api/groups/${response.body.id}`
        );
    });

    test('rejects a group over the limit (BR-19)', async () => {
        // ARRANGE: through the repository, past the rule
        for (let i = 0; i < MAX_GROUPS; i++) {
            await container.repositories.groups.create({
                name: `Group ${i}`,
                age: 3,
            });
        }

        // ACT
        const response = await request(app)
            .post('/api/groups')
            .send({ name: 'Зайва', age: 3 })
            .expect(409);

        // ASSERT
        expect(response.body.error.code).toBe('GROUP_LIMIT_REACHED');
    });

    test('lists every invalid field at once', async () => {
        const response = await request(app)
            .post('/api/groups')
            .send({ name: '', age: 99 })
            .expect(422);

        expect(
            response.body.error.details.map(({ field }) => field).sort()
        ).toEqual(['age', 'name']);
    });

    test('rejects a name that is already taken (BR-07)', async () => {
        const body = { name: 'Сонечко', age: 3 };
        await request(app).post('/api/groups').send(body).expect(201);

        const response = await request(app)
            .post('/api/groups')
            .send(body)
            .expect(409);

        expect(response.body.error.code).toBe('UNIQUE_VIOLATION');
    });

    test('rejects a malformed id', async () => {
        const response = await request(app).get('/api/groups/abc').expect(400);

        expect(response.body.error.code).toBe('INVALID_ID');
    });
});
```

Запустіть перевірки:

```bash
npm test
npm run lint
```

Повніші приклади: [kids.test.js](../../tests/http/kids.test.js), [kid-service.test.js](../../tests/services/kid-service.test.js), [kid-schemas.test.js](../../tests/validators/kid-schemas.test.js).

## 5. Куди писати цей код?

| Що потрібно зробити                          | Куди                  |
| -------------------------------------------- | --------------------- |
| Новий маршрут                                | Рутер                 |
| Поле обов'язкове, має межі, має бути UUID    | Схема і `config.json` |
| Вибрати статус відповіді, задати заголовок   | Контролер             |
| Правило, для якого треба прочитати базу      | Сервіс                |
| Дія над кількома записами чи сутностями      | Сервіс, в `uow.run`   |
| Запит на кшталт «знайти дітей групи»         | Репозиторій           |
| Унікальність поля, зв'язок з іншою колекцією | `config.json`         |

Якщо сумніваєтесь: чи зміниться цей код, коли замість HTTP буде щось інше, наприклад командний рядок? Якщо так, це контролер або рутер. Якщо ні, це сервіс.

### Типові помилки

| Помилка                                               | Що не так і як правильно                                                                              |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Контролер викликає репозиторій напряму                | Сервіс обходиться разом із правилами. Завжди йдіть через сервіс, навіть якщо він лише передає виклик. |
| `if (kid.age > 5)` у контролері                       | Це правило поля, йому місце в схемі.                                                                  |
| Перевірка місткості групи в схемі                     | Схема не бачить базу. Це правило сервісу.                                                             |
| Сервіс приймає `request` або викликає `response.json` | Сервіс не повинен знати про HTTP. Передавайте дані, повертайте результат.                             |
| `throw new Error('Group is full')`                    | Клієнт отримає 500. Кидайте `HttpError` зі статусом і кодом.                                          |
| Перевірка й запис без `uow.run`                       | Два одночасні запити можуть обидва пройти перевірку. Загортайте їх у транзакцію.                      |
| `.default(false)` у схемі                             | `PATCH` затре наявне значення. Значення за замовчуванням заповнює база.                               |
| `new KidService(...)` усередині іншого класу          | Створювати класи можна лише в контейнері. Клас отримує залежності через конструктор.                  |

## 6. Чекліст вертикалі

- [ ] Прочитано вимоги до сутності й `database/<сутність>/config.json`
- [ ] Репозиторій: додано потрібні іменовані запити
- [ ] Сервіс: додано бізнес-правила, кілька операцій загорнуто в `uow.run`, помилки — `HttpError`
- [ ] Схеми: `create` і `update`, строгі, без `.default()`
- [ ] Контролер: дані беруться лише з `request.validated`
- [ ] Рутер: кожен маршрут із `:id` перевіряє `idParams`
- [ ] Сервіс і контролер зареєстровані в контейнері, рутер підключений у `createApp`
- [ ] Тести: кожне правило, кожен маршрут, неправильні дані
- [ ] `npm test` і `npm run lint` проходять
