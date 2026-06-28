# Используем легковесный образ Node.js 20
FROM node:20-alpine

# Устанавливаем системную утилиту zip для создания многотомных архивов
RUN apk add --no-cache zip

# Создаем директорию приложения
WORKDIR /usr/src/app

# Копируем package.json и устанавливаем зависимости
COPY package*.json ./
RUN npm install --production

# Копируем исходный код
COPY . .

# Порт, который будет слушать контейнер
EXPOSE 8080

# Команда для запуска
CMD [ "npm", "start" ]
