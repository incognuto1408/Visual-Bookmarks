# API вашего сервера для расширения

Расширение обращается к **базовому URL**, который пользователь вводит в **Настройки → Система** (например `https://api.mycompany.com` или `https://mycompany.com/api/v1`).

Все пути ниже **дописываются** к этому URL.

## CORS и HTTPS

- Ответы должны включать заголовки CORS для запросов с origin `chrome-extension://<id>` или используйте `Access-Control-Allow-Origin: *` с осторожностью для продакшена.
- Методы: `POST`, `GET`, `PUT`, `OPTIONS` (preflight).

## 1. Регистрация

`POST /auth/register`

**Тело (JSON):**

```json
{
  "email": "user@example.com",
  "password": "secret",
  "name": "Имя"
}
```

**Ответ 200 (JSON):**

```json
{
  "accessToken": "jwt...",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "name": "Имя",
    "avatar": "https://... (необязательно)"
  }
}
```

Допустимы поля `token` или `access_token` вместо `accessToken`.

**Ошибки:** `4xx/5xx` с телом `{ "message": "Текст для пользователя" }` (желательно).

---

## 2. Вход

`POST /auth/login`

**Тело:**

```json
{
  "email": "user@example.com",
  "password": "secret"
}
```

**Ответ:** как у регистрации (`accessToken` + `user`).

---

## 3. Загрузить состояние синхронизации

`GET /sync/state`

**Заголовок:** `Authorization: Bearer <accessToken>`

**Ответ 200:**

```json
{
  "updatedAt": 1730000000000,
  "bookmarks": [],
  "settings": {}
}
```

Формат `bookmarks` / `settings` совпадает с экспортом расширения (см. JSON в «Сохранить в файл»), без поля `user`.

**Пустое состояние:** `404` или `204` без тела — клиент создаст данные локально и при следующем сохранении отправит `PUT`.

**401:** токен недействителен — клиент сбросит сессию.

---

## 4. Сохранить состояние

`PUT /sync/state`

**Заголовок:** `Authorization: Bearer <accessToken>`

**Тело:**

```json
{
  "version": 2,
  "updatedAt": 1730000000001,
  "bookmarks": [],
  "settings": {}
}
```

**Ответ:** `200` с `{ "ok": true }` или пустое тело.

---

## Логика конфликтов (на клиенте)

Сравнивается `updatedAt` (миллисекунды):

- если на сервере **новее** — локальные закладки и настройки заменяются ответом сервера;
- если **локально новее** — клиент отправляет `PUT` с локальным состоянием.

При активной сессии сервера **Google Drive** в расширении не используется (чтобы не дублировать источники правды).

---

## Пример (Node.js + Express, упрощённо)

```javascript
const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json());

const users = new Map(); // email -> { passwordHash, data }
const JWT_SECRET = process.env.JWT_SECRET;

app.post('/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  // проверки, хеш пароля, запись в БД
  const token = jwt.sign({ sub: email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ accessToken: token, user: { id: email, email, name } });
});

app.post('/auth/login', async (req, res) => {
  // проверка пароля
  const token = jwt.sign({ sub: req.body.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ accessToken: token, user: { id: req.body.email, email: req.body.email } });
});

app.get('/sync/state', authMiddleware, (req, res) => {
  const row = loadFromDb(req.userId);
  if (!row) return res.status(404).end();
  res.json(row.payload);
});

app.put('/sync/state', authMiddleware, (req, res) => {
  saveToDb(req.userId, req.body);
  res.json({ ok: true });
});
```

Реальную БД, хеширование паролей (`bcrypt`) и проверку JWT нужно добавить отдельно.
