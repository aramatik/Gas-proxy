# Используем легковесный образ Node.js 20
FROM node:20-alpine

# Устанавливаем системную утилиту zip, python3 и pip
RUN apk add --no-cache zip node-cron python3 py3-pip

# Устанавливаем временные инструменты сборки, необходимые для компиляции крипто-библиотек Python
RUN apk add --no-cache --virtual .build-deps gcc musl-dev libffi-dev python3-dev

# Создаем директорию приложения
WORKDIR /usr/src/app

# Копируем package.json и устанавливаем Node.js зависимости
COPY package*.json ./
RUN npm install --production

# Устанавливаем необходимые Python библиотеки через pip
RUN pip install --no-cache-dir --break-system-packages \
    requests \
    base58 \
    coincurve \
    pycryptodome

# Удаляем инструменты сборки после компиляции Python-пакетов, оставляя только рантайм
RUN apk del .build-deps

# Копируем исходный код
COPY . .

# Порт, который будет слушать контейнер
EXPOSE 8080

# Команда для запуска
CMD [ "npm", "start" ]
