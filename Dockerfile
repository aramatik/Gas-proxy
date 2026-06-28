# Используем Node.js 20 (не alpine, чтобы избежать проблем с компиляцией нативных модулей)
FROM node:20

# Устанавливаем необходимые системные зависимости
RUN apt-get update && apt-get install -y --no-cache zip python3 make g++

WORKDIR /usr/src/app

# Копируем package.json
COPY package*.json ./

# Устанавливаем ВСЕ зависимости (не только production)
# Это необходимо для компиляции нативных модулей SDK
RUN npm install

# Копируем исходный код
COPY . .

EXPOSE 8080

CMD [ "npm", "start" ]
