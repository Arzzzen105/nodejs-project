# 🗂️ Node JS Project

A repository for _Node JS_ team labs

## 👥 Team

| Роль                 | Ім'я та Прізвище |
| :------------------- | :--------------- |
| **Team Lead**        | Богдана Тимощук  |
| **Business Analyst** | Данііл Тюренко   |
| **QA**               | Василь Гавриляк  |
| **Developer**        | Адам Смеречук    |
| **Developer**        | Арсен Сметаняк   |
| **Developer**        | Владислав Риндер |
| **Developer**        | Олег Тендюк      |
| **Developer**        | Марк Ткачук      |

_Date:_ `06-10-2026`

### 🧑‍💻 Usernames

| Ім'я та прізвище | GitHub                                                  |
| :--------------- | :------------------------------------------------------ |
| Арсен Сметаняк   | [Arzzzen105](https://github.com/Arzzzen105)             |
| Олег Тендюк      | [ZpsOleg](https://github.com/ZpsOleg)                   |
| Владислав Риндер | [vladyslav-rynder](https://github.com/vladyslav-rynder) |
| Богдана Тимощук  | [dana-tim](https://github.com/dana-tim)                 |
| Василь Гавриляк  | [vasiahavryliak](https://github.com/vasiahavryliak)     |
| Даніїл Тюренко   | [h3ely](https://github.com/daniilturenko778-cyber)      |
| Адам Смеречук    | [elw1ng](https://github.com/elw1ng)                     |
| Марк Ткачук      | [Mark Tkachuk](https://github.com/pFudixD)              |

## 🛠️ Розробка

```bash
npm install
npm run dev    # сервер з автоперезапуском на тимчасовій базі
npm test       # тести
npm start      # сервер на справжній базі database/
```

`npm run dev` щоразу стартує з **порожньої** бази: схеми колекцій (`database/*/config.json`) копіюються в `.dev-db/`, сервер працює на цій копії, а після зупинки (Ctrl+C) вона видаляється. Справжня `database/` при цьому не змінюється.

- Дані переживають автоперезапуск після збереження файлу, але не перезапуск `npm run dev`.
- Зміни в `database/*/config.json` підхоплюються лише після перезапуску `npm run dev`.
- Якщо сесію вбили жорстко і `.dev-db/` лишилась, наступний `npm run dev` її прибере.

### Історія Тімлідерства

- **06.10.2026 – 13.10.2026:** [Арсен Сметаняк](https://github.com/Arzzzen105)
- **З 13.10.2026:** [Данііл Тюренко](https://github.com/daniilturenko778-cyber)
- **З 21.10.2026:** [Адам Смеречук](https://github.com/elw1ng)
- **З 28.10.2026:** [Богдана Тимощук](https://github.com/dana-tim)

### Що було зроблено за 13-21 Жовтня

Покращіли ініціалізацію сервера
М'яке виключення сервера
Зробили рушій для бази даних на файлах
Прибрали бізнес вимоги
Створили тестові ендпоінти для тестування з різних сутностей
