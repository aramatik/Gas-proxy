# GitHub — инструкции для администратора

Ты получил доступ к инструменту **github_ops**. Он работает через GitHub Contents API и Actions API с переменными сервера (`GITHUB_TOKEN`, `GITHUB_REPO`, `GITHUB_BRANCH`, `GITHUB_PATH_PREFIX`). Токен тебе **не виден** — никогда не выводи его и не ищи через env/printenv.

## Сессия и продолжение
- История `/github` сохраняется между вызовами.
- Если сработал лимит операций — пользователь напишет `/github продолжай` (или новую инструкцию). **Не начинай задачу заново** — продолжай с места остановки.
- `/github clear` сбрасывает сессию (делает пользователь).

## Параметры `github_ops`

| Параметр | Описание |
|----------|----------|
| `action` | См. список ниже |
| `path` | Путь в репозитории (без ведущего `/`) |
| `content` | Текст файла для `put` (UTF-8) |
| `message` | Commit message |
| `branch` | Ветка (по умолчанию из env) |
| `local_path` | Абсолютный путь на сервере `/tmp/...` |
| `sha` | SHA файла для update/delete |
| `workflow_id` / `workflow` | Id или имя файла workflow (`build.yml`) |
| `run_id` | Id workflow run |
| `artifact_id` | Id артефакта Actions |
| `file_name` | Имя файла внутри zip артефакта (например `firmware.bin`) |
| `status` | Фильтр runs: `queued` \| `in_progress` \| `completed` |
| `timeout_sec` | Для `wait_run` (макс. 300) |
| `interval_sec` | Интервал опроса `wait_run` |

## Contents (файлы)

### `status`
Проверка настройки репо/ветки.

### `list` / `get`
Список каталога или содержимое файла (+ `sha`).

### `put`
Создать/обновить файл. Для обновления передай `sha` из `get`. Лимит ~1 МБ. Можно `local_path` вместо `content`.

### `delete`
Удалить файл — нужен актуальный `sha`.

### `download_to_server`
Скачать файл из репо (path) или по `url` в `local_path` / `/tmp`.

### `create_artifact`
Залить локальный файл с сервера в репо (по умолчанию под `GITHUB_PATH_PREFIX` + timestamp).

## Actions (сборка, артефакты)

Нужны права PAT: **Contents**, **Workflows**, **Actions** = Read and write.

### `list_workflows`
Список workflow в репозитории (id, name, path).

### `trigger_workflow`
Запуск `workflow_dispatch`:
```
github_ops({ action: "trigger_workflow", workflow_id: "build-esp32s3.yml", branch: "main" })
```
Ответ 204 = принято. Через несколько секунд появится run.

### `list_runs`
Последние runs (опционально `workflow_id`, `status`, `branch`).

### `wait_run`
Ждать завершения run (опрос на сервере, до `timeout_sec`, по умолчанию 180с):
```
github_ops({ action: "wait_run", run_id: "123456789", timeout_sec: "240", interval_sec: "10" })
```
Если не успел — вызови снова с тем же `run_id`.

### `list_artifacts`
Артефакты run (`run_id`) или последние по репо.

### `download_artifact`
Скачать zip артефакта на сервер, распаковать, по возможности найти `.bin`:
```
github_ops({
  action: "download_artifact",
  artifact_id: "987654",
  file_name: "firmware.bin",
  local_path: "/tmp/artifact.zip"
})
```
В ответе: `zip_path`, `files[]`, `bin_path`. Готовый `bin_path` отправляй через `send_file_to_telegram`.

## Типичный сценарий: ESP32-S3 sketch → .bin → Telegram

1. **Скетч** — `put` в `sketches/esp32s3_test/esp32s3_test.ino` (Serial 115200, blink, heap).
2. **platformio.ini** (если нужен) — рядом со скетчем или в корне.
3. **Workflow** — `put` `.github/workflows/build-esp32s3.yml`:
   - `on: workflow_dispatch` (+ опционально push)
   - job: `ubuntu-latest`, PlatformIO / Arduino CLI
   - board: `esp32-s3-devkitc-1` (или указанный пользователем)
   - `actions/upload-artifact` с `firmware.bin`
4. `list_workflows` → убедиться, что файл на месте.
5. `trigger_workflow` с `workflow_id: "build-esp32s3.yml"`.
6. `list_runs` → взять свежий `run_id`.
7. `wait_run` с этим `run_id` (при необходимости повторить).
8. Если `conclusion != success` — `get` логи не через Contents; сообщи URL run пользователю и остановись.
9. `list_artifacts` по `run_id` → `artifact_id`.
10. `download_artifact` + `file_name` → получить `bin_path`.
11. `send_file_to_telegram` с `file_path: bin_path`.

Не пытайся компилировать ESP32 **локально** на этом сервере (0.2 CPU / 512 MB) — только GitHub Actions.

## Правила
1. Не выводи токен, Authorization, `git remote -v`, `env`.
2. Перед update/delete — `get`/`list` для `sha`.
3. Для длинных сборок используй `wait_run`, не крути `exec_command` + `sleep` без нужды.
4. При лимите операций пользователь продолжит через `/github продолжай` — опирайся на историю.
5. В финале укажи: пути в репо, URL run, `bin_path` на сервере, факт отправки в Telegram.
