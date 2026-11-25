# Контролери, рутери й валідація

HTTP-шар вертикалі складається з трьох частин. Запит проходить їх у такому порядку:

```
authenticate → рутер → authorize(ролі) → validate(схеми Zod) → контролер → сервіс → репозиторій → база
```

`authenticate` ([authenticate.js](../../src/middleware/authenticate.js)) підключений один раз для всього `/api`, крім входу. Він пропускає запит лише з дійсним токеном і кладе акаунт у `request.user`. Рутерам і контролерам нічого для цього робити не треба.

- **Рутер** прив'язує шляхи до схем і методів контролера.
- **`validate`** перевіряє запит. Кривий запит далі не йде.
- **Контролер** бере перевірені дані, викликає сервіс і вибирає статус відповіді. Бізнес-правил у ньому немає, вони в сервісі ([services.md](services.md)).

Зразок — вертикаль дітей: [kid-schemas.js](../../src/validators/kid-schemas.js), [kid-controller.js](../../src/controllers/kid-controller.js), [kid-routes.js](../../src/routes/kid-routes.js) і тести [kids.test.js](../../tests/http/kids.test.js), [kid-schemas.test.js](../../tests/validators/kid-schemas.test.js).

## 1. Як додати HTTP-шар

Вертикаль — це весь шлях від рутера до репозиторія. Спершу потрібні репозиторій ([repositories.md](repositories.md)) і сервіс ([services.md](services.md)), а далі:

1. **Схеми** в `src/validators/<сутність>-schemas.js`:

    ```js
    export const createGroup = z.strictObject({
        name: z.string().min(1).max(100),
        age: z.int().min(2).max(5),
        educatorId: z.uuidv7().nullable().optional(),
    });
    export const updateGroup = createGroup.partial();
    ```

2. **Контролер** у `src/controllers/<сутність>-controller.js`. Він отримує сервіс через конструктор і зберігає його в приватному полі. Методи — стрілкові поля класу (див. розділ 2).

3. **Рутер** у `src/routes/<сутність>-routes.js`. Схеми `idParams` і `listQuery` вже є й спільні для всіх сутностей. Кожен маршрут каже, яким ролям він доступний, через `authorize` ([authorize.js](../../src/middleware/authorize.js)). Він стоїть перед `validate`, тож роль без доступу отримує `403 FORBIDDEN`, нічого не дізнавшись про тіло запиту:

    ```js
    router.use(authorize(...MANAGEMENT)); // дід і менеджер
    router.post(
        '/',
        authorize(ROLES.ADMIN),
        validate({ body: createDiscount }),
        controller.create
    );
    ```

    Чи запис «свій» (дитина батьків, група вихователя), перевіряє сервіс: для цього треба читати базу.

4. **Реєстрація.** Контролер додається в `controllers` у [container.js](../../src/container.js), рутер — у таблицю [api-routers.js](../../src/routes/api-routers.js), з якої його монтує `createApp`:

    ```js
    { path: '/api/groups', router: createGroupRouter(controllers.groups) },
    ```

    Рутер, змонтований в обхід таблиці, не потрапить у довідник API, і тест [openapi.test.js](../../tests/app/openapi.test.js) це помітить.

5. **Довідник API** (розділ 6). Кожен новий маршрут отримує опис у [src/openapi/operations/](../../src/openapi/operations/): назву, опис, форму відповіді й свої бізнес-помилки. Без опису падає тест.

6. **Тести**, як описано в розділі 4.

## 2. Домовленості

### Контролер

- **Дані беруться лише з `request.validated`**, а не з `request.body` чи `request.query`. Там лежить те, що пройшло схему: `limit` уже число, а `where` уже об'єкт.
- **Методи — стрілкові поля класу:** `list = async (request, response) => { ... }`. Вони передаються в рутер без виклику (`controller.list`), і звичайний метод втратив би `this`.
- **Без `try/catch` і `asyncHandler`.** Express 5 сам передає відхилений проміс в обробник помилок у `app.js`.
- **Статуси:**

| Запит    | Успіх            |
| -------- | ---------------- |
| `GET`    | 200              |
| `POST`   | 201 + `Location` |
| `PUT`    | 200              |
| `PATCH`  | 200              |
| `DELETE` | 204 без тіла     |

### Схеми

- **`z.strictObject`.** Невідоме поле, а також `id`, `createdAt` чи `updatedAt` дають помилку, а не тихо відкидаються.
- **Ніякого `.default()`.** `.partial()` його зберігає, тож `PATCH` підставив би значення за замовчуванням і затер наявне. Значення за замовчуванням заповнює база.
- **Необов'язкові поля — `.optional()`**, а поля, що можуть бути `null`, — ще й `.nullable()`, як у схемі бази.
- **Посилання — `z.uuidv7()`:** `motherId: z.uuidv7().nullable().optional()`. Формат перевіряє схема, а існування запису — база, вона відповідає `422 REFERENCE_NOT_FOUND`. Порядок важливий: `.nullable()` і `.optional()` пишуться після формату, бо методів формату в них уже немає.
- **Те, чого немає в базі, у схему не додаємо.** Схема повторює правила `database/<сутність>/config.json`. Бізнес-правила, для яких треба читати базу, живуть у сервісі.

### Відповіді `validate`

Частини запиту перевіряються по черзі, перша помилкова завершує запит:

| Порядок | Частина  | Відповідь              |
| ------- | -------- | ---------------------- |
| 1       | `params` | 400 `INVALID_ID`       |
| 2       | `query`  | 400 `INVALID_QUERY`    |
| 3       | `body`   | 422 `VALIDATION_ERROR` |

У полі `details` є список усіх помилок цієї частини:

```json
{
    "error": {
        "code": "VALIDATION_ERROR",
        "message": "The request body is invalid.",
        "details": [
            { "field": "age", "message": "Too big: expected number to be <=5" },
            { "field": "foo", "message": "Unknown field." }
        ]
    }
}
```

### Вкладені шляхи

Пов'язані записи читаються через шлях запису, з яким вони пов'язані: `GET /api/groups/:id/kids`, `GET /api/educators/:id/group`. Такі шляхи лише читають. Змінюється запис через свою канонічну адресу (`PATCH /api/kids/:id`). Виняток — нотатки: вони існують лише з дитиною, тож увесь їхній CRUD живе під `/api/kids/:kidId/notes`.

- **Маршрут лежить у рутері запису зі шляху**, а метод — у його сервісі (`GroupService.listKids`), який читає через репозиторій пов'язаної сутності (`KidRepository.findPageByGroup`).
- **Неіснуючий запис зі шляху дає 404.** Сервіс перевіряє його в тій самій транзакції, що й читає пов'язані.
- **Списки приймають ті самі `where`, `sort`, `limit` і `offset`**, що й звичайні. Умова зв'язку замінює однойменне поле в `where` клієнта (`BaseRepository#findPageWhere`), тож рядок запиту не може вийти за межі зв'язку.
- **Один пов'язаний запис** (`/groups/:id/room`) повертається як є, а якщо його немає, тіло відповіді — `null` зі статусом 200.

## 3. Чому правила є і в схемі, і в базі

База — останній захист: сервіс можна викликати не лише через HTTP, і вона мусить перевіряти дані сама. Але вона повідомляє лише про першу помилку. Схема потрібна для того, щоб клієнт бачив усі помилки одразу й отримував типізований query.

Тож правила на кшталт `age: 2–5` записані двічі. Щоб вони не розійшлися, тест порівнює схему з базою (розділ 4). Якщо змінюєте `config.json`, змініть і схему.

Якщо в маршруті забули `idParams`, нічого не зламається: база відповість тим самим `400 INVALID_ID`.

## 4. Тести

- **`tests/http/<сутність>.test.js`** через `supertest` над `createTestApp()` ([test-app.js](../../tests/helpers/test-app.js)): кожен маршрут і статус, помилки валідації, бізнес-помилки сервісу, неправильний id. Самі бізнес-правила докладно перевіряють тести сервісу.
- **`tests/validators/<сутність>-schemas.test.js`:** назви полів схеми збігаються зі стовпцями `config.json`, а на граничних значеннях схема й база дають однаковий результат.

## 5. `/api/test`

Загальний рутер над усіма колекціями ([resources.js](../../src/routes/resources.js)) потрібен для ручної перевірки. Він звертається до бази напряму й обходить бізнес-правила сервісів, тому при `NODE_ENV=production` не підключається.

## 6. Довідник API (NFR-08)

`GET /api/docs` — Swagger UI, `GET /api/openapi.json` — документ OpenAPI 3.1. Обидва відкриті без токена. Документ будується з самих маршрутів ([src/openapi/](../../src/openapi/)), тож не може розійтися з кодом:

| Що в довіднику                                    | Звідки                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| шляхи й методи                                    | рутери з [api-routers.js](../../src/routes/api-routers.js)                            |
| ролі                                              | `authorize` маршруту й `router.use(authorize(...))` рутера                            |
| параметри шляху, query, тіло                      | схеми Zod з `validate` (`z.toJSONSchema`)                                             |
| записи у відповідях (`Kid`, `Group`, …)           | `database/<колекція>/config.json`, без прихованих полів (`passwordHash`)              |
| `400`, `401`, `403`, `404`, `422` кожної операції | додаються самі: за тим, чи є в маршруту `params`, `query`, `body`, ролі               |
| назва, опис, форма відповіді, бізнес-помилки      | вручну: [src/openapi/operations/](../../src/openapi/operations/), ключ `METHOD /path` |

Опис операції:

```js
'POST /api/invoices': {
    summary: 'Invoice a kid for a month',
    description: 'Issues what the kid owes for the month (FR-014)…',
    response: { description: 'The new invoices.', schema: items('invoices') },
    errors: [[409, 'INVOICE_EXISTS', 'The kid is invoiced for the month.']],
},
```

`status` задає успішний статус, якщо він не звичайний (`200` для `POST`, що нічого не створює). Помічники `record`, `page`, `items`, `object` — у [schemas.js](../../src/openapi/schemas.js).

Тести:

- [openapi.test.js](../../tests/app/openapi.test.js): кожен маршрут описаний і кожен опис — маршруту; ролі, тіла й параметри документа — ті, що перевіряє код.
- [openapi-responses.test.js](../../tests/app/openapi-responses.test.js): на садку з `npm run seed` кожна GET-операція та основні записи відповідають схемою, яку довідник дає для їхнього статусу (перевіряє `ajv`).
