# Visual Bookmarks StabilityInternational — расширение Chrome

Новая вкладка в стиле референса: **сетка плиток**, поиск с выбором движка, нижняя панель (закрытые вкладки, загрузки, закладки браузера, история), **настройки с вкладками** (оформление / закладки / система), смена **фона** (пресеты Unsplash, свой файл, «фон дня»), демо-панель **Stability**, вход/регистрация через **Crypt-Chain** (`https://crypt-chain.com/browser-extension/login`, фиксированный API без выбора URL пользователем), экспорт/импорт JSON, синхронизация **Crypt-Chain** (при активной сессии) или **Google Drive**.

Данные хранятся в `chrome.storage.local` (ключ `visualBookmarks_state_v2`; старый `v1` при первом запуске мигрируется).

## Установка

1. Откройте `chrome://extensions`.
2. Включите **Режим разработчика**.
3. **Загрузить распакованное расширение** → выберите папку `extension` этого проекта.

## Публикация в Chrome Web Store

1. Разовый взнос разработчика в [Chrome Web Store Developer Program](https://developer.chrome.com/docs/webstore/register) (проверьте актуальные условия на сайте Google).
2. [Developer Dashboard](https://chrome.google.com/webstore/devconsole) → **New item** → загрузите **ZIP** папки `extension` (без лишних файлов вроде `.git`).
3. Заполните описание, скриншоты (1280×800 или 640×400), политику конфиденциальности (обязательно, если есть удалённый API или OAuth).
4. Укажите разрешения и обоснуйте их в форме (доступ к `https://crypt-chain.com` — для входа, регистрации и синхронизации с фиксированным бэкендом).
5. Отправьте на проверку; срок модерации может занять от нескольких часов до нескольких дней.

## Crypt-Chain (вход и синхронизация)

Базовый адрес API зашит в расширении: `https://crypt-chain.com/browser-extension`. Пользовательская страница входа: **`https://crypt-chain.com/browser-extension/login`**. Контракт эндпоинтов (`/auth/login`, `/auth/register`, `/sync/state`) — в **`SERVER_API.md`**. При первом запросе Chrome может запросить доступ к origin Crypt-Chain.

Кнопки входа и регистрации на новой вкладке обращаются к этому API; при активной сессии синхронизация идёт на Crypt-Chain. **Google Drive** в этом режиме не используется, чтобы не было двух источников правды.

## Настройка Google OAuth (для синхронизации)

Без OAuth синхронизация Drive недоступна; **расширение полностью работает локально**. Вход в Google настраивается в **Настройки → вкладка «Система»**.

1. Откройте [Google Cloud Console](https://console.cloud.google.com/) и создайте проект (или выберите существующий).
2. Включите API: **Google Drive API** (APIs & Services → Library → Google Drive API → Enable).
3. **APIs & Services → OAuth consent screen**: тип *External*, заполните название приложения, свой email, сохраните.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
5. Тип приложения: **Chrome extension**.
6. Поле **Item ID**: скопируйте **ID расширения** со страницы `chrome://extensions` (у пункта «Visual Bookmarks StabilityInternational»). Это строка из 32 символов.
7. Создайте клиента и скопируйте **Client ID** вида `xxxx.apps.googleusercontent.com`.
8. В файле `manifest.json` замените значение `oauth2.client_id` на ваш Client ID (вместо `REPLACE_WITH_YOUR_...`).
9. Перезагрузите расширение на `chrome://extensions`.

Данные на Drive пишутся в файл `visual-bookmarks-sync.json` в [папке данных приложения](https://developers.google.com/drive/api/guides/appdata) — в обычном интерфейсе Drive он не отображается.

## Разрешения

- `bookmarks`, `history`, `downloads`, `sessions` — списки в модальных окнах по ссылкам внизу страницы и восстановление закрытых вкладок.
- `storage`, `identity` + Drive — локальные данные и облако.
- Опционально `optional_host_permissions` — localhost для разработки.

## Использование

- Плитки: меню «⋯», перетаскивание, счётчик кликов, режимы «иконки» / «скриншоты» (mshots).
- **Настройки**: три вкладки — оформление (тема, фон, сетка, поиск), закладки (лимит, вид, список с добавить/изменить/удалить), система (аккаунт Crypt-Chain, Drive, бэкап, сброс).
- **Экспорт** — снизу или в настройках; **импорт** — в настройках.
- После настройки `client_id` Drive подтягивается при фокусе вкладки; локальные изменения уходят в облако с задержкой ~2,5 с.

При конфликте версий побеждает запись с **большим `updatedAt`** (время последнего изменения набора закладок).

## Структура

```
extension/
  manifest.json
  newtab.html
  newtab.css
  newtab.js
  api-client.js
  background.js
  SERVER_API.md
  icons/
```

## Конфиденциальность

Закладки и настройки хранятся локально в `chrome.storage.local`. При входе в аккаунт Crypt-Chain данные синхронизации уходят **на `https://crypt-chain.com`** (см. `SERVER_API.md`). При использовании только Google — к **Drive API** для одного JSON-файла в `appDataFolder`.
