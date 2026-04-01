# API сервиса Crypt-Chain для расширения

Расширение обращается к **фиксированному базовому URL**:

`https://crypt-chain.com/browser-extension`

Страница входа и регистрации для пользователя: `https://crypt-chain.com/browser-extension/login`.

Все пути ниже **дописываются** к базовому URL.

### Обёртка ответа (Laravel / `BrowserExtensionController`)

Сервер может отдавать JSON в виде:

```json
{
  "status": true,
  "data": { }
}
```

- При **`status: false`** расширение показывает ошибку; текст берётся из `message`, из `data` (строка), либо из `data.message`.
- При **`status: true`** полезная нагрузка читается из **`data`** (если это объект). Для входа и регистрации внутри **`data`** должны быть **токен** и данные пользователя (см. ниже).

Без обёртки допустим прежний «плоский» JSON (токен и `user` в корне).

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

**Ответ 200 (JSON)** — в корне или внутри `data` при обёртке `{ "status": true, "data": { ... } }`:

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

Допустимы поля `token` или `access_token` вместо `accessToken`. Если передан только `email` (и т.п.) без токена, расширение не сможет сохранить сессию и вызвать `/sync/state` — **токен обязателен** для синхронизации.

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

**Ответ:** как у регистрации (`accessToken` + `user` в корне или в `data` при `status: true`).

---

## 3. Загрузить состояние синхронизации

`GET /sync/state`

**Заголовок:** `Authorization: Bearer <accessToken>`

**Ответ 200:** объект состояния (или обёртка `{ "status": true, "data": { ... } }` с тем же объектом внутри `data`).

```json
{
  "updatedAt": 1730000000000,
  "bookmarks": [],
  "settings": {}
}
```

Формат `bookmarks` / `settings` совпадает с экспортом расширения (см. JSON в «Сохранить в файл»), без поля `user`. В элементах `bookmarks` **нет** `faviconDataUrl` — иконки подтягиваются по `url` на клиенте (service worker), в БД не дублируются.

**Фон (`settings.background`):** встроенные картинки в формате `data:` (загрузка своего файла) в экспорт и в тело синхронизации **не попадают** — клиент подставляет пресет по умолчанию; сервер Crypt-Chain при `PUT` дополнительно отбрасывает такие значения и не хранит их в БД. Обычные пресеты (URL картинок) и цвета передаются как раньше.

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
