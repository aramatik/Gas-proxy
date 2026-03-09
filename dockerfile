# Используем легковесный образ Node.js
FROM node:18-alpine

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
  
